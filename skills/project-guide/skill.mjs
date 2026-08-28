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

const MAX_FILE_BYTES = 50 * 1024; // 50KB 上限（防单文件灌爆上下文）
const MAX_CONTENT_CHARS = 8000; // 返回内容截断
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

/** 读项目内文件（白名单 + 穿越防护 + 大小限制） */
async function readProjectFile(project, file) {
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
  return {
    ok: true,
    file: path.relative(proj.dir, target),
    lines: content.split("\n").length,
    bytes: st.size,
    content: content.slice(0, MAX_CONTENT_CHARS),
    truncated: content.length > MAX_CONTENT_CHARS,
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
      "读取已配置个人项目目录内的源码文件（路径白名单防穿越 + 50KB 上限）。用于生成讲解指南时按需读关键文件、以及用户反馈后读对应源码修正。入参 project 为项目名（设置中心「🎯 简历项目源码」配置），file 为项目内相对路径。",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（personal_projects 配置中的 name）" },
        file: { type: "string", description: "项目内相对路径，如 package.json / src/main.mjs" },
      },
      required: ["project", "file"],
    },
    permission: "auto", // 只读
    async run({ project, file }) {
      return readProjectFile(project, file);
    },
  },
  {
    name: "generate_project_guide",
    description:
      "生成项目面试讲解指南：读项目档案 + 关键源码（package.json/README/核心模块）→ 按 7 段模板生成 → 存档 output/project-guides/<项目名>.md。适合用户说'生成 XX 项目的面试讲解指南/我的项目怎么讲'。",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（personal_projects 配置中的 name）" },
      },
      required: ["project"],
    },
    permission: "auto", // 只读 + 写 output/project-guides/（与讲解/面经同体系）
    async run({ project }) {
      const proj = matchProject(project);
      if (!proj) return { ok: false, error: `项目「${project}」不在个人项目配置中（设置中心「🎯 简历项目源码」配置 项目名=目录）` };
      try {
        // ① 档案（技术栈/结构树/README/核心预览）——直接构建，不依赖知识库索引状态
        const archive = buildProjectArchive(proj);
        const archiveText = archive?.content ? String(archive.content).slice(0, 12000) : "";
        if (!archiveText) return { ok: false, error: `项目「${proj.name}」档案为空（目录可能已移动）` };
        // ② 关键文件：package.json（技术栈）+ README（定位）+ 结构树里最大的 2 个源码文件（核心实现）
        const keyFiles = [];
        for (const f of ["package.json", "README.md", "readme.md", "README.MD"]) {
          const r = await readProjectFile(proj.name, f);
          if (r.ok) { keyFiles.push({ file: f, content: r.content.slice(0, 4000) }); break; }
        }
        // 从档案结构树挑核心源码（树里最大的 2 个 .mjs/.js/.ts 文件——用档案内容里的文件路径启发式）
        const treeFiles = (String(archive?.content || "").match(/[^\n]+\.[mjt]sx?[^\n]*/g) || []).slice(0, 6);
        for (const f of treeFiles) {
          if (keyFiles.length >= 3) break;
          const clean = f.trim().replace(/^[│├└─\s]+/, "").split(/\s{2,}/)[0].trim();
          if (!clean || clean.includes("node_modules") || clean.includes("test")) continue;
          const r = await readProjectFile(proj.name, clean);
          if (r.ok) keyFiles.push({ file: clean, content: r.content.slice(0, 5000) });
        }
        // ③ LLM 生成 7 段（材料含档案 + 真实源码——外部数据包裹防注入）
        const material = sanitizeExternal(
          `【项目档案】\n${archiveText}\n\n【关键源码摘录】\n${keyFiles.map((k) => `--- ${k.file} ---\n${k.content}`).join("\n")}`
        ).wrapped;
        const data = await llmChat(
          [
            { role: "system", content: "你是资深前端面试辅导。严格依据给定材料生成指南，材料里没有的不许编造。输出 Markdown。" },
            { role: "user", content: `${GUIDE_TEMPLATE}\n\n【材料】\n${material}` },
          ],
          { maxTokens: 4000, temperature: 0.3, role: "project-guide" }
        );
        const guide = getReplyText(data).trim();
        if (guide.length < 200) return { ok: false, error: "指南生成失败（LLM 返回过短）" };
        // ④ 存档 output/project-guides/<项目名>.md（文件名清洗防路径注入）
        const safeName = String(proj.name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
        mkdirSync(GUIDE_DIR, { recursive: true });
        const outPath = path.join(GUIDE_DIR, `${safeName}.md`);
        writeFileSync(outPath, `# ${proj.name} 面试讲解指南\n\n> 生成时间：${new Date().toLocaleString("zh-CN")}\n> 来源：项目档案 + 真实源码（只读）\n\n${guide}\n`, "utf8");
        // ⑤ 返回摘要（7 段标题）
        const sections = [...guide.matchAll(/^##\s+\d+\.\s+(.+)$/gm)].map((m) => m[1].trim());
        return {
          ok: true,
          project: proj.name,
          path: outPath,
          sections,
          preview: guide.slice(0, 300),
          hint: `指南已存档：${outPath}。可让我读对应源码细化某段，或调整语气/深度重新生成。`,
        };
      } catch (e) {
        return { ok: false, error: `指南生成失败: ${String(e?.message || e).slice(0, 150)}` };
      }
    },
  },
];
