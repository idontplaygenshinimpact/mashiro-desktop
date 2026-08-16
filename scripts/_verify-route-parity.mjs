// 一次性校验：原版 widget.mjs（git HEAD）内联路由 vs 当前 lib/routes/*.mjs 注册路由
// 用法：git show HEAD:widget.mjs > _orig-widget.mjs && node scripts/_verify-route-parity.mjs
import { readFileSync, readdirSync } from "node:fs";

// ---- 1) 原版路由集（用与 _split-routes.mjs 相同的块提取逻辑） ----
const lines = readFileSync("_orig-widget.mjs", "utf8").split(/\r?\n/);
const orig = new Set();
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/if \(url\.pathname === "([^"]+)"\)(?: && req\.method === "([A-Z]+)")? \{/);
  if (!m) continue;
  // 块尾校验（与拆分器一致：return; + }）
  let end = -1;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j] === "  }" && lines[j - 1] === "    return;") { end = j; break; }
  }
  if (end < 0) { console.log("⚠ 块未闭合:", m[1]); continue; }
  orig.add(`${m[1]} ${m[2] || "any"}`);
  i = end;
}
console.log(`原版内联路由: ${orig.size} 条`);

// ---- 2) 当前注册路由集 ----
const cur = new Set();
for (const f of readdirSync("lib/routes")) {
  if (!f.endsWith(".mjs")) continue;
  const s = readFileSync(`lib/routes/${f}`, "utf8");
  const re = /route\("([^"]+)"(?:, "(GET|POST)")?, \(/g;
  let mm;
  while ((mm = re.exec(s))) cur.add(`${mm[1]} ${mm[2] || "any"}`);
}
console.log(`当前注册路由: ${cur.size} 条`);

// ---- 3) 差异 ----
const missing = [...orig].filter((r) => !cur.has(r));
const extra = [...cur].filter((r) => !orig.has(r) && !r.startsWith("/ "));
console.log("\n=== 原版有、现在缺 ===");
console.log(missing.length ? missing.join("\n") : "（无）");
console.log("\n=== 现在有、原版没有 ===");
console.log(extra.length ? extra.join("\n") : "（无）");
