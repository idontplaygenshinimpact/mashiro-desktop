// 渲染产物一致性检查：app.js/index.html/style.css 比 app.bundle.js 新 → 提醒构建
// 用法：node scripts/check-renderer.mjs（npm run check:renderer）
// 可在 npm test / CI 前调用，防止"改了源码但 bundle 是旧的"导致的假回归
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const BUNDLE = path.join(RENDERER, "app.bundle.js");
const SRC = ["app.js", "index.html", "style.css"].map((f) => path.join(RENDERER, f));

const stale = [];
try {
  if (!existsSync(BUNDLE)) stale.push("app.bundle.js 不存在");
  else {
    const bm = statSync(BUNDLE).mtimeMs;
    for (const f of SRC) {
      if (existsSync(f) && statSync(f).mtimeMs > bm) stale.push(path.basename(f));
    }
  }
} catch (e) {
  console.error(`[check-renderer] 检查失败: ${e.message}`);
  process.exit(2);
}

if (stale.length) {
  console.error(`❌ 渲染源码比 bundle 新（${stale.join(", ")}）——改动尚未生效！`);
  console.error("   修复：npm run build:renderer（或重启桌宠，会自动重建）");
  process.exit(1);
}
console.log("✅ app.bundle.js 与渲染源码一致");
process.exit(0);
