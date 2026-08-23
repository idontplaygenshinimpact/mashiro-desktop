// scripts/prepare-publish.mjs —— 生成发布用 package.json（临时覆盖，发布后 --restore）
// 为什么：npm 包与桌面版共用同一 package.json——
//   1) GitHub Packages 要求包名带 scope（@<用户名>/<包名>）
//   2) dependencies 含纯桌面依赖（语音/渲染/简历解析/通知），npm 包安装者
//      会装上 ~200MB 无关依赖 + 传递漏洞——发布版只保留 MCP 运行时白名单
// 用法：
//   node scripts/prepare-publish.mjs [--scope=<用户名>]   # 生成发布版（备份原文件）
//   node scripts/prepare-publish.mjs --restore            # 恢复原 package.json
// 发布后务必 --restore（发布脚本/流水线会自动恢复）
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "package.json");
const BACKUP = PKG + ".pubbak";

// MCP Server 运行时实际 import 的依赖白名单（lib/mail/fetch-page/review/mcp-server 顶层链）
const MCP_DEPS = [
  "@modelcontextprotocol/sdk",
  "@mozilla/readability",
  "imapflow",
  "jsdom",
  "playwright",
  "ts-fsrs",
  "zod",
];

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

if (process.argv.includes("--restore")) {
  if (!existsSync(BACKUP)) {
    console.error("❌ 无备份文件（package.json.pubbak）——无需恢复");
    process.exit(1);
  }
  writeFileSync(PKG, readFileSync(BACKUP, "utf8"));
  rmSync(BACKUP, { force: true });
  console.log("✅ package.json 已恢复");
  process.exit(0);
}

const scope = arg("scope");
if (existsSync(BACKUP)) {
  console.error("❌ 检测到残留备份——上次发布未恢复？先执行 --restore");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
writeFileSync(BACKUP, JSON.stringify(pkg, null, 2), "utf8");

if (scope) {
  if (!/^[a-zA-Z0-9-]+$/.test(scope)) {
    console.error(`❌ 非法 scope: ${scope}`);
    rmSync(BACKUP, { force: true });
    process.exit(1);
  }
  pkg.name = `@${scope}/${pkg.name.replace(/^@[^/]+\//, "")}`;
}

// 只保留白名单依赖（含它们的传递依赖由 npm 解析）
const all = { ...pkg.dependencies };
pkg.dependencies = {};
for (const d of MCP_DEPS) {
  // zod 原为 sdk 的传递依赖（mcp-server 直接 import 但未声明）——发布版显式声明，防严格解析失败
  pkg.dependencies[d] = all[d] || (d === "zod" ? "^3.24.0" : undefined);
  if (!pkg.dependencies[d]) delete pkg.dependencies[d];
}
const dropped = Object.keys(all).filter((d) => !MCP_DEPS.includes(d));

writeFileSync(PKG, JSON.stringify(pkg, null, 2), "utf8");
console.log(`✅ 发布版 package.json 已生成：name=${pkg.name}`);
console.log(`   保留 ${Object.keys(pkg.dependencies).length} 个运行时依赖，移除 ${dropped.length} 个桌面专用：${dropped.slice(0, 8).join(", ")}${dropped.length > 8 ? "…" : ""}`);
console.log("   发布完成后执行 node scripts/prepare-publish.mjs --restore 恢复");
