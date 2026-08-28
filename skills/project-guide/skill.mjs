// 项目面试讲解指南技能：基于真实源码生成 7 段结构化指南（工单 docs/project-guide功能工单.md）
// 两个动态工具（skill__project_guide__* 命名空间，不改核心工具注册表）：
//   read_project_file：白名单项目目录内读源码（路径穿越防护 + 50KB 上限）——多轮反馈用
//   generate_project_guide：编排（档案 + 关键文件 → LLM 7 段 → 存档 output/project-guides/）
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { llmChat, getReplyText } from "../../lib/llm.mjs";
import { sanitizeExternal } from "../../lib/prompt-guard.mjs";
import { getPersonalProjects, buildProjectArchive } from "../../lib/personal-projects.mjs";

export const name = "project-guide";
export const description = "项目面试讲解指南生成（基于真实源码的 7 段结构化指南）";

// ---------- 上下文参数（v2：可调——对话内"读详细一点"→ 提高对应参数重新生成） ----------
const MAX_FILE_BYTES = 50 * 1024; // 50KB 上限（防单文件灌爆上下文；mode 不绕过）
const MAX_CONTENT_CHARS = 8000; // full 模式内容截断
const HEAD_LINES = 200; // head 模式前 N 行（"读详细一点"→ 500）
const MATERIAL_LIMIT = 12000; // 档案材料上限
const GUIDE_DIR = path.join(import.meta.dirname, "..", "..", "output", "project-guides");

/** 项目白名单匹配（personal_projects 配置；dir 必须存在） */
function matchProject(project) {
  const name = String(project || "").trim();
  if (!name) return null;
  const list = getPersonalProjects();
  return list.find((p) => p.name === name || p.name.includes(name) || name.includes(p.name)) || null;
}

/** 路径安全：resolve 后必须在项目目录内（防 ../ 穿越；复用 read_tool_result 防护模式） */
function safeResolve(projDir, file) {
  const root = path.resolve(projDir);
  const target = path.resolve(root, String(file || ""));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** 读项目内文件（白名单 + 穿越防护 + 大小限制；v2：mode 三档 head/export/full）
 * 导出供测试直测（工具层经 callSkillTool 走同一实现） */
export async function readProjectFile(project, file, mode = "head", opts = {}) {
  const headLines = opts.headLines || HEAD_LINES;
  const proj = matchProject(project);
  if (!proj) return { ok: false, error: `项目「${project}」不在个人项目配置中（设置中心「🎯 简历项目源码」配置 项目名=目录）` };
  const target = safeResolve(proj.dir, file);
  if (!target) return { ok: false, error: `拒绝读取：文件必须在项目目录内（收到 ${file}）` };
  if (!existsSync(target)) return { ok: false, error: `文件不存在: ${file}` };
  let st;
  try { st = statSync(target); } catch { return { ok: false, error: `读取失败: ${file}` }; }
  if (!st.isFile()) return { ok: false, error: `不是文件: ${file}` };
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, error: `文件过大（${(st.size / 1024).toFixed(0)}KB > 50KB 上限），建议读目录/摘要或换关键文件` };
  }
  const content = readFileSync(target, "utf8");
  const lines = content.split("\n");
  let out;
  let truncated;
  if (mode === "export") {
    // 导出/函数签名清单（+ 行号）——"先看目录再看章节"
    const sigs = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*(export\s+)?(async\s+)?function\s+\w+/.test(l) ||
          /^\s*export\s+(const|let|class)\s+\w+/.test(l) ||
          /^\s*class\s+\w+/.test(l) ||
          /^\s*export\s*\{/.test(l)) {
        sigs.push(`${i + 1}: ${l.trim().slice(0, 100)}`);
      }
    }
    out = sigs.join("\n").slice(0, MAX_CONTENT_CHARS);
    truncated = sigs.join("\n").length > MAX_CONTENT_CHARS;
  } else if (mode === "full") {
    out = content.slice(0, MAX_CONTENT_CHARS);
    truncated = content.length > MAX_CONTENT_CHARS;
  } else { // head：前 N 行（文件定位/头部注释/核心结构）
    out = lines.slice(0, headLines).join("\n");
    truncated = lines.length > headLines;
  }
  return {
    ok: true,
    file: path.relative(proj.dir, target),
    mode,
    lines: lines.length,
    bytes: st.size,
    content: out,
    truncated,
  };
}

