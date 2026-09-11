// 多源 agent 会话感知测试（2026-09-11 扩展：原感知层只看 Claude Code，实战中等于没输入）
// 覆盖：四源的解析器 + 各自的增量策略 + "静止历史会话不得误判结束" + env 分源开关
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  parseCodexLine,
  parseDshLine,
  parseOpenCodePart,
  readDshTailFrames,
  readDshFramesFrom,
  readDshSessionHeader,
  createCodexSource,
  createDshSource,
  createOpenCodeSource,
  createAgentWatcher,
} from "../lib/adapters/agent-watcher.mjs";

const tmpDir = (tag) => mkdtempSync(path.join(tmpdir(), `aw-${tag}-`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Codex ----------
test("parseCodexLine：codex rollout → 归一化事件（task_started/agent_message/function_call/task_complete）", () => {
  const meta = parseCodexLine(JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "D:\\proj\\demo" } }));
  assert.equal(meta.type, "meta");
  assert.equal(meta.payload.cwd, "D:\\proj\\demo");

  const started = parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }));
  assert.equal(started.type, "started");

  const reply = parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "你好" } }));
  assert.equal(reply.type, "assistant_reply");
  assert.equal(reply.payload.replyLen, 2);

  const tool = parseCodexLine(JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell" } }));
  assert.equal(tool.type, "tool_use");
  assert.equal(tool.payload.tool, "shell");

  const done = parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }));
  assert.equal(done.type, "finished");

  assert.equal(parseCodexLine("坏行"), null);
  assert.equal(parseCodexLine(JSON.stringify({ type: "world_state" })), null);
});

test("Codex 源：新文件 → session_started；增量 → 工具/回复；task_complete → finished（含项目名 label）", () => {
  const d = tmpDir("codex");
  const events = [];
  const src = createCodexSource({ dir: d, emit: (e) => events.push(e), idleTimeoutMs: 60000 });
  src.tick(); // 首扫（空目录）

  const sub = path.join(d, "2026", "09", "11");
  mkdirSync(sub, { recursive: true });
  const f = path.join(sub, "rollout-2026-09-11T20-00-00-abc.jsonl");
  writeFileSync(f, [
    JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: "D:\\mianshi-agent" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
  ].join("\n") + "\n", "utf8");
  src.tick();
  appendFileSync(f, [
    JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "apply_patch" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "改完了" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
  ].join("\n") + "\n", "utf8");
  src.tick();

  const types = events.map((e) => e.type);
  assert.ok(types.includes("agent:session_started"), "新 rollout → session_started");
  assert.equal(events.find((e) => e.type === "agent:session_started").source, "codex");
  assert.ok(types.includes("agent:tool_use"), "function_call → tool_use");
  assert.deepEqual(events.find((e) => e.type === "agent:tool_use").payload, { tool: "apply_patch" });
  assert.ok(types.includes("agent:assistant_reply"), "agent_message → assistant_reply");
  assert.ok(types.includes("agent:session_finished"), "task_complete → session_finished");
  assert.equal(events.find((e) => e.type === "agent:session_finished").payload.toolCount, 1, "工具计数");
  rmSync(d, { recursive: true, force: true });
});

// ---------- DSH（zstd 多帧追加流） ----------
test("parseDshLine：tool/call → tool_use（工具名）；assistant/message → 回复长度；流式 chunk 静默", () => {
  const tool = parseDshLine(JSON.stringify({ type: "tool/call", seq0: 10, time0: 1, data: { name: "read_file" } }));
  assert.equal(tool.type, "tool_use");
  assert.equal(tool.payload.tool, "read_file");
  assert.equal(tool.seq, 10);

  const reply = parseDshLine(JSON.stringify({ type: "assistant/message", seq0: 11, data: { text: "四字回复" } }));
  assert.equal(reply.type, "assistant_reply");
  assert.equal(reply.payload.replyLen, 4);

  assert.equal(parseDshLine(JSON.stringify({ type: "assistant/chunk", seq0: 12, data: {} })), null, "流式 chunk 不单独成事件");
  assert.equal(parseDshLine(JSON.stringify({ type: "reasoning-chunks", seq0: 13, data: {} })), null);
  assert.equal(parseDshLine("{截断"), null);
});

