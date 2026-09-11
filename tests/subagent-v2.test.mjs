// Subagent v2 测试：agent loop（工具调用+循环+反馈）/ 工具执行 / 安全 / 兼容退化
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("subagent-v2");
mockLLM();
const { runSubagent } = await import("../lib/subagent.mjs");
const { toolReadFile, toolEditFile, safeResolve } = await import("../lib/subagent-tools.ts");

// 临时项目目录（工具白名单根）
const projDir = mkdtempSync(path.join(tmpdir(), "subagent-proj-"));
beforeEach(() => {
  writeFileSync(path.join(projDir, "doc.md"), "# 标题\n\n原始内容段落。\n\n## 章节二\n\n需要修正的内容。\n", "utf8");
});
after(() => { cleanupTempDb(dbDir); rmSync(projDir, { recursive: true, force: true }); });

// ---------- ① agent loop：LLM 先调工具再 final ----------
test("agent loop：TOOLCALL(read_file) → 执行回填 → final 输出", async () => {
  setLlmResponses(
    `TOOLCALL:${JSON.stringify({ name: "read_file", arguments: JSON.stringify({ file: "doc.md" }) })}`,
    "已读文件，任务完成。"
  );
  const r = await runSubagent({
    name: "读文件",
    task: "读 doc.md 并确认内容",
    tools: [{ type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } } }],
    root: projDir,
  });
  assert.equal(r.ok, true, "loop 完成");
  assert.ok(r.result.includes("任务完成"), "final 结果");
  assert.ok(r.rounds >= 2, "至少 2 轮（工具轮 + final 轮）");
});

// ---------- ② 工具执行：read/edit 真实文件 ----------
test("工具：read_file 带行号 + edit_file 唯一匹配替换", () => {
  const rd = toolReadFile(projDir, { file: "doc.md" });
  assert.equal(rd.ok, true);
  assert.ok(rd.content.includes("1 | # 标题"), "行号输出");
  const ed = toolEditFile(projDir, { file: "doc.md", old_string: "需要修正的内容。", new_string: "已修正的内容。" });
  assert.equal(ed.ok, true, "edit 成功");
  assert.ok(readFileSync(path.join(projDir, "doc.md"), "utf8").includes("已修正的内容"), "文件已改");
});

// ---------- ③ 安全：路径穿越 / 超限 / 多匹配 ----------
test("安全：路径穿越拒绝 / 多匹配 edit 拒绝 / 超限拒绝", () => {
  assert.equal(safeResolve(projDir, "../outside.txt"), null, "路径穿越拒绝");
  const esc = toolReadFile(projDir, { file: "../outside.txt" });
  assert.ok(esc.error, "穿越 read 拒绝");
  // 多匹配：写一个重复内容再 edit
  writeFileSync(path.join(projDir, "dup.md"), "重复内容\n重复内容\n", "utf8");
  const multi = toolEditFile(projDir, { file: "dup.md", old_string: "重复内容", new_string: "改" });
  assert.ok(String(multi.error || "").includes("匹配 2 处"), "多匹配拒绝");
  // 超限：写大文件再 read
  writeFileSync(path.join(projDir, "big.md"), "x".repeat(60 * 1024), "utf8");
  const big = toolReadFile(projDir, { file: "big.md" });
  assert.ok(String(big.error || "").includes("过大"), "超限拒绝");
});

// ---------- ④ 兼容：无 tools 退化为单次 ----------
test("兼容：无 tools → 退化为单次调用（v1 行为）", async () => {
  setLlmResponses("单次输出结果");
  const r = await runSubagent({ name: "单次", task: "直接输出" });
  assert.equal(r.ok, true);
  assert.equal(r.result, "单次输出结果");
  assert.equal(r.rounds, undefined, "无 rounds（v1 路径）");
});

// ---------- ⑤ 打磨循环：修正者用 edit_file（输出量 = 差距大小） ----------
test("打磨循环：修正者 read → edit → final（不重写全文）", async () => {
  setLlmResponses(
    `TOOLCALL:${JSON.stringify({ name: "read_file", arguments: JSON.stringify({ file: "doc.md" }) })}`,
    `TOOLCALL:${JSON.stringify({ name: "edit_file", arguments: JSON.stringify({ file: "doc.md", old_string: "需要修正的内容。", new_string: "修正后的内容。" }) })}`,
    "修正完成。"
  );
  const r = await runSubagent({
    name: "修正者",
    task: "修正 doc.md 中'需要修正的内容'为'修正后的内容'",
    system: "你是文档修正者：先 read_file 定位差距章节 → edit_file 逐章修正 → 最后输出总结。不要重写全文。",
    tools: [
      { type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } } },
      { type: "function", function: { name: "edit_file", description: "编辑文件", parameters: { type: "object", properties: { file: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file", "old_string", "new_string"] } } },
    ],
    root: projDir,
  });
  assert.equal(r.ok, true, "打磨完成");
  assert.ok(readFileSync(path.join(projDir, "doc.md"), "utf8").includes("修正后的内容"), "文件已修正");
  assert.ok(r.rounds >= 3, "read + edit + final 三轮");
});