// ---------- 7 段指南模板（生成 prompt 骨架；只基于档案+真实源码，不许编） ----------
const GUIDE_TEMPLATE = `请基于【项目档案】与【真实源码摘录】生成一份**项目面试讲解指南**（Markdown），严格 7 段：

## 1. 一句话定位
30 秒开场版：这个项目是什么、解决什么问题、你的角色（基于 README/档案，不夸大）

## 2. 技术选型理由表
表格：技术/框架 | 为什么选它（基于真实 package.json/代码）| 备选与不选理由（如档案/代码有依据才写，没有写"未在源码中体现"）

## 3. 架构地图
模块/目录 → 一句话职责（基于真实结构树；只列档案/源码里存在的）

## 4. 核心亮点 3-5 个
每个亮点：**30 秒话术**（怎么讲）+ **面试官可能追问**（2-3 个）+ **参考答案要点**（基于真实代码实现）

## 5. 面试官问题清单 10-15 个
按深度分级：基础（项目背景）/ 深挖（实现细节）/ 边界（异常与权衡）

## 6. 追问防御
每个亮点的坑/边界/诚实交代点（源码里暴露的局限、TODO、简化实现——诚实优先）

## 7. 简历 bullet 建议
3-5 条量化表达（基于真实数据/代码规模；没有数字不编造，用"实现/设计/优化"等可验证表述）

**铁律**：档案和源码里没有的内容一律不写（技术栈/功能/数字都不许编造）；不确定的标注"（未在源码中确认）"。`;

