// 拆分辅助：从 agent.mjs 提取 TOOLS 数组 → lib/tools/schemas.mjs
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("lib/agent.mjs", "utf8").split("\n");

// TOOLS 数组：从 "export const TOOLS = [" 到 "];"（第 31 行开始，到第 467 行 "  ];" 结束）
const startIdx = src.findIndex((l) => l.includes("export const TOOLS = ["));
const endIdx = src.findIndex((l, i) => i > startIdx && l.trim() === "];");
if (startIdx < 0 || endIdx < 0) throw new Error(`TOOLS 定位失败: ${startIdx}/${endIdx}`);

const head = `// lib/tools/schemas.mjs —— 工具 schema 定义（纵向拆分：从 lib/agent.mjs 迁出）
// 纯数据模块（零依赖）：DeepSeek function calling 格式的工具清单，供 agent 循环与 MCP server 复用
`;
const body = src.slice(startIdx, endIdx + 1).join("\n");
writeFileSync("lib/tools/schemas.mjs", `${head}\n${body}\n`, "utf8");
console.log(`schemas.mjs: 行 ${startIdx + 1}-${endIdx + 1}（${endIdx - startIdx + 1} 行）→ lib/tools/schemas.mjs`);
