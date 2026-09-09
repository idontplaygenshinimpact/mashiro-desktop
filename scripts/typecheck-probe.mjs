// TS 增量收益工单任务 D：类型检查探针——验证 checkJs/strict 配置未被意外放宽
// 原理：临时生成含故意类型错误的文件 → 跑 tsc → 断言退出码非 0 且错误含预期行
// 探针失败 = 门禁红（tsconfig 被放宽或 tsc 失效）——防"配置被误删导致假绿"
// try/finally 保证临时文件清理（即使断言失败）
import { writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const probeFile = path.join(root, "lib", "__typecheck-probe.mjs");

try {
  // 故意类型错误：string 赋给 number（依赖全局 checkJs——不加 @ts-check，否则 checkJs:false 时仍被检查）
  writeFileSync(probeFile, `/** @type {number} */\nconst __probe = "not-a-number";\n`, "utf8");
  const r = spawnSync("npx", ["tsc", "--noEmit"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === 0) {
    // 用 throw 而非 process.exit——exit 在 try 内硬终止会跳过 finally（临时文件残留）
    throw new Error("探针失败：故意类型错误未被 tsc 捕获——checkJs 配置可能被放宽（tsconfig.json 的 checkJs/allowJs）");
  }
  if (!out.includes("__typecheck-probe.mjs") || !out.includes("TS2322")) {
    throw new Error(`探针失败：tsc 报错但非预期（预期 TS2322 @ __typecheck-probe.mjs，实际：${out.slice(0, 300)}）`);
  }
  console.log("✅ 类型探针通过：checkJs 生效（故意错误被 TS2322 捕获）");
} finally {
  try { rmSync(probeFile, { force: true }); } catch { /* ignore */ }
}
