// scripts/publish-gh-packages.mjs —— 发布到 GitHub Packages（npm.pkg.github.com）
// GitHub Packages 的 npm 源要求包名带 scope（@<用户名>/<包名>）——与 npmjs 的
// 无 scope 包名（mashiro-mcp）并存。本脚本：
//   1. 读 package.json，生成带 scope 的临时副本（scope = gh 认证用户名）
//   2. npm publish 到 npm.pkg.github.com（认证用 gh auth token）
//   3. 恢复原 package.json（不污染 npmjs 发布）
// 用法：node scripts/publish-gh-packages.mjs [版本号]
// 前置：gh CLI 已登录且 token 有 write:packages 权限
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "package.json");
const BACKUP = PKG + ".ghbak";

// 1) gh 认证用户名 + token（packages 发布权限）
const who = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" });
const token = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
if (who.status !== 0 || token.status !== 0 || !token.stdout.trim()) {
  console.error("❌ 需要 gh CLI 已登录且 token 有 write:packages 权限（gh auth login 后重试）");
  process.exit(1);
}
const scope = String(who.stdout.trim());
const ghToken = String(token.stdout.trim());
console.log(`GitHub 用户：${scope}`);

// 2) 备份并改写 package.json（name → @scope/name，去掉 npm overrides 无关字段不动）
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
if (existsSync(BACKUP)) {
  console.error("❌ 检测到残留备份（上次发布中断？）请手动检查 package.json.ghbak");
  process.exit(1);
}
writeFileSync(BACKUP, JSON.stringify(pkg, null, 2), "utf8");
pkg.name = `@${scope}/${pkg.name}`;
// GitHub Packages 只读包内 .npmrc 不生效——认证走环境变量 NODE_AUTH_TOKEN
writeFileSync(PKG, JSON.stringify(pkg, null, 2), "utf8");

// 3) 发布（NODE_AUTH_TOKEN 是 npm 发布到需要认证 registry 的标准方式）
const args = process.argv[2] ? ["publish", process.argv[2]] : ["publish"];
const r = spawnSync("npm", [...args, "--registry=https://npm.pkg.github.com/"], {
  encoding: "utf8",
  cwd: ROOT,
  env: { ...process.env, NODE_AUTH_TOKEN: ghToken },
});
const out = `${r.stdout || ""}${r.stderr || ""}`;
console.log(out.slice(-800));

// 4) 恢复 package.json（无论成败）
writeFileSync(PKG, JSON.stringify(pkg, null, 2).replace(`"name": "@${scope}/`, `"name": "`), "utf8");
try { writeFileSync(PKG, JSON.stringify({ ...JSON.parse(readFileSync(BACKUP, "utf8")) }, null, 2), "utf8"); } catch { /* ignore */ }
try { spawnSync("rm", [BACKUP], { shell: true }); } catch { /* ignore */ }

if (r.status === 0) {
  console.log(`✅ 已发布到 GitHub Packages：@${scope}/${pkg.name}@${pkg.version}`);
  console.log(`   安装：npm install @${scope}/${pkg.name} --registry=https://npm.pkg.github.com/`);
} else {
  console.error("❌ 发布失败（package.json 已恢复）");
  process.exit(1);
}
