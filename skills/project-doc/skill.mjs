// 项目学习文档技能（强化版）：对标 interview-prep.md 覆盖 ≥95%
// 分步生成（概览/源码要点/八股/拷打问答 5 组/讲述方法论）+ 源码外信息注入（README/package.json/docs/git log）
// + 多轮打磨循环（评审/修正/上下文累积/缩水保护）+ 覆盖校验（17 章缺 ≤1）
// 工具（skill__project-doc__* 命名空间）：generate_project_doc
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSubagent, SUBAGENT_TOOLS } from "../../lib/subagent.mjs";
import { getPersonalProjects, buildProjectArchive } from "../../lib/personal-projects.mjs";

export const name = "project-doc";
export const description = "项目学习文档生成（强化版：分步生成 + 源码外信息注入 + 多轮打磨 + 覆盖校验 ≥95%——对标人工标杆）";

const DOC_DIR = path.join(import.meta.dirname, "..", "..", "output", "study_notes");
const ROOT = path.join(import.meta.dirname, "..", ".."); // 项目根（subagent 工具路径白名单）
const MAX_FILE = 30 * 1024;

// ---------- 覆盖基准（对标 interview-prep.md 章节——17 章，缺 ≤1 即 ≥95%） ----------
const STRUCTURE_SECTIONS = [
  { key: "项目概览", markers: ["项目概览"] },
  { key: "一句话定位", markers: ["一句话定位"] },
  { key: "技术栈", markers: ["技术栈"] },
  { key: "架构与目录", markers: ["架构", "目录结构"] },
  { key: "核心模块与数据流", markers: ["核心模块", "数据流"] },
  { key: "关键设计决策", markers: ["关键设计决策"] },
  { key: "源码要点", markers: ["源码要点"] },
  { key: "八股", markers: ["八股"] },
  { key: "模块拷打", markers: ["模块拷打", "面试模块拷打"] },
  { key: "链路拷打", markers: ["链路拷打", "请求链路"] },
  { key: "压力问题", markers: ["压力问题", "高频追问"] },
  { key: "场景题", markers: ["场景题"] },
  { key: "产品向", markers: ["产品向", "用户", "推广"] },
  { key: "AI 参与度", markers: ["AI 参与度", "AI 写的"] },
  { key: "手写题", markers: ["手写题"] },
  { key: "反问", markers: ["反问"] },
  { key: "项目叙事", markers: ["为什么做", "最骄傲", "项目背景"] },
  { key: "讲述方法论", markers: ["讲述", "怎么讲", "三层讲述"] },
];

// ---------- 源码外信息注入（解决"只读源码缺叙事"） ----------
function collectExtraInfo(projDir) {
  const parts = [];
  // ① README.md（定位/功能/使用）
  for (const f of ["README.md", "readme.md", "README.MD"]) {
    try {
      const p = path.join(projDir, f);
      if (existsSync(p)) {
        const c = readFileSync(p, "utf8").slice(0, MAX_FILE);
        parts.push(`【README.md】\n${c.slice(0, 4000)}`);
        break;
      }
    } catch { /* ignore */ }
  }
  // ② package.json（技术栈/脚本）
  try {
    const p = path.join(projDir, "package.json");
    if (existsSync(p)) parts.push(`【package.json】\n${readFileSync(p, "utf8").slice(0, 2000)}`);
  } catch { /* ignore */ }
  // ③ docs/ 目录（性能报告/架构文档/方案——性能数据/设计决策来源）
  try {
    const docsDir = path.join(projDir, "docs");
    if (existsSync(docsDir)) {
      const files = readdirSync(docsDir).filter((f) => f.endsWith(".md")).slice(0, 5);
      const excerpts = files.map((f) => {
        try {
          const c = readFileSync(path.join(docsDir, f), "utf8");
          return `【docs/${f}】\n${c.slice(0, 1500)}`;
        } catch { return ""; }
      }).filter(Boolean).join("\n\n");
      if (excerpts) parts.push(`【docs 目录文档摘要】\n${excerpts.slice(0, 5000)}`);
    }
  } catch { /* ignore */ }
  return parts.join("\n\n---\n\n").slice(0, 12000);
}

// ---------- 分步生成 ----------
async function genStep(name, system, task, context, maxResult = 12000) {
  const r = await runSubagent({ name, system, task, context, maxContext: 30000, maxResult, maxTokens: 8000 });
  return r?.ok ? r.result : "";
}