test("DSH：多帧 zstd 只解尾部若干帧；首帧可读会话头（cwd → label）", () => {
  const d = tmpDir("dsh");
  const sess = path.join(d, "--D-mianshi-agent--", "session-abc");
  mkdirSync(sess, { recursive: true });
  const f = path.join(sess, "session.jsonl.zstd");
  // 帧 1 = 会话头；帧 2..5 = 增量行（真实 DSH 就是逐次 append 独立 zstd 帧）
  const frames = [
    Buffer.from(JSON.stringify({ type: "session", id: "abc", cwd: "D:\\mianshi-agent", createdAt: Date.now() }) + "\n"),
    ...Array.from({ length: 4 }, (_, i) => Buffer.from(JSON.stringify({ type: i === 1 ? "tool/call" : "assistant/chunk", seq0: i + 1, data: { name: "grep" } }) + "\n")),
  ];
  writeFileSync(f, Buffer.concat(frames.map((b) => zstdCompressSync(b))));

  const head = readDshSessionHeader(f);
  assert.equal(head.cwd, "D:\\mianshi-agent", "首帧解出 cwd");
  const tail = readDshTailFrames(f, { maxBytes: 65536, maxFrames: 16 });
  assert.ok(tail.frames >= 4, `尾部解出 ${tail.frames} 帧`);
  assert.ok(tail.text.includes("tool/call"), "尾帧文本含增量行");
  rmSync(d, { recursive: true, force: true });
});

test("DSH 源：新会话 → session_started（label=cwd 目录名）；seq0 去重；静止历史不误判结束", async () => {
  const d = tmpDir("dsh2");
  const events = [];
  const src = createDshSource({ dir: d, emit: (e) => events.push(e), idleTimeoutMs: 40 });
  src.tick(); // 首扫（空）

  const sess = path.join(d, "--D-proj--", "session-1");
  mkdirSync(sess, { recursive: true });
  const f = path.join(sess, "session.jsonl.zstd");
  const frame = (obj) => zstdCompressSync(Buffer.from(JSON.stringify(obj) + "\n"));
  writeFileSync(f, Buffer.concat([frame({ type: "session", id: "s1", cwd: "D:\\proj", createdAt: Date.now() })]));
  src.tick();
  assert.ok(events.some((e) => e.type === "agent:session_started"), "新会话目录 → session_started");
  assert.equal(events.find((e) => e.type === "agent:session_started").payload.label, "proj", "label 来自 cwd 目录名");
  assert.equal(events.find((e) => e.type === "agent:session_started").source, "dsh");

  // 追加一帧（tool/call）→ 事件；再次 tick 不得重复（尾部窗口重叠 → seq0 去重）
  appendFileSync(f, frame({ type: "tool/call", seq0: 100, data: { name: "read_file" } }));
  src.tick();
  const toolEvents = events.filter((e) => e.type === "agent:tool_use");
  assert.equal(toolEvents.length, 1, "追加帧 → 一次 tool_use");
  assert.deepEqual(toolEvents[0].payload, { tool: "read_file" });
  src.tick();
  src.tick();
  assert.equal(events.filter((e) => e.type === "agent:tool_use").length, 1, "重复 tick 幂等（seq0 去重）");

  // 超过 idle：见过增长 → 判结束
  await wait(80);
  src.tick();
  assert.equal(events.filter((e) => e.type === "agent:session_finished").length, 1, "有增长后 idle → finished");
  rmSync(d, { recursive: true, force: true });
});

// ---------- OpenCode（SQLite 只读轮询） ----------
test("parseOpenCodePart：tool → tool_use；text → 回复长度；reasoning/step 静默", () => {
  assert.deepEqual(parseOpenCodePart(JSON.stringify({ type: "tool", tool: "bash" })).payload, { tool: "bash" });
  assert.equal(parseOpenCodePart(JSON.stringify({ type: "text", text: "答复" })).payload.replyLen, 2);
  assert.equal(parseOpenCodePart(JSON.stringify({ type: "reasoning", text: "x" })), null);
  assert.equal(parseOpenCodePart("坏 JSON"), null);
});

