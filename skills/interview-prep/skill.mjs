// 项目面试准备技能：基于真实源码生成完整面试准备文档（源码要点 + 全部八股 + 全覆盖拷打问答——可背）
// 工具（skill__interview_prep__* 命名空间）：
//   prepare_project_interview：读项目全部核心源码 → subagent 分析（源码要点+八股）→
//     LLM 生成完整面试准备文档（项目概览/源码要点/全部八股（详细可背）/全覆盖拷打问答）→
//     存档 output/interview-prep/项目·xxx-面试准备.md
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSubagent } from "../../lib/subagent.mjs";
import { getPersonalProjects } from "../../lib/personal-projects.mjs";

export const name = "interview-prep";
export const description = "项目面试准备文档生成（基于真实源码——源码要点 + 全部八股 + 全覆盖拷打问答——详细可背）";

const PREP_DIR = path.join(import.meta.dirname, "..", "..", "output", "interview-prep");
// few-shot 示例库（工单 v2 任务 5：从标杆 interview-prep.md 提取——风格/深度参考——不照搬内容）
const FEWSHOT_PATH = path.join(import.meta.dirname, "examples.md");
const FEWSHOT = existsSync(FEWSHOT_PATH) ? readFileSync(FEWSHOT_PATH, "utf8").slice(0, 6000) : "";
// 质量标准清单（工单 v2：评审逐项对照——达标信号明确）
const QUALITY_CHECKLIST = `□ 背诵路线图（1 天/3 天/1 周）
□ 一句话定位（口语化可背）
□ 关键设计决策速览（5-8 条讲透）
□ 源码要点（核心文件 300-500 字/其他速览）
□ 八股（原理 300-500 字/项目用法/面试应答（口语化可背）/追问 2-3 个带答案）
□ 拷打问答（每文件/知识点/决策——完整答案可背）
□ 可能的追问（每八股/模块 2-3 个）
□ 怎么讲（三层讲述法/讲述脚本/技巧）
□ 讲人话（口语化——可直接背诵——不是书面语/提纲）
□ 真实源码（不编造文件名/代码）`;

// 工单 v2：多轮打磨循环（生成 → 评审 → 修正 → 再评审——最多 3 轮修正）
// 角色分离：评审者（严格质量评审员——对照清单找差距）/ 修正者（资深辅导老师——带全文+差距打磨）
// 上下文累积：修正轮带上次完整文档 + 评审结论（不是盲改）
async function polishDocument(projName, docText) {
  const rounds = [];
  let current = docText;
  for (let round = 0; round < 3; round++) {
    // 评审者（round 1/3）
    const review = await runSubagent({
      name: "质量评审",
      system: "你是严格的质量评审员。对照质量标准清单逐项检查文档，找差距（缺什么/哪里浅/哪里不是讲人话/哪里不真实）。只评审不修改。",
      task: `对照以下质量标准清单，检查文档是否达标：
${QUALITY_CHECKLIST}
输出格式：
1) 达标结论：全部达标 → 输出 PASS；否则输出 FAIL
2) 差距清单（仅 FAIL 时）：每条——【问题】简述 → 位置（章节） → 怎么补（具体）`,
      context: current,
      maxContext: 16000, maxResult: 4000, maxTokens: 3000,
    });
    const reviewText = review?.ok ? review.result : "";
    rounds.push({ round: round + 1, passed: reviewText.includes("PASS") && !reviewText.includes("FAIL"), review: reviewText.slice(0, 400) });
    if (reviewText.includes("PASS") && !reviewText.includes("FAIL")) break; // 达标
    if (!reviewText) break; // 评审失败——停止（保留现状）
    // 修正者（round 2/4）——带上次完整文档 + 评审差距清单 + few-shot
    const revised = await runSubagent({
      name: "文档修正",
      system: "你是资深面试辅导老师（打磨者）。带【上次完整文档 + 评审差距清单】——逐项补全/深化/打磨——输出**完整修正版**（整篇——不是增量。上下文累积：看得到原文和差距）。",
      task: `逐项解决以下评审差距，输出**完整修正版**（整篇打磨后的版本）：
【评审差距清单】
${reviewText.slice(0, 2500)}
【风格参考】（标杆示例——模仿其深度/讲人话——不照搬内容）：
${FEWSHOT.slice(0, 2500)}
红线：基于真实源码（不编造文件名/代码）；八股准确（不幻觉）。`,
      context: `【上次完整文档】\n${current.slice(0, 14000)}`,
      maxContext: 20000, maxResult: 20000, maxTokens: 8000,
    });
    if (revised?.ok && revised.result && revised.result.length > 3000) {
      current = revised.result;
      rounds[rounds.length - 1].revisedLength = current.length;
    } else break; // 修正失败——停止
  }
  return { docText: current, rounds };
}
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".output", "output", "data", "release", ".cache", "target", "venv", "__pycache__", ".idea", ".vscode", ".github", ".husky"]);
const SRC_EXT = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".java", ".rs", ".cpp", ".c", ".h", ".css", ".scss", ".sql", ".sh"]);
const EXCLUDE = /(^|\/)(e2e|__tests__|test|tests)(\/|$)|\.(spec|test)\.|next-env|playwright\.config|vitest\.config|jest\.config|\.d\.ts$/;
const CORE_DIR = /(^|\/)(stores?|lib|hooks|components|core|services|app|backend)(\/|$)/;
const GROUP_BUDGET = 24000;
const FILE_CAP = 30000;

