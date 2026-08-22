// 依赖分析：扫描 lib/ + 顶层入口，构建 import 依赖矩阵，找出孤岛/单向模块
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const TARGETS = [
  ...readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`),
  ...readdirSync(path.join(ROOT, "lib", "platforms")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/platforms/${f}`),
  "widget.mjs", "discover.mjs", "run.mjs", "mcp-server.mjs", "config.mjs",
  "desktop/main.mjs", "desktop/preload.js", "desktop/renderer/app.js", "desktop/renderer/panel.js",
  "desktop/foreground.mjs",
];

const imports = {};   // file -> [dep]
const importedBy = {}; // dep -> [file]

function norm(f) {
  return f.replace(/\\/g, "/");
}

// 把相对 import 路径归一化为目标文件 key（lib/x.mjs / x.mjs / desktop/x）
function resolveKey(fromFile, rel) {
  const from = path.join(ROOT, norm(fromFile));
  const target = path.resolve(path.dirname(from), rel);
  const relPath = path.relative(ROOT, target).replace(/\\/g, "/");
  return relPath;
}

for (const f of TARGETS) {
  const full = path.join(ROOT, norm(f));
  if (!statSync(full, { throwIfNoEntry: false })) continue;
  const src = readFileSync(full, "utf8");
  const deps = new Set();
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    const p = m[1];
    if (p.startsWith(".")) deps.add(resolveKey(f, p));
  }
  // 动态 import 也统计（排除注释里的样例代码：仅匹配 import( 出现在非注释行——用简化启发式：行首非 // 或 *）
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const m of line.matchAll(/import\(["']([^"']+)["']\)/g)) {
      const p = m[1];
      if (p.startsWith(".")) deps.add(resolveKey(f, p));
    }
  }
  imports[f] = [...deps].sort();
  for (const d of deps) {
    if (!importedBy[d]) importedBy[d] = [];
    importedBy[d].push(f);
  }
}

console.log("=== 依赖矩阵（file -> imports） ===");
for (const [f, deps] of Object.entries(imports)) {
  if (deps.length) console.log(`${f}\n  -> ${deps.join(", ")}`);
}

console.log("\n=== 反向依赖（谁引用我） ===");
for (const [d, users] of Object.entries(importedBy)) {
  console.log(`${d} <= ${users.join(", ")}`);
}

console.log("\n=== 疑似孤岛分析 ===");
for (const f of TARGETS) {
  const deps = imports[f] || [];
  const users = (importedBy[f] || []);
  // 入口文件（顶层/desktop main）不算孤岛
  const isEntry = f === "widget.mjs" || f === "discover.mjs" || f === "run.mjs" || f === "mcp-server.mjs" || f === "desktop/main.mjs";
  // 排除 lib 内部相对引用后，检查是否被业务模块使用
  const isLeaf = deps.length === 0; // 不依赖任何其他模块
  const isOrphan = !isEntry && users.length === 0; // 无任何引用
  if (isOrphan) console.log(`⚠️ 无引用（可能孤岛）: ${f}`);
  if (isLeaf && !isOrphan) console.log(`📄 纯叶子模块（无内部依赖）: ${f} <- 被 ${users.length} 处引用: ${users.join(", ")}`);
}

console.log("\n=== 入口直接引用的模块 ===");
for (const f of ["widget.mjs", "discover.mjs", "run.mjs", "mcp-server.mjs", "desktop/main.mjs", "desktop/renderer/panel.js", "desktop/renderer/app.js"]) {
  console.log(`${f} -> ${(imports[f] || []).join(", ")}`);
}
