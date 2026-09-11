// 渲染产物新鲜度（内容哈希口径）：源码内容改了但 bundle 没重建 → 这里红
// 背景（2026-09-11）：旧的 check-renderer.mjs 比 mtime，会因注释级改动/CI checkout 顺序误红，
// 于是改成「构建时写入源码内容哈希，检查时比对」。本测试保证哈希记录本身不过期（不依赖跑构建）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const HASH_FILE = path.join(RENDERER, "bundle-hashes.json");
const sha = (p) => createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex").slice(0, 16);

test("渲染产物新鲜度：源码内容哈希与 bundle-hashes.json 记录一致", () => {
  assert.ok(existsSync(HASH_FILE), "bundle-hashes.json 存在（由 npm run build:renderer 生成）");
  const hashes = JSON.parse(readFileSync(HASH_FILE, "utf8"));

  // 注意：app.bundle.js 不入库（构建产物，CI 里由 build:renderer 生成，且构建步骤在测试之后），
  // 所以这里**只校验「源码内容 ↔ 记录哈希」**——bundle 缺失在 fresh clone 上是正常状态，不能断言存在。
  // （2026-09-11 CI 实测踩到：断言 app.bundle.js 存在 → fresh clone 上必红）
  const groups = [
    { key: "app", sources: ["app.js", "index.html", "style.css"] },
    { key: "speechQueue", sources: ["speech-queue.mjs"] },
  ];
  for (const g of groups) {
    assert.ok(hashes[g.key]?.sources, `哈希记录含 ${g.key} 组`);
    for (const name of g.sources) {
      const p = path.join(RENDERER, name);
      if (!existsSync(p)) continue;
      assert.equal(
        hashes[g.key].sources[name],
        sha(p),
        `${name} 内容变了但 bundle 未重建 —— 跑 npm run build:renderer && npm run build:speech-queue`,
      );
    }
  }
});
