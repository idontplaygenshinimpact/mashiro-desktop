// atomic-json.mjs 单测：原子写入 + 安全读取
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { writeJsonAtomic, readJsonSafe } = await import("../lib/atomic-json.mjs");

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "atomic-test-"));
}

test("writeJsonAtomic 写入后可读回", () => {
  const dir = tempDir();
  const file = path.join(dir, "a.json");
  writeJsonAtomic(file, { x: 1, list: [1, 2] });
  assert.deepEqual(readJsonSafe(file, null), { x: 1, list: [1, 2] });
  assert.ok(existsSync(file));
  assert.ok(!existsSync(file + ".tmp"), "写入后不应残留 tmp");
  rmSync(dir, { recursive: true, force: true });
});

test("readJsonSafe 文件缺失返回 fallback", () => {
  const dir = tempDir();
  const fb = { fallback: true };
  assert.deepEqual(readJsonSafe(path.join(dir, "nope.json"), fb), fb);
  rmSync(dir, { recursive: true, force: true });
});

test("readJsonSafe 损坏主文件时从 tmp 恢复", () => {
  const dir = tempDir();
  const file = path.join(dir, "b.json");
  writeJsonAtomic(file, { good: true });
  // 模拟写一半崩溃：主文件损坏 + tmp 残留完整数据
  writeFileSync(file, "{broken json", "utf8");
  writeFileSync(file + ".tmp", JSON.stringify({ tmp: "完整数据" }), "utf8");
  assert.deepEqual(readJsonSafe(file, null), { tmp: "完整数据" });
  rmSync(dir, { recursive: true, force: true });
});

test("readJsonSafe 全部损坏返回 fallback", () => {
  const dir = tempDir();
  const file = path.join(dir, "c.json");
  writeFileSync(file, "not json", "utf8");
  assert.deepEqual(readJsonSafe(file, { fb: 1 }), { fb: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("writeJsonAtomic 自动创建父目录", () => {
  const dir = tempDir();
  const file = path.join(dir, "deep", "nested", "d.json");
  writeJsonAtomic(file, { ok: 1 });
  assert.deepEqual(readJsonSafe(file, null), { ok: 1 });
  rmSync(dir, { recursive: true, force: true });
});
