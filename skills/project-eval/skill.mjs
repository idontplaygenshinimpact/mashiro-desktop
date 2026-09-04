// 项目全面评估技能：基于真实源码生成全面评估报告（8 维度 + 问题清单 + Top 5 改进——强化：分步评估 + 打磨循环）
// 工具（skill__project-eval__* 命名空间）：
//   evaluate_project：读项目全部核心源码 → subagent 分步评估（8 维度）→ 汇总 →
//     打磨循环（评审/修正——上下文累积）→ 存档 output/project-evals/项目·xxx-评估报告.md
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSubagent } from "../../lib/subagent.mjs";
import { getPersonalProjects } from "../../lib/personal-projects.mjs";

export const name = "project-eval";
export const description = "项目全面评估报告生成（基于真实源码——8 维度评估 + 问题清单 + Top 5 改进——强化：分步评估 + 打磨循环）";

const EVAL_DIR = path.join(import.meta.dirname, "..", "..", "output", "project-evals");
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".output", "output", "data", "release", ".cache", "target", "venv", "__pycache__", ".idea", ".vscode", ".github", ".husky"]);
const SRC_EXT = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".java", ".rs", ".cpp", ".c", ".h", ".css", ".scss", ".sql", ".sh"]);
const EXCLUDE = /(^|\/)(e2e|__tests__|test|tests)(\/|$)|\.(spec|test)\.|next-env|playwright\.config|vitest\.config|jest\.config|\.d\.ts$/;
const CORE_DIR = /(^|\/)(stores?|lib|hooks|components|core|services|app|backend)(\/|$)/;
// 技术债 L15：GROUP_BUDGET/FILE_CAP 收敛到 lib/skill-constants.mjs 单点
import { GROUP_BUDGET, FILE_CAP } from "../../lib/skill-constants.mjs";

// 质量标准清单（评审对照——评估报告必须覆盖）
const QUALITY_CHECKLIST = `□ 总评（评分 1-10 + 一句话结论）
□ 8 维度评估（架构/代码质量/测试/安全/性能/可维护性/技术债/风险——每个：现状/问题/建议——基于真实代码引用具体文件/函数）
□ 问题清单（按严重度排序：严重/中等/轻微——每个：问题/位置/影响/建议）
□ 亮点（做得好的——保持）
□ 优先改进建议（Top 5——按投入产出比——每个：改什么/为什么/工作量）
□ 具体性（问题不是"代码质量一般"——是"xxx 函数重复实现 3 次——建议抽象"）
□ 平衡（不只挑刺——亮点也要——客观）
□ 真实源码（不编造——引用具体文件/函数）`;

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

/** 打磨循环（强化：评审/修正——上下文累积——评估报告不缩水） */
async function polishEval(projName, docText) {
  const rounds = [];
  let current = docText;
  for (let round = 0; round < 2; round++) {
    const review = await runSubagent({
      name: "评估质量评审",
      system: "你是严格的质量评审员。对照质量标准清单逐项检查评估报告，找差距（缺维度/不具体/不客观/不基于真实代码）。只评审不修改。",
      task: `对照以下质量标准清单，检查评估报告是否达标：
${QUALITY_CHECKLIST}
输出格式：
1) 达标结论：全部达标 → 输出 PASS；否则输出 FAIL
2) 差距清单（仅 FAIL 时）：每条——【问题】简述 → 位置 → 怎么补（具体）`,
      context: current,
      maxContext: 16000, maxResult: 4000, maxTokens: 3000,
    });
    const reviewText = review?.ok ? review.result : "";
    rounds.push({ round: round + 1, passed: reviewText.includes("PASS") && !reviewText.includes("FAIL"), review: reviewText.slice(0, 400) });
    if (reviewText.includes("PASS") && !reviewText.includes("FAIL")) break;
    if (!reviewText) break;
    const prevLen = current.length;
    const revised = await runSubagent({
      name: "评估报告修正",
      system: "你是资深技术评审专家（打磨者）。带【上次完整报告 + 评审差距清单】——**只修改差距清单涉及的部分——其他部分原样保留（不重写/不删除）**——输出修正后的完整报告。上下文累积：看得到原文和差距。",
      task: `逐项解决以下评审差距——**只改差距部分**（差距清单外的内容原文保留——不要重写整篇——不要删任何已有章节——字符数不得少于输入草稿的 80%）：
【评审差距清单】
${reviewText.slice(0, 2500)}
红线：基于真实源码（不编造文件名/代码）；问题要具体（引用文件/函数）。`,
      context: `【上次完整报告（全文——不截断）】\n${current}`,
      maxContext: 40000, maxResult: 40000, maxTokens: 16000,
    });
    if (revised?.ok && revised.result && revised.result.length >= prevLen * 0.8) {
      current = revised.result;
      rounds[rounds.length - 1].revisedLength = current.length;
    } else break;
  }
  return { docText: current, rounds };
}

