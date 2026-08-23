// scripts/publish-gh-packages.mjs —— 本地手动发布到 GitHub Packages（npm.pkg.github.com）
// 流程：prepare-publish（scope + 依赖瘦身）→ npm publish → restore
// 用法：node scripts/publish-gh-packages.mjs [版本号]
// 前置：gh CLI 已登录且 token 有 write:packages 权限（gh auth refresh -h github.com -s write:packages）
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1) gh 认证用户名 + token（packages 发布权限）
const who = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
const token = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
if (who.status !== 0 || token.status !== 0 || !token.stdout.trim()) {
  console.error("❌ 需要 gh CLI 已登录且 token 有 write:packages 权限");
  process.exit(1);
}
const scope = String(who.stdout.trim());

// 2) 生成发布版 package.json（scope + 依赖白名单）
const prep = spawnSync("node", ["scripts/prepare-publish.mjs", `--scope=${scope}`], { encoding: "utf8", cwd: ROOT });
console.log(prep.stdout || prep.stderr);
if (prep.status !== 0) process.exit(1);

// 3) 发布（NODE_AUTH_TOKEN 认证）
const args = process.argv[2] ? ["publish", process.argv[2]] : ["publish"];
const r = spawnSync("npm", [...args, "--registry=https://npm.pkg.github.com/"], {
  encoding: "utf8",
  cwd: ROOT,
  env: { ...process.env, NODE_AUTH_TOKEN: String(token.stdout.trim()) },
});
console.log(`${r.stdout || ""}${r.stderr || ""}`.slice(-600));

// 4) 恢复（无论成败）
const rest = spawnSync("node", ["scripts/prepare-publish.mjs", "--restore"], { encoding: "utf8", cwd: ROOT });
console.log(rest.stdout || rest.stderr || "");

if (r.status === 0) {
  console.log(`✅ 已发布到 GitHub Packages：@${scope}/mashiro-mcp`);
} else {
  console.error("❌ 发布失败（package.json 已恢复）");
  process.exit(1);
}