export const tools = [
  {
    name: "read_project_file",
    description:
      "读取已配置个人项目目录内的源码文件（路径白名单防穿越 + 50KB 上限）。mode 三档：head（前 200 行，默认）/ export（导出与函数签名清单+行号）/ full（全文，8000 字符截断）。返回带 truncated 标记（读到的内容是否被截断）。用于生成讲解指南时按需读关键文件、以及用户反馈后读对应源码修正。",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（personal_projects 配置中的 name）" },
        file: { type: "string", description: "项目内相对路径，如 package.json / src/main.mjs" },
        mode: { type: "string", enum: ["head", "export", "full"], description: "读取模式（默认 head）" },
      },
      required: ["project", "file"],
    },
    permission: "auto", // 只读
    async run({ project, file, mode }) {
      return readProjectFile(project, file, mode || "head");
    },
  },
  {
    name: "generate_project_guide",
    description:
      "生成项目面试讲解指南（v2：分层读取 + subagent 并行深读 + 覆盖范围透明）：读项目档案 + 关键源码（head/export 分层）→ subagent 并行摘要核心模块 → 按 7 段模板生成 → 存档 output/project-guides/<项目名>.md，指南末尾标注覆盖范围（完整/部分/未覆盖）。适合用户说'生成 XX 项目的面试讲解指南/我的项目怎么讲'。",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（personal_projects 配置中的 name）" },
        headLines: { type: "number", description: "head 模式读取行数（默认 200；用户说'读详细一点'→ 500）" },
        materialLimit: { type: "number", description: "档案材料上限字符（默认 12000）" },
      },
      required: ["project"],
    },
    permission: "auto", // 只读 + 写 output/project-guides/（与讲解/面经同体系）
    async run({ project, headLines, materialLimit }) {
      const proj = matchProject(project);
      if (!proj) return { ok: false, error: `项目「${project}」不在个人项目配置中（设置中心「🎯 简历项目源码」配置 项目名=目录）` };
      const readOpts = { headLines: Number(headLines) || HEAD_LINES };
      const matLimit = Number(materialLimit) || MATERIAL_LIMIT;
      try {
        // ① 档案（技术栈/结构树/README/核心预览）——直接构建，不依赖知识库索引状态
        const archive = buildProjectArchive(proj);
        const archiveText = archive?.content ? String(archive.content).slice(0, matLimit) : "";
        if (!archiveText) return { ok: false, error: `项目「${proj.name}」档案为空（目录可能已移动）` };
        // ② 关键文件：package.json（技术栈）+ README（定位）——完整读取（小文件）
        const coverage = []; // {file, mode, truncated}
        const keyFiles = [];
        for (const f of ["package.json", "README.md", "readme.md", "README.MD"]) {
          const r = await readProjectFile(proj.name, f, "full", readOpts);
          if (r.ok) {
            keyFiles.push({ file: f, content: r.content.slice(0, 4000) });
            coverage.push({ file: f, mode: "full", truncated: r.truncated });
            break;
          }
        }
        // ③ 挑核心模块 3-5 个（档案结构树里的源码文件，排除 node_modules/test/配置类）
        // 树条目格式 `src/core.mjs`（纯路径行）——通用扩展名匹配（- 转义防范围解析）；
        // 档案里文件可能多次出现（结构树 + 核心预览）——Set 去重
        const treeFiles = [...new Set(String(archive?.content || "").match(/[\w./-]+\.[a-z0-9]+/g) || [])]
          .filter((f) => f && !f.includes("node_modules") && !f.includes("test") && !f.includes("package.json") && !f.includes("README"))
          .slice(0, 5);
        // ④ subagent 并行深读（map-reduce：每个子任务读一个模块 head+export → 结构化摘要）
        const subResults = await Promise.all(treeFiles.map(async (file) => {
          const head = await readProjectFile(proj.name, file, "head", readOpts);
          const exp = await readProjectFile(proj.name, file, "export", readOpts);
          if (!head.ok && !exp.ok) return { file, ok: false, error: head.error || exp.error };
          const truncated = head.truncated || exp.truncated;
          coverage.push({ file, mode: "head+export", truncated });
          const material = [
            head.ok ? `【${file} 头部 ${readOpts.headLines} 行】\n${head.content}` : "",
            exp.ok ? `【${file} 导出/签名清单】\n${exp.content}` : "",
          ].filter(Boolean).join("\n\n");
          // 子任务：基于读到的内容做结构化摘要（不调工具；truncated 状态由主侧传入并上报）
          const { runSubagent } = await import("../../lib/subagent.mjs");
          const r = await runSubagent({
            name: `读模块 ${file}`,
            system: "你是代码阅读助手。基于给定源码摘录提炼模块职责与关键实现。只依据摘录内容，摘录里没有的不许编造。输出 JSON：{\"keyFindings\":[\"...\"],\"truncated\":true/false}（truncated 必须如实反映摘录是否被截断——主侧已注明）。",
            task: `阅读模块 ${file} 的源码摘录，提炼：①模块职责（一句话）②关键实现/设计要点 3-5 条（具体到函数/类/机制）③对外接口（导出名）。\n注意：摘录可能被截断（head 只读前 ${readOpts.headLines} 行 / export 只列签名）——若摘录明显不完整，truncated 必须为 true。`,
            context: material,
          });
          if (!r.ok) return { file, ok: false, error: r.error };
          let parsed = null;
          try { parsed = JSON.parse(r.result); } catch { /* 非 JSON 降级 */ }
          return {
            file,
            ok: true,
            keyFindings: parsed?.keyFindings || [r.result.slice(0, 500)],
            truncated: parsed?.truncated === true || truncated, // 子任务上报 + 主侧兜底（诚实优先）
          };
        }));
        // ⑤ 主汇总：子任务摘要 + 档案 → LLM 7 段（注入各模块 truncated 状态 → "部分覆盖"标注）
        const subSummary = subResults.map((s) => {
          if (!s.ok) return `- ${s.file}：读取失败（${s.error}）——未覆盖`;
          return `- ${s.file}：${(s.keyFindings || []).join("；")}${s.truncated ? "（⚠️ 部分覆盖：摘录被截断）" : ""}`;
        }).join("\n");
        const material = sanitizeExternal(
          `【项目档案】\n${archiveText}\n\n【关键文件】\n${keyFiles.map((k) => `--- ${k.file} ---\n${k.content}`).join("\n")}\n\n【核心模块并行摘要】\n${subSummary}`
        ).wrapped;
        const data = await llmChat(
          [
            { role: "system", content: "你是资深前端面试辅导。严格依据给定材料生成指南，材料里没有的不许编造。输出 Markdown。" },
            { role: "user", content: `${GUIDE_TEMPLATE}\n\n【材料】\n${material}` },
          ],
          { maxTokens: 4000, temperature: 0.3, role: "project-guide" }
        );
        let guide = getReplyText(data).trim();
        if (guide.length < 200) return { ok: false, error: "指南生成失败（LLM 返回过短）" };
        // ⑥ 覆盖范围段（诚实标注：完整/部分/未覆盖三档）
        const fullFiles = coverage.filter((c) => !c.truncated).map((c) => c.file);
        const partialFiles = coverage.filter((c) => c.truncated).map((c) => `${c.file}（${c.mode}${c.truncated ? "，截断" : ""}）`);
        const uncovered = subResults.filter((s) => !s.ok).map((s) => s.file);
        const coverageSection = `## 覆盖范围\n- 完整读取：${fullFiles.length ? fullFiles.join(" / ") : "（无）"}\n- 部分覆盖（head+export，未读全文）：${partialFiles.length ? partialFiles.join(" / ") : "（无）"}\n- 未覆盖：${uncovered.length ? uncovered.join(" / ") + "（可让我继续读）" : "（无）"}`;
        guide = `${guide}\n\n${coverageSection}`;
        // ⑦ 存档 output/project-guides/<项目名>.md（文件名清洗防路径注入）
        const safeName = String(proj.name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
        mkdirSync(GUIDE_DIR, { recursive: true });
        const outPath = path.join(GUIDE_DIR, `${safeName}.md`);
        writeFileSync(outPath, `# ${proj.name} 面试讲解指南\n\n> 生成时间：${new Date().toLocaleString("zh-CN")}\n> 来源：项目档案 + 真实源码（分层读取，subagent 并行摘要）\n\n${guide}\n`, "utf8");
        // ⑧ 返回摘要（7 段标题 + coverage）
        const sections = [...guide.matchAll(/^##\s+\d+\.\s+(.+)$/gm)].map((m) => m[1].trim());
        return {
          ok: true,
          project: proj.name,
          path: outPath,
          sections,
          coverage: { files: coverage, note: uncovered.length ? `未覆盖 ${uncovered.length} 个模块（可让我继续读）` : "全部核心模块已覆盖" },
          preview: guide.slice(0, 300),
          hint: `指南已存档：${outPath}（覆盖 ${coverage.length} 个文件${partialFiles.length ? `，其中 ${partialFiles.length} 个部分覆盖` : ""}）。可让我读详细一点（提高 headLines）或继续读未覆盖模块。`,
        };
      } catch (e) {
        return { ok: false, error: `指南生成失败: ${String(e?.message || e).slice(0, 150)}` };
      }
    },
  },
];