/** 主工具：生成全面评估报告 */
export async function evaluateProject({ project, force = false } = {}) {
  const proj = matchProject(project);
  if (!proj) return { ok: false, error: `未找到项目「${project}」——请在设置里配置 personal_projects（name + dir）` };
  const { name, dir } = proj;
  const docPath = path.join(EVAL_DIR, `项目·${name}-评估报告.md`);
  if (!force && existsSync(docPath)) {
    return { ok: true, filePath: docPath, cached: true, summary: `已存在（${statSync(docPath).size} 字符）——force=true 重新评估` };
  }
  try {
    const coreFiles = collectCoreFiles(dir);
    if (!coreFiles.length) return { ok: false, error: "项目无核心源码" };
    const groups = groupFiles(dir, coreFiles);
    // 1. subagent 串行分析（源码要点——评估素材）
    const summaries = [];
    for (const g of groups) {
      const content = g.map((f) => {
        try { return `--- ${f} ---\n${readFileSync(path.join(dir, f), "utf8").slice(0, FILE_CAP)}`; } catch { return ""; }
      }).filter(Boolean).join("\n\n");
      const r = await runSubagent({
        name: "项目源码分析",
        task: "分析以下项目源码文件，提取每个文件的核心职责、关键实现、可能的坑、明显的代码问题（重复/复杂度/错误处理/安全风险）。精炼输出：每个文件 2-4 行要点，中文。",
        context: content,
      });
      if (r?.ok && r.result) summaries.push(r.result);
    }
    const fullSummary = summaries.filter(Boolean).join("\n\n");
    if (fullSummary.length < 500) return { ok: false, error: "源码分析结果过短（subagent 失败？）" };
    // 2. 分步评估（8 维度——每维度单独 subagent——详细——汇总拼接）
    const ctx = fullSummary.slice(0, 20000);
    const BASE_RULES = "红线：基于真实源码（不编造——引用具体文件/函数）；问题要具体（不是'代码质量一般'——是'xxx 函数重复实现 3 次——建议抽象'）；平衡（不只挑刺——亮点也要）。";
    const DIMS = [
      ["架构与设计", "模块划分/职责边界/数据流/依赖方向/设计模式/分层是否清晰——现状/问题/建议"],
      ["代码质量", "可读性/命名/重复（DRY）/复杂度/错误处理/边界处理——现状/问题/建议"],
      ["测试覆盖", "单测/集成/E2E——是否覆盖关键路径/边界/异常/负向路径——现状/问题/建议"],
      ["安全", "输入校验/SSRF/注入/敏感信息（密钥）/依赖漏洞/权限——现状/问题/建议"],
      ["性能", "瓶颈/不必要的重渲染/大文件加载/缓存/异步处理——现状/问题/建议"],
      ["可维护性", "文档/注释/配置管理/构建/CI/代码组织——现状/问题/建议"],
      ["技术债", "TODO/FIXME/硬编码/废弃代码/已知坑/重复实现——现状/问题/建议"],
      ["风险", "单点故障/扩展性/依赖风险/数据一致性——现状/问题/建议"],
    ];
    const parts = [];
    for (const [dim, focus] of DIMS) {
      const r = await runSubagent({
        name: `评估-${dim}`,
        task: `基于以下项目源码要点，评估**${dim}**维度（${focus}）。输出（详细——1500 字以上）：
## ${dim}
- 现状（基于真实代码——引用具体文件/函数）
- 问题（具体——不是泛泛而谈——每个问题带位置/影响）
- 建议（可落地——不是'优化性能'——是'xxx 处用 memo 避免重渲染——预计收益'）
${BASE_RULES}`,
        context: ctx,
      });
      if (r?.ok && r.result) parts.push(r.result);
    }
    // 3. 汇总（总评/问题清单/亮点/Top 5）
    const summaryRes = await runSubagent({
      name: "评估汇总",
      task: `基于以下 8 维度评估，生成评估报告的**汇总部分**（详细）：
# 项目·${name} 评估报告
## 总评（评分 1-10 + 一句话结论）
## 问题清单（按严重度排序：严重/中等/轻微——每个：问题/位置/影响/建议——从 8 维度评估中提炼）
## 亮点（做得好的——保持——从 8 维度评估中提炼）
## 优先改进建议（Top 5——按投入产出比——每个：改什么/为什么/工作量）
${BASE_RULES}`,
      context: parts.filter(Boolean).join("\n\n").slice(0, 20000),
    });
    const docText = [summaryRes?.ok ? summaryRes.result : "", ...parts.filter(Boolean)].filter(Boolean).join("\n\n---\n\n");
    if (docText.length < 3000) return { ok: false, error: "评估报告生成失败（输出过短）" };
    // 4. 打磨循环（强化：评审/修正——上下文累积）
    const polished = await polishEval(name, docText);
    mkdirSync(EVAL_DIR, { recursive: true });
    writeFileSync(docPath, polished.docText, "utf8");
    return { ok: true, filePath: docPath, summary: `已生成（${polished.docText.length} 字符——${coreFiles.length} 个核心文件——打磨 ${polished.rounds.length} 轮）` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 工具定义（skills.mjs 注册——tool.run 调用） */
export const tools = [
  {
    name: "evaluate_project",
    description:
      "生成项目全面评估报告（基于真实源码——8 维度评估 + 问题清单 + Top 5 改进——强化：分步评估 + 打磨循环）。读项目全部核心源码 → subagent 分步评估 → 汇总 → 打磨 → 存档 output/project-evals/项目·xxx-评估报告.md",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（personal_projects 配置中的 name，如 ai-career）" },
        force: { type: "boolean", description: "true 强制重新评估（默认读缓存）" },
      },
      required: ["project"],
    },
    run: evaluateProject,
  },
];

/** 工具路由（skill__project-eval__* 命名空间） */
export async function callSkillTool(name, args) {
  if (name === "skill__project-eval__evaluate_project") {
    return await evaluateProject(args || {});
  }
  return { error: `未知工具: ${name}` };
}

