// 记录渲染源码的内容哈希（供 check-renderer.mjs 判断"改了源码但没重建 bundle"）
// 用法：node scripts/gen-renderer-hashes.mjs app            # app.bundle.js 的源码组
//       node scripts/gen-renderer-hashes.mjs speech-queue   # speech-queue.bundle.js 的源码组
//
// 为什么不用 mtime（2026-09-11 改）：旧实现比"源码 mtime > bundle mtime"，两个坑——
//   1) 只有注释改动的源码会让它误报"改动尚未生效"（实测 speech-queue.mjs 重建后产物字节完全相同）；
//   2) 新鲜 clone / CI checkout 按路径顺序落盘，bundle 常写在源码之前 → 在 CI 上必然误红。
// 内容哈希与构建顺序、时间戳、esbuild 版本都无关，只回答"这份 bundle 是不是由当前源码构建的"。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const HASH_FILE = path.join(RENDERER, "bundle-hashes.json");

const GROUPS = {
  app: ["app.js", "index.html", "style.css"],
  "speech-queue": ["speech-queue.mjs"],
};

const group = String(process.argv[2] || "").trim();
const files = GROUPS[group];
if (!files) {
  console.error(`用法：node scripts/gen-renderer-hashes.mjs ${Object.keys(GROUPS).join("|")}`);
  process.exit(2);
}

// 行尾归一化后再哈希：仓库在 Windows 上 CRLF/LF 会随 checkout 变化，若直接哈希原始字节，
// 一次 checkout 就能造成"源码已改"的误报（同一个坑的另一种形态，2026-09-11 实测踩到）。
const sha = (p) => createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex").slice(0, 16);
const key = group === "app" ? "app" : "speechQueue";

/** @type {Record<string, any>} */
let data = { note: "自动生成，请勿手改——由 npm run build:renderer / build:speech-queue 更新" };
if (existsSync(HASH_FILE)) {
  try { data = { ...data, ...JSON.parse(readFileSync(HASH_FILE, "utf8")) }; } catch { /* 损坏则重建 */ }
}
data[key] = { sources: Object.fromEntries(files.map((f) => [f, sha(path.join(RENDERER, f))])) };
writeFileSync(HASH_FILE, JSON.stringify(data, null, 2) + "\n");
console.log(`[gen-renderer-hashes] ${group}: ${files.join(", ")}`);