/** 项目白名单匹配（personal_projects 配置；dir 必须存在） */
function matchProject(project) {
  const name = String(project || "").trim();
  if (!name) return null;
  const list = getPersonalProjects();
  return list.find((p) => p.name === name || p.name.includes(name) || name.includes(p.name)) || null;
}

/** 收集核心源码文件（排除测试/配置——核心目录优先） */
function collectCoreFiles(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_EXT.has(path.extname(e.name))) files.push(path.relative(dir, p).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  const core = files.filter((f) => !EXCLUDE.test(f));
  core.sort((a, b) => {
    const wa = CORE_DIR.test(a) ? 1 : 0;
    const wb = CORE_DIR.test(b) ? 1 : 0;
    return wb - wa;
  });
  return core;
}

/** 分组（字符预算——大文件全文读/单独组） */
function groupFiles(dir, coreFiles) {
  const groups = [];
  let cur = [], curLen = 0;
  for (const f of coreFiles) {
    let len;
    try { len = Math.min(statSync(path.join(dir, f)).size, FILE_CAP); } catch { len = 0; }
    if (curLen + len > GROUP_BUDGET && cur.length) { groups.push(cur); cur = []; curLen = 0; }
    cur.push(f); curLen += len;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** 主工具：生成完整面试准备文档 */
export async function prepareProjectInterview({ project, force = false } = {}) {
  const proj = matchProject(project);
  if (!proj) return { ok: false, error: `未找到项目「${project}」——请在设置里配置 personal_projects（name + dir）` };
  const { name, dir } = proj;
  // 缓存：已生成且非 force → 直接返回
  const docPath = path.join(PREP_DIR, `项目·${name}-面试准备.md`);
  if (!force && existsSync(docPath)) {
    return { ok: true, filePath: docPath, cached: true, summary: `已存在（${statSync(docPath).size} 字符）——force=true 重新生成` };
  }
  try {
    // 1. 读全部核心源码 → 分组
    const coreFiles = collectCoreFiles(dir);
    if (!coreFiles.length) return { ok: false, error: "项目无核心源码" };
    const groups = groupFiles(dir, coreFiles);
    // 2. subagent 串行分析（源码要点 + 八股——稳定不卡）
    const summaries = [];
    for (const g of groups) {
      const content = g.map((f) => {
        try { return `--- ${f} ---\n${readFileSync(path.join(dir, f), "utf8").slice(0, FILE_CAP)}`; } catch { return ""; }
      }).filter(Boolean).join("\n\n");
      const r = await runSubagent({
        name: "项目源码分析",
        task: "分析以下项目源码文件，提取每个文件的核心职责、关键实现（数据结构/算法/设计模式/状态管理）、可能的坑，以及涉及的技术知识点（八股）。精炼输出：每个文件 2-4 行要点，中文。末尾单独输出【八股清单】：每个知识点一行——【八股】<知识点>：项目里怎么用的（真实文件/代码）+ 面试官可能追问的问题。",
        context: content,
      });
      if (r?.ok && r.result) summaries.push(r.result);
    }
    const fullSummary = summaries.filter(Boolean).join("\n\n");
    if (fullSummary.length < 500) return { ok: false, error: "源码分析结果过短（subagent 失败？）" };
    // 3. 八股提取（专门 subagent——全部八股——详细可背）
    let baSection = "";
    try {
      const ba = await runSubagent({
        name: "八股提取",
        task: "基于以下项目源码要点，提取项目涉及的全部技术知识点（八股）——覆盖项目所有技术领域（框架/语言/数据库/网络/并发/安全/性能/算法等——项目用什么就提取什么）。每个知识点一行：【八股】<知识点>：项目里怎么用的（真实文件/代码）+ 面试官可能追问的问题。至少 10 个，覆盖核心业务（不只是配置文件）。",
        context: fullSummary.slice(0, 20000),
      });
      if (ba?.ok && ba.result) baSection = ba.result;
    } catch { /* 八股提取失败——回落从汇总提取 */ }
    if (!baSection) {
      const baLines = fullSummary.match(/【八股】[^\n]+/g) || [];
      baSection = baLines.length ? baLines.join("\n") : "（subagent 未输出八股清单）";
    }
    // 4. 分步生成完整面试准备文档（修复：单次 LLM 输出有限（6000 字符）——分步每部分单独
    // subagent（详细）——汇总拼接（30000+ 字符——接近标杆 interview-prep.md）
    // 注意：runSubagent 默认 context 截断 6000/结果截断 6000——生成者必须传大上限
    // （否则 18000 字符素材只看到 6000——生成质量直接打折）
    const GEN_OPTS = { maxContext: 20000, maxResult: 12000, maxTokens: 6000 };
    const ctx = `${fullSummary.slice(0, 12000)}\n\n${baSection.slice(0, 6000)}`;
    const BASE_RULES = "红线：基于真实源码（不编造文件名/代码）；八股准确（不幻觉）；覆盖核心业务（不只是配置文件）；输出详细（每部分完整展开——不写提纲）。";
    const parts = [];
    // 4.1 开场材料（背诵路线图/定位/决策/概览）
    parts.push(await runSubagent({
      name: "开场材料生成",
      task: `基于以下项目源码要点，生成面试准备文档的**开场部分**（详细——4000 字以上）：
# 项目·${name} 面试准备
## 背诵路线图（时间紧 1 天/3 天/1 周——分别背什么——面试前 1 小时过什么）
## 一句话定位（30 秒开场——项目是什么/解决什么问题/技术栈——口语化可背）
## 关键设计决策速览（5-8 条——面试开场可用——为什么选 X 不用 Y——每条 100-200 字讲透）
## 项目概览（技术栈/架构/目录结构/核心模块/数据流）
${BASE_RULES}`,
      context: ctx,
      ...GEN_OPTS,
    }));
    // 4.2 源码要点（核心文件详细）
    const srcRes = await runSubagent({
      name: "源码要点生成",
      task: `基于以下项目源码要点，生成**源码要点部分**（详细——8000 字以上）：核心文件详细（每个 300-500 字——核心职责/关键实现（函数名/算法细节）/可能的坑）；其他文件速览（一行）。按文件组织：
## 源码要点
### <文件名> —— <职责>
（核心职责/关键实现/坑——300-500 字）
${BASE_RULES}`,
      context: ctx,
      ...GEN_OPTS,
    });
    parts.push(srcRes);
    // 4.3 八股（详细可背）
    const baRes = await runSubagent({
      name: "八股生成",
      task: `基于以下项目源码要点与八股清单，生成**八股部分**（详细——8000 字以上——覆盖项目所有技术点）：
## 涉及的全部八股
### <知识点>
- 原理（详细讲透：机制/为什么成立/与相似概念的对比/核心流程——300-500 字）
- 项目真实用法（真实文件/代码——项目里怎么用的、为什么这么用）
- 面试应答（面试官问"讲讲 X"时的完整回答——口语化、可直接背诵——200-400 字）
- 追问 2-3 个（每个带完整答案——可背）
${BASE_RULES}`,
      context: ctx,
      ...GEN_OPTS,
    });
    parts.push(baRes?.ok ? baRes : null);
    // 4.4 模拟面试问答（全覆盖拷打）
    parts.push(await runSubagent({
      name: "拷打问答生成",
      task: `基于以下项目源码要点与八股清单，生成**模拟面试问答部分**（全覆盖拷打——详细——8000 字以上——数量不限，项目大就多）：
## 模拟面试问答
- 每个核心文件至少 1-2 个拷打问题（怎么实现/为什么这么设计/有什么坑）
- 每个八股至少 1-2 个拷打问题（原理/对比/追问）
- 每个技术决策至少 1 个拷打问题（为什么选 X 不用 Y）
- 拷打维度：实现细节/设计决策/边界异常/安全/性能/扩展性/数据量翻倍/重构方向/替代方案对比
- 每个答案：完整表述（3-5 句——口语化——可直接背诵——不是要点/提纲）
## 可能的追问（每个知识点/模块——面试官可能追问的问题全覆盖）：
- 每个八股至少 2-3 个追问（为什么/对比/边界/如果……会怎样）——每个带完整答案（口语化可背）
- 每个核心模块至少 2-3 个追问（实现细节/异常场景/扩展方向）——每个带完整答案
${BASE_RULES}`,
      context: ctx,
      ...GEN_OPTS,
    }));
    // 4.5 怎么讲（讲人话）
    parts.push(await runSubagent({
      name: "讲述方法论生成",
      task: `基于以下项目源码要点，生成**怎么讲部分**（讲人话——比内容更重要——详细——4000 字以上）：
## 怎么讲
- 三层讲述法（项目是什么 → 我做了什么 → 为什么这么做/有什么坑）
- 每个核心模块的讲述脚本（照着讲——每段 1.5-2 分钟——口语化——背景→方案→实现→权衡→坑）
- 讲述技巧（先结论后细节/用数字/主动说坑/控制节奏）
${BASE_RULES}`,
      context: ctx,
      ...GEN_OPTS,
    }));
    const docText = parts.filter((p) => p?.ok && p.result).map((p) => p.result).join("\n\n---\n\n");
    if (!docText || docText.length < 3000) return { ok: false, error: "面试准备文档生成失败（分步输出过短）" };
    // 5. 多轮打磨（工单 v2：生成 → 评审 → 修正 → 再评审——角色分离/上下文累积/few-shot）
    const { docText: polished, rounds } = await polishDocument(name, docText);
    const doc = { ok: true, result: polished };
    // 6. 存档
    mkdirSync(PREP_DIR, { recursive: true });
    writeFileSync(docPath, doc.result, "utf8");
    const roundInfo = rounds.map((r) => `R${r.round}${r.passed ? "✓" : ""}${r.revisedLength ? `(修正→${r.revisedLength})` : ""}`).join(" ");
    return { ok: true, filePath: docPath, summary: `已生成（${doc.result.length} 字符——${coreFiles.length} 个核心文件——打磨：${roundInfo}）` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 工具定义（skills.mjs 注册——tool.run 调用） */
export const tools = [
  {
    name: "prepare_project_interview",
    description:
      "生成项目完整面试准备文档（基于真实源码——源码要点 + 全部八股（详细可背）+ 全覆盖拷打问答——能通过模拟面试）。读项目全部核心源码 → subagent 分析 → LLM 生成 → 存档 output/interview-prep/项目·xxx-面试准备.md",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（personal_projects 配置中的 name，如 ai-career）" },
        force: { type: "boolean", description: "true 强制重新生成（默认读缓存）" },
      },
      required: ["project"],
    },
    run: prepareProjectInterview,
  },
];

/** 工具路由（skill__interview_prep__* 命名空间） */
export async function callSkillTool(name, args) {
  if (name === "skill__interview_prep__prepare_project_interview") {
    return await prepareProjectInterview(args || {});
  }
  return { error: `未知工具: ${name}` };
}
