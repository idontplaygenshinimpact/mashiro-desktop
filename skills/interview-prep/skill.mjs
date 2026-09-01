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
    let len = 0;
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
    // 4. LLM 生成完整面试准备文档（详细可背 + 全覆盖拷打）
    const doc = await runSubagent({
      name: "面试准备文档生成",
      task: `基于以下项目源码要点与八股清单，生成一份**完整的项目面试准备文档**（质量标准：能通过模拟面试——内容详细、可直接背诵、拷打全覆盖）。格式：
# 项目·${name} 面试准备
## 项目概览（技术栈/架构/目录结构/核心模块/数据流）
## 源码要点（每个核心文件：核心职责/关键实现/可能的坑——基于真实代码）
## 涉及的全部八股（每个知识点**详细可背**）：
  ### <知识点>
  - 原理（详细讲透：机制/为什么成立/与相似概念的对比/核心流程——300-500 字）
  - 项目真实用法（真实文件/代码——项目里怎么用的、为什么这么用）
  - 面试应答（面试官问"讲讲 X"时的完整回答——口语化、可直接背诵——200-400 字）
  - 追问 2-3 个（每个带完整答案——可背）
## 模拟面试问答（**全覆盖拷打**——项目涉及的全部内容）：
  - 每个核心文件至少 1-2 个拷打问题（怎么实现/为什么这么设计/有什么坑）
  - 每个八股至少 1-2 个拷打问题（原理/对比/追问）
  - 每个技术决策至少 1 个拷打问题（为什么选 X 不用 Y）
  - 拷打维度全覆盖：实现细节/设计决策/边界异常/安全/性能/扩展性/数据量翻倍/重构方向/替代方案对比
  - 数量不限（项目大就多——全部内容都被拷打）
  - 每个答案：完整表述（3-5 句——口语化——可直接背诵——不是要点/提纲）
红线：基于真实源码（不编造文件名/代码）；八股准确（不幻觉）；覆盖核心业务（不只是配置文件）。`,
      context: `${fullSummary.slice(0, 12000)}\n\n${baSection.slice(0, 6000)}`,
    });
    if (!doc?.ok || !doc.result) return { ok: false, error: "面试准备文档生成失败" };
    // 5. 存档
    mkdirSync(PREP_DIR, { recursive: true });
    writeFileSync(docPath, doc.result, "utf8");
    return { ok: true, filePath: docPath, summary: `已生成（${doc.result.length} 字符——${coreFiles.length} 个核心文件）` };
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