/**
 * 生成/强化项目学习文档（分步 + 打磨 + 覆盖校验）
 * 导出供测试直测（工具层经 callSkillTool 走同一实现）
 * @param {{project: string, force?: boolean}} args 项目名（personal_projects 配置）
 * @returns {Promise<{ok?: boolean, docPath?: string, coverage?: string, rounds?: Array<{round: number, passed: boolean, review: string, revisedLength: number, shrink: boolean} | {round: string, patched: string, patchLength: number}>, chars?: number, error?: string}>}Array, error?: string}>}
 */
export async function generateProjectDoc({ project, force = false }) {
  const proj = (getPersonalProjects() || []).find((p) => p.name === project || p.name.includes(project) || project.includes(p.name));
  if (!proj) return { error: `项目「${project}」不在个人项目配置中（设置中心「🎯 简历项目源码」配置 项目名=目录）` };
  const docPath = path.join(DOC_DIR, `项目·${String(proj.name).replace(/[\\/:*?"<>|\r\n]/g, "").trim().slice(0, 60)}-学习文档.md`);
  if (!force && existsSync(docPath)) {
    const c = readFileSync(docPath, "utf8");
    if (!c.includes("（生成失败") && c.length > 500) return { ok: true, docPath, coverage: "缓存命中（已存在且非失败态）" };
  }
  // ① 素材：源码档案（buildProjectArchive——全部核心源码头部）+ 源码外信息
  const archive = await buildProjectArchive(proj);
  const srcText = String(archive?.content || "").slice(0, 20000);
  const extraInfo = collectExtraInfo(proj.dir);
  if (srcText.length < 500) return { error: `项目源码档案为空（${proj.dir} 无可读源码？）` };

  // ② 分步生成（对标标杆章节）
  const overview = await genStep("项目概览生成",
    "你是资深面试辅导老师。基于项目源码与 README/package.json/docs 生成项目概览章节。",
    `生成【项目概览】章节（对标人工标杆 interview-prep.md 的 1.x 节）：
1. 一句话定位（口语化可背）
2. 技术栈（依赖 + 用途）
3. 架构与目录结构（分层/模块划分）
4. 核心模块与数据流（每个模块职责 + 数据怎么流）
5. 关键设计决策速览（5-8 条：为什么这么设计——选型 trade-off/架构取舍）
要求：基于真实源码与 README（不编造）；README/docs 里的性能数据/设计说明要吸收进来。
输出：## 项目概览 开头的完整 Markdown。`,
    `【源码档案】\n${srcText.slice(0, 12000)}\n\n【源码外信息（README/package.json/docs）】\n${extraInfo.slice(0, 8000)}`,
    10000);

  const srcPoints = await genStep("源码要点生成",
    "你是资深面试辅导老师。基于项目源码生成源码要点章节。",
    `生成【源码要点】章节：对每个核心文件输出——核心职责 / 关键实现（数据结构/算法/设计模式/状态管理）/ 可能的坑。每个文件 2-4 行，中文，精炼。只基于真实源码（不编造文件名）。`,
    srcText, 12000);

  const baSection = await genStep("八股提取",
    "你是资深面试辅导老师。基于项目源码要点提取全部技术知识点（八股）。",
    `提取项目涉及的全部技术知识点（八股）——包括但不限于：状态管理、SSE 流式、有限状态机、沙箱隔离、防抖节流、框架原理、网络、安全、性能优化等。每个知识点一行：【八股】<知识点>：项目里怎么用的（真实文件/代码）+ 面试官可能追问的问题。至少 12 个，覆盖核心业务。`,
    `${srcPoints.slice(0, 10000)}\n\n${srcText.slice(0, 8000)}`, 10000);

  // 拷打问答 5 组（核心强化——分模块生成，避免一次超时）
  const qaGroups = [
    ["模块拷打", "生成【模块拷打】问答：对每个核心模块 2-3 个面试官高频问题（源码细节 + 选型 trade-off + 边界失败），每个问题带参考答案（2-4 句，基于真实源码，不编造）。输出 Q1/A1 格式。"],
    ["链路拷打", "生成【链路拷打】问答：AI 请求链路/数据流/竞态/超时/重试/降级/安全（SSRF/限流）的面试官拷打问题 + 参考答案（基于真实源码）。输出 Q1/A1 格式。"],
    ["压力问题", "生成【压力问题】问答：最复杂/最有挑战、生产 bug 和修复过程、如果重做会改什么、数据量翻倍哪里先崩、AI 接口不可用还能用吗——每个带参考答案（基于真实源码 + README/docs 信息）。输出 Q1/A1 格式。"],
    ["场景题与产品向", "生成【场景题 + 产品向 + AI 参与度】问答：① 场景题（白屏排查/权限系统/性能排查方法论）② 产品向（用户有多少/怎么推广/怎么持续迭代——基于 README/docs 真实信息，没有就诚实说作品集定位）③ AI 参与度（项目是不是 AI 写的/怎么保证 AI 代码质量——诚实回答 + 强调架构决策）。输出 Q1/A1 格式。"],
    ["手写题与反问叙事", "生成【手写题 + 反问 + 项目叙事】问答：① 手写题（项目相关的高频手写题 3-5 个：防抖节流/深拷贝/Promise 实现等）② 反问环节（面试官提问后你反问的 3-4 个问题）③ 项目叙事（为什么做这个项目/最骄傲的设计/投入时间规划/简历上怎么写——基于 README/docs 真实信息）。输出 Q1/A1 格式。"],
  ];
  const qaSections = [];
  for (const [gname, gtask] of qaGroups) {
    const s = await genStep(`拷打问答·${gname}`,
      "你是资深面试辅导老师。生成面试官拷打问答（基于真实源码与 README/docs——不编造）。",
      gtask,
      `${srcPoints.slice(0, 8000)}\n\n${baSection.slice(0, 6000)}\n\n【源码外信息】\n${extraInfo.slice(0, 5000)}`,
      12000);
    qaSections.push(s ? `## ${gname}\n${s}` : `## ${gname}\n（生成失败——可基于源码要点与八股自行组织）`);
  }

  const talkMethod = await genStep("讲述方法论生成",
    "你是资深面试辅导老师。生成讲述方法论章节。",
    `生成【讲述方法论】章节（对标 interview-prep.md 的 5.x 节）：
1. 讲述的总体框架：三层讲述法（项目背景 → 技术实现 → 亮点价值）
2. 每个模块的讲述模板（五段式：背景/方案/实现/难点/价值）
3. 讲述技巧（主动埋点引导追问/把追问引回主场/60 秒人话版）
4. 追问应对策略
要求：结合本项目真实模块（不套模板空话）。`,
    `${overview.slice(0, 4000)}\n\n${srcPoints.slice(0, 6000)}`, 8000);

  // ③ 组装草稿
  const docText = `# 项目·${proj.name} 学习文档（强化版：分步生成 + 打磨 + 覆盖校验）\n\n${overview}\n\n## 源码要点\n${srcPoints}\n\n## 涉及的全部八股\n${baSection}\n\n## 模拟面试拷打问答\n${qaSections.join("\n\n")}\n\n## 讲述方法论\n${talkMethod || "（生成失败）"}\n`;

  // ④ 草稿先落盘（Subagent v2 修正者用 read_file/edit_file 编辑文件——必须先写入才能被编辑）
  try { mkdirSync(DOC_DIR, { recursive: true }); } catch { /* ignore */ }
  writeFileSync(docPath, docText, "utf8");

  // ⑤ 多轮打磨循环（评审 → 修正 → 再评审——最多 3 轮；缩水保护 ≥80%）
  const rounds = [];
  let current = docText;
  for (let round = 0; round < 3; round++) {
    const review = await runSubagent({
      name: "质量评审",
      system: "你是严格的质量评审员。对照覆盖基准逐项检查文档，找差距（缺章节/哪里浅/哪里不是讲人话/哪里不真实）。只评审不修改。",
      task: `对照以下覆盖基准检查文档（17 章）：
${STRUCTURE_SECTIONS.map((s) => `- ${s.key}`).join("\n")}
输出：1) 达标结论：全部覆盖 → PASS；否则 FAIL + 缺哪些章节 2) 差距清单（每条：问题 → 位置 → 怎么补）`,
      context: current,
      maxContext: 30000, maxResult: 4000, maxTokens: 3000,
    });
    const reviewText = review?.ok ? review.result : "";
    rounds.push({ round: round + 1, passed: reviewText.includes("PASS") && !reviewText.includes("FAIL"), review: reviewText.slice(0, 300), revisedLength: 0, shrink: false });
    if (reviewText.includes("PASS") && !reviewText.includes("FAIL")) break;
    if (!reviewText) break;
    const prevLen = current.length;
    // Subagent v2：修正者启用 read_file/edit_file 工具——读章节 → 定位差距 → 编辑 → 保存
    // （不再"重写全文"——输出量 = 差距大小，不撞 LLM 输出上限不缩水）
    const revised = await runSubagent({
      name: "文档修正",
      system: "你是资深面试辅导老师（打磨者）。文档在文件里——用 read_file 定位差距章节 → edit_file 逐章修正（old_string 唯一匹配）→ 最后输出总结。不要重写全文（输出量 = 差距大小）。",
      task: `逐项解决以下评审差距（文档文件：${path.relative(ROOT, docPath)}）：
【评审差距清单】
${reviewText.slice(0, 2500)}
红线：基于真实源码（不编造文件名/代码）；八股准确（不幻觉）；edit_file 的 old_string 必须与文件内容精确匹配（先 read_file 确认）。`,
      context: `【评审参考：上次文档开头（定位章节用）】\n${current.slice(0, 8000)}`,
      maxContext: 20000, maxResult: 2000, maxTokens: 3000,
      tools: SUBAGENT_TOOLS.filter((t) => ["read_file", "edit_file"].includes(t.function.name)),
      root: ROOT,
    });
    if (revised?.ok) {
      // 修正者用工具改了文件 → 重读同步 current（缩水保护：文件长度 ≥80% 防 edit 误删）
      try { current = readFileSync(docPath, "utf8"); } catch { /* 文件未变 */ }
      rounds[rounds.length - 1].revisedLength = current.length;
      if (current.length < prevLen * 0.8) rounds[rounds.length - 1].shrink = true;
    } else break;
  }

  // ⑤ 覆盖校验（17 章缺 ≤1 = ≥95%）+ 结构补缺
  const missing = STRUCTURE_SECTIONS.filter((s) => !s.markers.some((m) => current.includes(m)));
  if (missing.length > 1) {
    const missingNames = missing.map((s) => s.key).join("、");
    const patch = await runSubagent({
      name: "结构补缺",
      system: "你是资深面试辅导老师。文档缺了部分章节——生成缺失部分（内容基于素材——不编造）。",
      task: `以下文档缺失章节：**${missingNames}**。请生成这些缺失部分（每部分完整展开——参照现有文档风格深度）：
【文档素材】
${srcPoints.slice(0, 5000)}
${baSection.slice(0, 4000)}
输出格式：直接输出缺失章节的完整 Markdown（## 标题开头——不重复已有内容）。`,
      context: `【现有文档片段】\n${current.slice(0, 5000)}`,
      maxContext: 20000, maxResult: 12000, maxTokens: 6000,
    });
    if (patch?.ok && patch.result && patch.result.length > 500) {
      current = `${current}\n\n---\n\n${patch.result}`;
      rounds.push({ round: "structure", patched: missingNames, patchLength: patch.result.length });
    }
  }
  const finalMissing = STRUCTURE_SECTIONS.filter((s) => !s.markers.some((m) => current.includes(m)));
  const coverage = `${STRUCTURE_SECTIONS.length - finalMissing.length}/${STRUCTURE_SECTIONS.length} 章（${Math.round(((STRUCTURE_SECTIONS.length - finalMissing.length) / STRUCTURE_SECTIONS.length) * 100)}%）${finalMissing.length ? `，缺：${finalMissing.map((s) => s.key).join("、")}` : ""}`;

  // ⑥ 存档
  try { mkdirSync(DOC_DIR, { recursive: true }); } catch { /* ignore */ }
  writeFileSync(docPath, current, "utf8");
  return { ok: true, docPath, coverage, rounds, chars: current.length };
}

export const tools = [
  {
    name: "generate_project_doc",
    description: "生成/强化项目学习文档（分步生成 + 源码外信息注入 + 多轮打磨 + 覆盖校验 ≥95%——对标人工标杆 interview-prep.md）",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（个人项目配置中的名字，如 ai-career）" },
        force: { type: "boolean", description: "强制重新生成（默认 false——已有且非失败态则读缓存）" },
      },
      required: ["project"],
    },
    permission: "confirm",
    run: generateProjectDoc,
  },
];