test("OpenCode 源：session 新行 → session_started；part 新行 → 工具/回复；按 rowid 增量不重放", () => {
  const d = tmpDir("oc");
  const dbPath = path.join(d, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.close();

  const events = [];
  const src = createOpenCodeSource({ dbPath, emit: (e) => events.push(e), idleTimeoutMs: 60000 });
  src.tick(); // 首扫（空库）

  const db2 = new DatabaseSync(dbPath);
  db2.prepare("INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?,?,?,?,?)")
    .run("ses_1", "修 DSH 会话日志", "D:/mianshi-agent", Date.now(), Date.now());
  db2.prepare("INSERT INTO part (id, session_id, time_created, data) VALUES (?,?,?,?)")
    .run("prt_1", "ses_1", Date.now(), JSON.stringify({ type: "tool", tool: "edit" }));
  db2.prepare("INSERT INTO part (id, session_id, time_created, data) VALUES (?,?,?,?)")
    .run("prt_2", "ses_1", Date.now(), JSON.stringify({ type: "text", text: "改好了" }));
  db2.close();

  src.tick();
  const started = events.find((e) => e.type === "agent:session_started");
  assert.ok(started, "新 session 行 → session_started");
  assert.equal(started.source, "opencode");
  assert.equal(started.payload.label, "修 DSH 会话日志");
  assert.deepEqual(events.find((e) => e.type === "agent:tool_use").payload, { tool: "edit" });
  assert.equal(events.find((e) => e.type === "agent:assistant_reply").payload.replyLen, 3);

  const before = events.length;
  src.tick();
  assert.equal(events.length, before, "无新行 → 不重复出事件（rowid 游标）");
  src.close();
  rmSync(d, { recursive: true, force: true });
});

test("DSH：从上次偏移精确解新帧（append-only；不重放窗口里的旧行——真实语料实测踩到的坑）", () => {
  const d = tmpDir("dsh3");
  const f = path.join(d, "session.jsonl.zstd");
  const frame = (obj) => zstdCompressSync(Buffer.from(JSON.stringify(obj) + "\n"));
  writeFileSync(f, frame({ type: "tool/call", seq0: 1, data: { name: "old_tool" } }));
  const sizeAfterFirst = statSync(f).size;
  appendFileSync(f, frame({ type: "tool/call", seq0: 2, data: { name: "new_tool" } }));

  const delta = readDshFramesFrom(f, sizeAfterFirst, { maxBytes: 65536, maxFrames: 16 });
  assert.ok(delta.text.includes("new_tool"), "读到新帧");
  assert.ok(!delta.text.includes("old_tool"), "不重放旧帧（旧行没有 time0，时间启发式挡不住）");
  assert.equal(delta.size, statSync(f).size, "返回最新 size 供下次增量");
  rmSync(d, { recursive: true, force: true });
});

// ---------- 聚合 + 开关 ----------
test("createAgentWatcher：环境变量分源开关（默认四源；MIANSHI_AGENT_WATCH=0 全关；单源关只少那一个）", () => {
  const all = createAgentWatcher({ emit: () => {}, env: {} });
  assert.deepEqual(all.sources(), ["claude-code", "codex", "dsh", "opencode"], "默认开启四源");

  const none = createAgentWatcher({ emit: () => {}, env: { MIANSHI_AGENT_WATCH: "0" } });
  assert.deepEqual(none.sources(), [], "总开关关掉全部");

  const noDsh = createAgentWatcher({ emit: () => {}, env: { MIANSHI_DSH_WATCH: "0" } });
  assert.deepEqual(noDsh.sources(), ["claude-code", "codex", "opencode"], "MIANSHI_DSH_WATCH=0 只关 DSH");
  const legacy = createAgentWatcher({ emit: () => {}, env: { MIANSHI_CC_WATCH: "0" } });
  assert.deepEqual(legacy.sources(), ["codex", "dsh", "opencode"], "旧的 MIANSHI_CC_WATCH=0 语义保留");
});

test("createAgentWatcher：tick 汇总各源、单源异常不影响其它源（失败隔离）", () => {
  const events = [];
  const d = tmpDir("agg");
  const w = createAgentWatcher({
    emit: (e) => events.push(e),
    sources: ["codex", "opencode"],
    codexDir: d,
    opencodeDb: path.join(d, "不存在.db"), // 源不可用 → 该源 0 事件，不抛
  });
  const r = w.tick();
  assert.equal(r.sources, 2);
  assert.equal(r.newEvents, 0);
  assert.deepEqual(Object.keys(r.detail).sort(), ["codex", "opencode"]);
  rmSync(d, { recursive: true, force: true });
});
