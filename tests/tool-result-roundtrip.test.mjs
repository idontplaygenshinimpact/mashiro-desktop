// >8K 工具结果落盘/回读链路回归护栏（闭环清查）：
// 写端 exec-utils.toolResultContent（认 MIANSHI_DATA_DIR）与读端 impl-misc.toolReadToolResult
// 必须口径一致——原先读端硬编码仓库根 data/，打包版（MIANSHI_DATA_DIR=userData）下写进去读不回来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("工具结果落盘 → 回读：MIANSHI_DATA_DIR 重定向后仍可读（打包版链路）", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mianshi-toolres-"));
  const prev = process.env.MIANSHI_DATA_DIR;
  process.env.MIANSHI_DATA_DIR = dataDir;
  try {
    const { toolResultContent } = await import("../lib/tools/exec-utils.mjs");
    const { toolReadToolResult } = await import("../lib/tools/impl-misc.mjs");

    // 造一个 >8K 的结果 → 应落盘到 <MIANSHI_DATA_DIR>/tool_results/
    const big = { rows: Array.from({ length: 400 }, (_, i) => `第 ${i} 行内容 padding padding padding`) };
    const json = await toolResultContent(big, "call-abc12345");
    const parsed = JSON.parse(json);
    assert.equal(parsed._truncated, true, "超长结果标记 _truncated");
    assert.ok(String(parsed._file).startsWith("data/tool_results/"), `_file 形态：${parsed._file}`);

    const files = readdirSync(path.join(dataDir, "tool_results"));
    assert.equal(files.length, 1, "落盘到 MIANSHI_DATA_DIR 下的 tool_results");
    const fname = files[0];

    // 读端：写端记录的 _file 形态（data/tool_results/<name>）与裸文件名都要能读回
    const byRecorded = await toolReadToolResult(String(parsed._file));
    assert.equal(byRecorded.ok, true, `按 _file 读回应成功：${JSON.stringify(byRecorded).slice(0, 120)}`);
    assert.ok(String(byRecorded.content).includes("第 399 行"), "内容完整（含末行）");
    const byBare = await toolReadToolResult(fname);
    assert.equal(byBare.ok, true, "按裸文件名读回应成功");
  } finally {
    if (prev === undefined) delete process.env.MIANSHI_DATA_DIR;
    else process.env.MIANSHI_DATA_DIR = prev;
  }
});

test("目录穿越仍被拒绝（只允许 tool_results 目录内）", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mianshi-toolres-"));
  const prev = process.env.MIANSHI_DATA_DIR;
  process.env.MIANSHI_DATA_DIR = dataDir;
  try {
    writeFileSync(path.join(dataDir, "secret.txt"), "不该被读到", "utf8");
    const { toolReadToolResult } = await import("../lib/tools/impl-misc.mjs");
    const r1 = await toolReadToolResult("../secret.txt");
    assert.ok(r1.error && r1.error.includes("拒绝读取"), `穿越被拒：${JSON.stringify(r1)}`);
    const r2 = await toolReadToolResult("data/tool_results/../secret.txt");
    assert.ok(r2.error, "相对穿越被拒");
    const r3 = await toolReadToolResult("tool_results/nope.json");
    assert.ok(r3.error && r3.error.includes("文件不存在"), "不存在时如实报错");
  } finally {
    if (prev === undefined) delete process.env.MIANSHI_DATA_DIR;
    else process.env.MIANSHI_DATA_DIR = prev;
  }
});
