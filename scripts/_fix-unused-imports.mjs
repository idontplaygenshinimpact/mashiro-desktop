// 架构评审遗留收尾工单任务 3：批量清理 unused imports / unused eslint-disable（基于 eslint --format json）
// 用法：node scripts/_fix-unused-imports.mjs
// 只处理生产代码（排除 tests/ scripts/ 一次性脚本）——no-unused-vars 的 import 变量删除；
// 非 import 的 unused 变量加 _ 前缀；unused eslint-disable 注释行删除。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const out = execSync("npx eslint . --format json", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const results = JSON.parse(out);
let removed = 0;

for (const r of results) {
  const file = r.filePath.replace(/\\/g, "/");
  if (file.includes("/node_modules/")) continue; // 本轮含 tests/scripts（上轮已处理生产代码）
  if (!r.messages?.length) continue;
  let src = readFileSync(r.filePath, "utf8");
  const lines = src.split("\n");
  const changed = new Set();

  for (const m of r.messages) {
    if (m.ruleId === "no-unused-vars" && /defined but never used|assigned a value but never used/.test(m.message)) {
      const name = (m.message.match(/'([^']+)' is (?:defined|assigned)/) || [])[1];
      if (!name) continue;
      const lineIdx = m.line - 1;
      const line = lines[lineIdx] || "";
      if (line.includes("import")) {
        // import 场景：named import 删该符号（只剩它则删整行）；default import 删整行
        // 注意：只替换花括号部分（保留 "import " 前缀——上轮 bug 把前缀吃掉导致 Parsing error）
        const named = line.match(/import\s*\{([^}]*)\}/);
        if (named) {
          const names = named[1].split(",").map((s) => s.trim()).filter(Boolean);
          const rest = names.filter((n) => n !== name);
          if (rest.length === 0) {
            lines[lineIdx] = "";
          } else {
            const brace = line.match(/\{([^}]*)\}/);
            lines[lineIdx] = line.replace(brace[0], `{ ${rest.join(", ")} }`);
          }
          changed.add(lineIdx);
          removed++;
        } else if (line.includes(`import ${name} from`) || line.includes(`import ${name},`)) {
          lines[lineIdx] = "";
          changed.add(lineIdx);
          removed++;
        }
      } else if (line.includes(`const ${name} =`) || line.includes(`let ${name} =`) || line.includes(`var ${name} =`)) {
        // 非 import 的 unused 变量：加 _ 前缀（仅行内声明处）
        lines[lineIdx] = line.replace(new RegExp(`\\b${name}\\b`), `_${name}`);
        changed.add(lineIdx);
        removed++;
      }
    } else if (m.ruleId === "unused-eslint-disable") {
      const lineIdx = m.line - 1;
      if ((lines[lineIdx] || "").includes("eslint-disable")) {
        lines[lineIdx] = "";
        changed.add(lineIdx);
        removed++;
      }
    }
  }
  if (changed.size) writeFileSync(r.filePath, lines.join("\n"), "utf8");
}
console.log(`已处理 ${removed} 处（生产代码 unused import/变量/eslint-disable）`);
