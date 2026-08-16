import { readFileSync, readdirSync } from "node:fs";

const show = (label, lines) => {
  console.log(`\n=== ${label} ===`);
  for (const l of lines) console.log(l);
};

// main.mjs 后半结构
const main = readFileSync("desktop/main.mjs", "utf8").split("\n");
const marks = [];
main.forEach((l, i) => {
  const t = l.trim();
  if (/^\/\/ [-=]{4,}/.test(t) || (t.startsWith("// ") && t.length > 14 && /^\s*\/\/ .+（|^\s*\/\/ [^ ]+$|：【|：$/.test(t))) marks.push(`${i + 1}: ${t.slice(0, 60)}`);
});
show("main.mjs 后半区段", marks.filter((m) => parseInt(m) > 400 || true).slice(-35));

// agent.mjs 工具函数清单（export async function/const ... = tool 定义）
const agent = readFileSync("lib/agent.mjs", "utf8").split("\n");
const tools = [];
agent.forEach((l, i) => {
  const m = l.match(/^export (async )?function (\w+)/) || l.match(/^async function (\w+)/) || l.match(/const (\w+) = \{/);
  if (m && !l.includes("//")) {
    const nm = m[1] || m[2];
    const tag = /^export /.test(l) ? "" : " (内部)";
    tools.push(`${i + 1}: ${nm}${tag}`);
  }
});
show("agent.mjs 顶层函数/常量", tools.slice(0, 60));

// discover.mjs 依赖
const disc = readFileSync("discover.mjs", "utf8");
show("discover.mjs lib 引用数", [`from "./lib/ 出现次数: ${(disc.match(/from "\.\/lib\//g) || []).length}`, `顶行 import: ${disc.split("\n").filter((l) => l.includes("from \"./lib/")).slice(0, 12).join(" | ")}`]);

// lib/ 模块 ↔ 测试覆盖对照
const libFiles = readdirSync("lib").filter((f) => f.endsWith(".mjs"));
const tests = readdirSync("tests").filter((f) => f.endsWith(".test.mjs"));
const libNoTest = [];
for (const f of libFiles) {
  const base = f.replace(".mjs", "");
  if (f.startsWith("routes/")) continue;
  const has = tests.some((t) => t.startsWith(base + ".") || t === base + ".test.mjs" || (["db", "widget-core", "router"].includes(base) && t.startsWith(base)));
  if (!has) libNoTest.push(f);
}
show("lib/*.mjs 无同名/前缀测试", libNoTest);

// test-module.mjs 覆盖
const tm = readFileSync("scripts/test-module.mjs", "utf8");
const mods = [...tm.matchAll(/^\s{2}(\w+): \[([^\]]+)\]/gm)].map((m) => m[1]);
show("test-module.mjs 模块数", [`${mods.length} 个: ${mods.join(", ")}`]);