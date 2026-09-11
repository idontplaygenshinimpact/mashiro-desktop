// 渲染产物一致性检查：源码内容变了但 bundle 没重建 → 拦下来（防止"改了源码但产物是旧的"的假回归）
// 用法：node scripts/check-renderer.mjs（npm run check:renderer）
//
// 口径（2026-09-11 改）：优先用**内容哈希**（desktop/renderer/bundle-hashes.json，由构建脚本写入）——
// 旧实现比 mtime，两个坑：注释级改动误报"未生效"（实测重建后字节完全相同）；
// 新鲜 clone / CI checkout 按路径顺序落盘，bundle 常早于源码 → CI 必然误红。
// 哈希文件不存在时（老 checkout）退回 mtime 比较，保持向后兼容。
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const BUNDLE = path.join(RENDERER, "app.bundle.js");
const SRC = ["app.js", "index.html", "style.css"].map((f) => path.join(RENDERER, f));
// 实时语音：speech-queue.mjs → speech-queue.bundle.js（window.SpeechQueue，panel.html 引用）
const SQ_BUNDLE = path.join(RENDERER, "speech-queue.bundle.js");
const SQ_SRC = path.join(RENDERER, "speech-queue.mjs");
const HASH_FILE = path.join(RENDERER, "bundle-hashes.json");

// 与 gen-renderer-hashes.mjs 同口径：先归一化行尾（CRLF/LF 随 checkout 变化，否则会误报"源码已改"）
const sha = (p) => createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex").slice(0, 16);
const stale = [];

try {
  if (!existsSync(BUNDLE)) stale.push("app.bundle.js 不存在");
  if (!existsSync(SQ_BUNDLE)) stale.push("speech-queue.bundle.js 不存在");

  let hashes = null;
  if (existsSync(HASH_FILE)) {
    try { hashes = JSON.parse(readFileSync(HASH_FILE, "utf8")); } catch { hashes = null; }
  }

  if (hashes?.app?.sources && hashes?.speechQueue?.sources) {
    for (const f of SRC) {
      const name = path.basename(f);
      if (!existsSync(f)) continue;
      if (hashes.app.sources[name] !== sha(f)) stale.push(`${name}（内容已改，app.bundle.js 需重建）`);
    }
    if (existsSync(SQ_SRC) && hashes.speechQueue.sources["speech-queue.mjs"] !== sha(SQ_SRC)) {
      stale.push("speech-queue.mjs（内容已改，speech-queue.bundle.js 需重建）");
    }
  } else if (existsSync(BUNDLE) && existsSync(SQ_BUNDLE)) {
    // 向后兼容：没有哈希记录时按 mtime 粗判
    const bm = statSync(BUNDLE).mtimeMs;
    for (const f of SRC) if (existsSync(f) && statSync(f).mtimeMs > bm) stale.push(path.basename(f));
    if (existsSync(SQ_SRC) && statSync(SQ_SRC).mtimeMs > statSync(SQ_BUNDLE).mtimeMs) stale.push("speech-queue.mjs");
  }
} catch (e) {
  console.error(`[check-renderer] 检查失败: ${e.message}`);
  process.exit(2);
}

if (stale.length) {
  console.error(`❌ 渲染源码与 bundle 不一致（${stale.join(", ")}）——改动尚未生效！`);
  console.error("   修复：npm run build:renderer && npm run build:speech-queue（或重启桌宠，会自动重建）");
  process.exit(1);
}
console.log("✅ app.bundle.js / speech-queue.bundle.js 与渲染源码内容一致");
process.exit(0);
