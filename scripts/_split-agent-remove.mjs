// 拆分辅助：从 agent.mjs 删除已迁出的块（TOOLS/MCP/exec-utils/impl）
import { readFileSync, writeFileSync } from "node:fs";

let src = readFileSync("lib/agent.mjs", "utf8");
const lines = src.split("\n");

const find = (re, from = 0) => {
  const i = lines.findIndex((l, idx) => idx >= from && re.test(l));
  if (i < 0) throw new Error(`锚点未找到: ${re}`);
  return i;
};

// 1) TOOLS 数组：`export const TOOLS = [` → 独立 `  ];`
let s = find(/^export const TOOLS = \[/);
let e = find(/^\s+\];$/, s + 1);
console.log(`TOOLS: ${s + 1}-${e + 1}`);
lines.splice(s, e - s + 1);

// 2) MCP 块：`// ---------- MCP 客户端工具...` → ensureMcp 的 `}`（下一个 `// ---------- 工具执行` 前）
s = find(/^\/\/ ---------- MCP 客户端工具/);
e = find(/^\/\/ ---------- 工具执行/, s + 1) - 1;
// 去掉尾部空行
while (e > s && lines[e].trim() === "") e--;
console.log(`MCP: ${s + 1}-${e + 1}`);
lines.splice(s, e - s + 1);

// 3) exec-utils 块：`// 工具结果回填` → 下一个 `// 题目检测工具` 前
s = find(/^\/\/ 工具结果回填/);
e = find(/^\/\/ 题目检测工具/, s + 1) - 1;
while (e > s && lines[e].trim() === "") e--;
console.log(`exec-utils: ${s + 1}-${e + 1}`);
lines.splice(s, e - s + 1);

// 4) impl 块：`// 题目检测工具` → `// ---------- LLM 对话` 前
s = find(/^\/\/ 题目检测工具/);
e = find(/^\/\/ ---------- LLM 对话/, s + 1) - 1;
while (e > s && lines[e].trim() === "") e--;
console.log(`impl: ${s + 1}-${e + 1}`);
lines.splice(s, e - s + 1);

writeFileSync("lib/agent.mjs", lines.join("\n"), "utf8");
console.log(`agent.mjs 剩余 ${lines.length} 行`);