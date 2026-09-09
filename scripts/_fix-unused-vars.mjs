// 架构评审遗留收尾工单任务 3（第二轮）：剩余 unused 变量加 _ 前缀（不碰 import——上轮 import 处理已完成）
// 用法：node scripts/_fix-unused-vars.mjs
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const out = execSync("npx eslint . --format json", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const results = JSON.parse(out);
let removed = 0;

for (const r of results) {
  if (!r.messages?.length) continue;
  const lines = readFileSync(r.filePath, "utf8").split("\n");
  const changed = new Set();
  for (const m of r.messages) {
    if (m.ruleId !== "no-unused-vars") continue;
    const name = (m.message.match(/'([^']+)' is (?:defined|assigned)/) || [])[1];
    if (!name || name.startsWith("_")) continue;
    const lineIdx = m.line - 1;
    const line = lines[lineIdx] || "";
    if (line.includes("import")) continue; // import 已处理，跳过
    if (line.includes("++") || line.includes("--")) continue; // 自增/自减行跳过（改前缀会 no-undef）
    // 只改声明行（const/let/var/参数/解构）——用 eslint 报告的列号精确替换
    const col = m.column - 1;
    if (col >= 0 && col < line.length) {
      const before = line.slice(0, col);
      const after = line.slice(col);
      if (after.startsWith(name)) {
        lines[lineIdx] = before + "_" + after;
        changed.add(lineIdx);
        removed++;
      }
    }
  }
  if (changed.size) writeFileSync(r.filePath, lines.join("\n"), "utf8");
}
console.log(`已处理 ${removed} 处（unused 变量加 _ 前缀）`);
