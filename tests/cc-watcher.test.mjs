// cc-watcher 单测（Phase 事件驱动内核 W2）：mock jsonl 临时目录，增量幂等
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { parseCcLine, createCcWatcher } = await import("../lib/adapters/cc-watcher.mjs");

const dirs = [];
function tmpDir() {
  const d = mkdtempSync(path.join(tmpdir(), "cc-watch-"));
  dirs.push(d);
  return d;
}
function line(type, extra = {}) {
  return JSON.stringify({
    type, sessionId: "sess1", version: "1.0.52",
    message: { role: type === "user" ? "user" : "assistant", content: [], ...extra },
    timestamp: new Date().toISOString(),
  });
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ---------- 行解析 ----------
test("parseCcLine：assistant text → assistant_reply（replyLen 元数据）", () => {
  const l = line("assistant", { content: [{ type: "text", text: "你好世界" }, { type: "text", text: "abcd" }] });
  const r = parseCcLine(l);
  assert.equal(r.type, "assistant_reply");
  assert.equal(r.payload.replyLen, 4 + 4, "text 块总长（中文按字符）");
});

test("parseCcLine：tool_use → tool_use（工具名，不落 input 内容）", () => {
  const l = line("assistant", { content: [], tool_use: { id: "toolu_1", name: "Read", input: { file_path: "秘密文件" } } });
  const r = parseCcLine(l);
  assert.equal(r.type, "tool_use");
  assert.equal(r.payload.tool, "Read");
  assert.ok(!JSON.stringify(r.payload).includes("秘密文件"), "不落正文内容");
});

test("parseCcLine：坏行/空行/非目标行 → null", () => {
  assert.equal(parseCcLine(""), null);
  assert.equal(parseCcLine("not-json"), null);
  assert.equal(parseCcLine(line("user", { content: [{ type: "text", text: "用户的话" }] })), null, "user 消息不产出事件");
  assert.equal(parseCcLine(null), null);
});

// ---------- 增量幂等 ----------
test("首次扫描只建偏移（bootstrapped，重启不刷屏）", () => {
  const d = tmpDir();
  writeFileSync(path.join(d, "s1.jsonl"), line("assistant", { content: [{ type: "text", text: "旧回复" }] }) + "\n", "utf8");
  const events = [];
  const w = createCcWatcher({ ccDir: d, emit: (e) => events.push(e), idleTimeoutMs: 30000 });
  const r = w.tick();
  assert.equal(r.bootstrapped, true);
  assert.equal(events.length, 0, "首扫不发事件");
});

test("追加行 → 增量事件；重复 tick 幂等（不重复出）", () => {
  const d = tmpDir();
  const f = path.join(d, "s2.jsonl");
  writeFileSync(f, line("assistant", { content: [{ type: "text", text: "回复A" }] }) + "\n", "utf8");
  const events = [];
  const w = createCcWatcher({ ccDir: d, emit: (e) => events.push(e), idleTimeoutMs: 30000 });
  w.tick(); // 首扫
  // 追加回复B + tool_use
  appendFileSync(f, line("assistant", { content: [{ type: "text", text: "回复B" }] }) + "\n", "utf8");
  appendFileSync(f, line("assistant", { content: [], tool_use: { id: "t2", name: "WebSearch" } }) + "\n", "utf8");
  w.tick();
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["cc:assistant_reply", "cc:tool_use"], "只出新行事件");
  assert.equal(events[0].payload.replyLen, 3, "回复B 长度");
  assert.equal(events[1].payload.tool, "WebSearch");
  // 幂等：再 tick 不重复
  w.tick();
  assert.equal(events.length, 2, "重复扫描幂等");
});

test("新文件出现 → cc:session_started（含目录）", () => {
  const d = tmpDir();
  writeFileSync(path.join(d, "a.jsonl"), line("assistant", { content: [{ type: "text", text: "x" }] }) + "\n", "utf8");
  const events = [];
  const w = createCcWatcher({ ccDir: d, emit: (e) => events.push(e), idleTimeoutMs: 30000 });
  w.tick();
  // 新会话文件出现
  writeFileSync(path.join(d, "b.jsonl"), line("assistant", { content: [{ type: "text", text: "y" }] }) + "\n", "utf8");
  w.tick();
  const ev = events.find((e) => e.type === "cc:session_started");
  assert.ok(ev, "新文件 → session_started");
  assert.equal(ev.payload.sessionId, "b");
  assert.equal(ev.payload.dir, d);
  // b 文件的内容也解析了（同 tick 增量）
  assert.ok(events.some((e) => e.type === "cc:assistant_reply"), "新文件存量行也解析");
});

test("多文件各自独立增量", () => {
  const d = tmpDir();
  writeFileSync(path.join(d, "x.jsonl"), line("assistant", { content: [{ type: "text", text: "x1" }] }) + "\n", "utf8");
  writeFileSync(path.join(d, "y.jsonl"), line("assistant", { content: [{ type: "text", text: "y1" }] }) + "\n", "utf8");
  const events = [];
  const w = createCcWatcher({ ccDir: d, emit: (e) => events.push(e), idleTimeoutMs: 30000 });
  w.tick();
  appendFileSync(path.join(d, "x.jsonl"), line("assistant", { content: [{ type: "text", text: "x2" }] }) + "\n", "utf8");
  w.tick();
  assert.equal(events.filter((e) => e.type === "cc:assistant_reply").length, 1, "只有 x 出新事件");
  assert.equal(events[0].payload.replyLen, 2, "x2");
});

// ---------- 会话结束 ----------
test("停止增长超过 idleTimeout → cc:session_finished（时长+工具数）", async () => {
  const d = tmpDir();
  const f = path.join(d, "s3.jsonl");
  writeFileSync(f, line("assistant", { content: [{ type: "text", text: "r" }] }) + "\n", "utf8");
  const events = [];
  const w = createCcWatcher({ ccDir: d, emit: (e) => events.push(e), idleTimeoutMs: 30 });
  w.tick();
  // 模拟时间流逝：等 60ms 后再 tick（最后增长时间已过 idleTimeout）
  await new Promise((r) => setTimeout(r, 80));
  w.tick();
  const fin = events.find((e) => e.type === "cc:session_finished");
  assert.ok(fin, "超时未增长 → session_finished");
  assert.equal(fin.payload.sessionId, "s3");
  assert.ok(fin.payload.durationSec >= 0);
  assert.equal(typeof fin.payload.toolCount, "number");
  // 幂等：再次 tick 不重复 finished
  w.tick();
  assert.equal(events.filter((e) => e.type === "cc:session_finished").length, 1);
});

test("CC 目录不存在 → 优雅降级（files=0 不崩溃）", () => {
  const events = [];
  const w = createCcWatcher({ ccDir: path.join(tmpDir(), "不存在"), emit: (e) => events.push(e) });
  const r = w.tick();
  assert.equal(r.files, 0);
  assert.equal(events.length, 0);
});