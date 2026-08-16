// 拆分辅助：从 agent.mjs 提取工具实现函数 → lib/tools/impl.mjs
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("lib/agent.mjs", "utf8").split("\n");

// 要提取的函数（名称 → 起始行模式）。全部为顶层 async function，以 "}\n\n// " 或 "}\n\n" 或 "}\n\nexport" 结尾
const FUNCS = [
  ["toolDetectQuestions", /^async function toolDetectQuestions/],
  ["toolGetStudyPlan", /^async function toolGetStudyPlan/],
  ["toolGetRecentOutputs", /^async function toolGetRecentOutputs/],
  ["toolRecordInterviewTopics", /^async function toolRecordInterviewTopics/],
  ["toolSearchPosts", /^export async function toolSearchPosts/],
  ["toolFetchPage", /^async function toolFetchPage/],
  ["toolGetMemoryExpanded", /^async function toolGetMemoryExpanded/],
  ["toolBrowse", /^async function toolBrowse/],
  ["toolSolveQuestion", /^async function toolSolveQuestion/],
  ["toolReadToolResult", /^export async function toolReadToolResult/],
  ["toolRemember", /^async function toolRemember/],
];

const blocks = [];
for (const [name, re] of FUNCS) {
  const start = src.findIndex((l) => re.test(l));
  if (start < 0) throw new Error(`函数 ${name} 未找到`);
  // 找函数体结束：从 start 开始，大括号平衡（跳过注释/字符串近似：按行统计 { }，含模板串的风险可接受，这些函数无模板大括号）
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const line = src[i];
    // 粗略按行计括号：去掉字符串字面量里的括号（单双引号与模板串简单处理）
    const stripped = line.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "").replace(/`[^`]*`/g, "");
    depth += (stripped.match(/\{/g) || []).length;
    depth -= (stripped.match(/\}/g) || []).length;
    if (depth <= 0 && i > start) { end = i; break; }
  }
  if (end < 0) throw new Error(`函数 ${name} 未闭合`);
  blocks.push({ name, start, end, text: src.slice(start, end + 1).join("\n") });
  console.log(`${name}: 行 ${start + 1}-${end + 1}（${end - start + 1} 行）`);
}

// 组装 impl.mjs
const head = `// lib/tools/impl.mjs —— 工具实现（纵向拆分：从 lib/agent.mjs 迁出）
// 每个工具函数只依赖 lib 外部模块（memory/ai/fetch-page/career/study/...），
// 由 lib/agent.mjs 的 executeTool 分发调用；结果回填由 agent 统一处理
import { config } from "../config.mjs";
import { fetchPage, assertPublicUrl } from "../fetch-page.mjs";
import { solveQuestion, detectQuestions } from "../ai.mjs";
import { memory } from "../memory.mjs";
import { wrapUntrusted } from "../prompt-guard.mjs";
import { getCareerProfile } from "../career.mjs";

`;
const body = blocks.map((b) => b.text).join("\n\n");
writeFileSync("lib/tools/impl.mjs", head + body + "\n", "utf8");
console.log(`impl.mjs 完成（${body.split("\n").length} 行函数体）`);

// 记录行范围供 agent.mjs 删除
const ranges = blocks.map((b) => [b.start, b.end]);
writeFileSync("scripts/_agent-impl-ranges.json", JSON.stringify(ranges), "utf8");
console.log("行范围已存 scripts/_agent-impl-ranges.json");
