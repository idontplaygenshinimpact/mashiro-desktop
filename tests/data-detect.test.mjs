// 数据目录自动探测单测（Phase MCP 分发：装包即连零配置）
// 注意：开发机项目 data/ 有真实库——用 MIANSHI_DATA_DIR env 注入控制探测优先级
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { candidateDataDirs, detectDataDir, resolveDataDir } = await import("../lib/data-detect.mjs");
const dirs = [];
function tmp(seed = false) {
  const d = mkdtempSync(path.join(tmpdir(), "dd-"));
  dirs.push(d);
  if (seed) writeFileSync(path.join(d, "mianshi.db"), "x", "utf8");
  return d;
}
test.after(() => {
  process.env.MIANSHI_DATA_DIR = "";
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("候选目录：env 最优先 + extra 追加 + 去重保序", () => {
  const old = process.env.MIANSHI_DATA_DIR;
  process.env.MIANSHI_DATA_DIR = "/env/data";
  try {
    const c = candidateDataDirs(["/extra/a", "/extra/a"]);
    assert.equal(c[0], "/env/data", "env 最优先");
    assert.ok(c.includes("/extra/a"), "extra 在候选内");
    assert.equal(new Set(c).size, c.length, "去重");
  } finally {
    process.env.MIANSHI_DATA_DIR = old;
  }
});

test("detectDataDir：env 指向含库目录 → 命中（env 优先于源码 data/）", () => {
  const seeded = tmp(true);
  const old = process.env.MIANSHI_DATA_DIR;
  process.env.MIANSHI_DATA_DIR = seeded;
  try {
    assert.equal(detectDataDir(), seeded, "env 命中有库目录");
  } finally {
    process.env.MIANSHI_DATA_DIR = old;
  }
});

test("detectDataDir：env 指向空目录 → 跳过，回落探测其他候选（mock 候选目录，不依赖开发机 data/——CI 无源码 data/）", () => {
  const empty = tmp(false);
  const mockCandidate = tmp(true); // mock 候选目录（含 mianshi.db）——CI 上源码 data/ 不存在（gitignore），测试不依赖开发机路径
  const old = process.env.MIANSHI_DATA_DIR;
  process.env.MIANSHI_DATA_DIR = empty;
  try {
    const hit = detectDataDir([mockCandidate]);
    assert.ok(hit && hit !== empty, `跳过空 env 目录，命中其他候选: ${hit}`);
    assert.ok(existsSync(path.join(hit, "mianshi.db")), "命中目录含库");
  } finally {
    process.env.MIANSHI_DATA_DIR = old;
  }
});

test("resolveDataDir：env 有库即用；返回始终是候选之一（不崩溃）", () => {
  const seeded = tmp(true);
  const old = process.env.MIANSHI_DATA_DIR;
  process.env.MIANSHI_DATA_DIR = seeded;
  try {
    assert.equal(resolveDataDir(), seeded);
  } finally {
    process.env.MIANSHI_DATA_DIR = old;
  }
  // 无 env：结果必须是候选列表之一（本机=源码 data/；CI=~/.mashiro/data）
  const c = candidateDataDirs();
  assert.ok(c.includes(resolveDataDir()), "返回路径在候选列表内");
});