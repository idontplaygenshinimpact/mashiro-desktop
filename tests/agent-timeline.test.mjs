// Agent 会话时间线 + 项目投入统计测试（方向 A：把感知层信号沉淀成数据）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

const dbDir = setupTempDb("agent-timeline");
const { recordAgentEvent, getAgentTimeline, backfillFromOpenCode, backfillFromDsh, backfillFromJsonl } =
  await import("../lib/agent-timeline.ts");
const { db } = await import("../lib/db.mjs");

test.after(() => { cleanupTempDb(dbDir); });

const tmpDir = (tag) => mkdtempSync(path.join(tmpdir(), `atl-${tag}-`));
const ev = (type, payload, extra = {}) => ({ type, source: "dsh", ts: Date.now(), payload, ...extra });
const clearSessions = () => { db.exec("DELETE FROM agent_sessions"); db.exec("DELETE FROM agent_tool_events"); };

test("recordAgentEvent：会话生命周期 → 汇总行 + 工具明细行（幂等累加）", () => {
  clearSessions();
  const t0 = Date.now() - 60_000;
  assert.equal(recordAgentEvent(ev("agent:session_started", { sessionId: "s1", label: "mianshi-agent", dir: "D:/mianshi-agent", ts: t0 }, { ts: t0 })), true);
  recordAgentEvent(ev("agent:tool_use", { sessionId: "s1", label: "mianshi-agent", tool: "read_file" }));
  recordAgentEvent(ev("agent:tool_use", { sessionId: "s1", label: "mianshi-agent", tool: "pwsh" }));
  recordAgentEvent(ev("agent:assistant_reply", { sessionId: "s1", label: "mianshi-agent", replyLen: 12 }));
  recordAgentEvent(ev("agent:assistant_reply", { sessionId: "s1", label: "mianshi-agent", replyLen: 8 }));

  const row = db.prepare("SELECT * FROM agent_sessions WHERE id='dsh:s1'").get();
  assert.ok(row, "会话行已建");
  assert.equal(row.project, "mianshi-agent");
  assert.equal(row.tool_calls, 2, "两次工具调用累加");
  assert.equal(row.turns, 2, "两次回复累加");
  assert.equal(row.started_at <= t0 + 5, true, "started_at = 首事件时间");
  assert.ok(row.last_activity_at >= row.started_at);
  assert.equal(row.partial, 0);

  const tools = db.prepare("SELECT tool, COUNT(*) n FROM agent_tool_events WHERE session_id='s1' GROUP BY tool ORDER BY tool").all();
  assert.deepEqual(tools.map((t) => [t.tool, t.n]), [["pwsh", 1], ["read_file", 1]], "工具明细各一条");

  recordAgentEvent(ev("agent:session_finished", { sessionId: "s1", label: "mianshi-agent", durationSec: 60, toolCount: 2 }));
  assert.ok(db.prepare("SELECT ended_at FROM agent_sessions WHERE id='dsh:s1'").get().ended_at > 0, "结束时写入 ended_at");
});

test("recordAgentEvent：缺 sessionId / 非 agent 事件 → 忽略（不建脏行）", () => {
  clearSessions();
  assert.equal(recordAgentEvent(ev("agent:tool_use", { tool: "pwsh" })), false, "无 sessionId 不记");
  assert.equal(recordAgentEvent({ type: "chat_done", source: "agent", ts: Date.now(), payload: {} }), false, "非 agent:* 不记");
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM agent_sessions").get().n), 0);
});

test("getAgentTimeline：项目聚合（区间**去重叠**的覆盖时长）+ Top 工具 + 时间窗过滤", () => {
  clearSessions();
  const now = Date.now();
  // mk：startAgoMin 分钟前开始，spanMin 分钟后最后一次活动（用 session_finished 推进 last_activity_at）
  const mk = (source, sid, project, startAgoMin, spanMin, turns, tools) => {
    const start = now - startAgoMin * 60_000;
    recordAgentEvent({ type: "agent:session_started", source, ts: start, payload: { sessionId: sid, label: project } });
    for (let i = 0; i < turns; i++) recordAgentEvent({ type: "agent:assistant_reply", source, ts: start + 1000, payload: { sessionId: sid, label: project } });
    for (let i = 0; i < tools; i++) recordAgentEvent({ type: "agent:tool_use", source, ts: start + 1000, payload: { sessionId: sid, label: project, tool: i % 2 ? "pwsh" : "read_file" } });
    recordAgentEvent({ type: "agent:session_finished", source, ts: start + spanMin * 60_000, payload: { sessionId: sid, label: project } });
  };
  mk("dsh", "a1", "mianshi-agent", 100, 80, 3, 6);      // [-100, -20]
  mk("dsh", "a2", "mianshi-agent", 60, 50, 1, 2);       // [-60, -10] —— 与 a1 重叠
  mk("opencode", "b1", "novel-factory", 30, 5, 2, 4);   // [-30, -25]（落在上面区间内）
  mk("codex", "c1", "old-proj", 60 * 24 * 30, 5, 1, 1); // 30 天前 → 7 天窗外

  const t7 = getAgentTimeline({ days: 7 });
  assert.equal(t7.totals.sessions, 3, "7 天内 3 个会话（30 天前的排除）");
  assert.equal(t7.totals.toolCalls, 12);
  assert.equal(t7.totals.turns, 6);
  const ma = t7.byProject.find((p) => p.project === "mianshi-agent");
  // 关键口径：重叠区间只算一次 → 并集 [-100, -10] = 90 分钟（直接相加会得到 130）
  assert.equal(Math.round(ma.minutes), 90, "重叠区间取并集（90 分钟，而非 130）");
  assert.equal(ma.sessions, 2);
  assert.deepEqual(ma.sources, ["dsh"], "项目行带来源标记（面板图标用）");
  assert.equal(t7.totals.minutes, 90, "总覆盖时段 = 全部会话区间并集（novel 的 5 分钟已被包含）");
  assert.equal(t7.totals.activeDays, 1, "活跃天数去重后为 1");
  const novel = t7.byProject.find((p) => p.project === "novel-factory");
  assert.deepEqual(novel.sources, ["opencode"]);
  assert.equal(Math.round(novel.minutes), 5);
  assert.deepEqual(t7.topTools.map((t) => t.tool).sort(), ["pwsh", "read_file"]);
  assert.equal(t7.topTools.reduce((n, t) => n + t.n, 0), 12);
  assert.equal(t7.recent.length, 3);

  const t30 = getAgentTimeline({ days: 90 });
  assert.equal(t30.totals.sessions, 4, "放宽窗口后包含 30 天前的会话");
});

test("backfillFromOpenCode：SQL 精确聚合（会话/轮次/工具数），幂等不翻倍", () => {
  clearSessions();
  const d = tmpDir("oc");
  const dbPath = path.join(d, "opencode.db");
  const oc = new DatabaseSync(dbPath);
  oc.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  const t0 = Date.now() - 3600_000;
  oc.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("ses_1", "dsh web fails", "C:/Users/wrx", t0, t0 + 1800_000);
  for (let i = 0; i < 5; i++) oc.prepare("INSERT INTO message VALUES (?,?,?)").run(`m${i}`, "ses_1", t0 + i * 1000);
  for (let i = 0; i < 3; i++) oc.prepare("INSERT INTO part VALUES (?,?,?,?)").run(`pt${i}`, "ses_1", t0 + i * 1000, JSON.stringify({ type: "tool", tool: "bash" }));
  oc.prepare("INSERT INTO part VALUES (?,?,?,?)").run("ptx", "ses_1", t0 + 4000, JSON.stringify({ type: "text", text: "回复" }));
  oc.close();

  assert.equal(backfillFromOpenCode(dbPath), 1, "回填 1 个会话");
  const row = db.prepare("SELECT * FROM agent_sessions WHERE id='opencode:ses_1'").get();
  // 归组用 directory 目录名（title 是"项目浏览/问候"这类临时标题，会把统计打散）——本机实测踩到
  assert.equal(row.project, "wrx", "项目 = directory 目录名（不是会话 title）");
  assert.equal(row.dir, "C:/Users/wrx");
  assert.equal(row.turns, 5, "message 行数");
  assert.equal(row.tool_calls, 3, "part 里 type=tool 的行数");
  assert.equal(row.partial, 0, "OpenCode 是精确口径");
  assert.equal(Math.round((row.last_activity_at - row.started_at) / 60000), 30, "时长 30 分钟");

  backfillFromOpenCode(dbPath); // 幂等
  const again = db.prepare("SELECT turns, tool_calls FROM agent_sessions WHERE id='opencode:ses_1'").get();
  assert.deepEqual([again.turns, again.tool_calls], [5, 3], "重复回填不翻倍（MAX 语义）");
  rmSync(d, { recursive: true, force: true });
});

test("backfillFromDsh：会话头 createdAt + 文件 mtime 近似（partial=1，不逐帧解压）", () => {
  clearSessions();
  const d = tmpDir("dsh");
  const sess = path.join(d, "--D-mianshi-agent--", "session-abc");
  mkdirSync(sess, { recursive: true });
  const created = Date.now() - 7200_000;
  const f = path.join(sess, "session.jsonl.zstd");
  writeFileSync(f, zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", id: "abc", cwd: "D:\\mianshi-agent", createdAt: created }) + "\n")));
  const mtime = new Date(Date.now() - 60_000);
  utimesSync(f, mtime, mtime);

  const r = backfillFromDsh(d, 100);
  assert.equal(r.sessions, 1);
  const row = db.prepare("SELECT * FROM agent_sessions WHERE id='dsh:abc'").get();
  assert.equal(row.project, "mianshi-agent", "项目名来自会话头 cwd");
  assert.equal(row.partial, 1, "DSH 历史回填是近似口径（marked partial）");
  assert.equal(Math.round((row.last_activity_at - row.started_at) / 60000), 119, "≈2 小时（createdAt → mtime）");
  rmSync(d, { recursive: true, force: true });
});

test("backfillFromJsonl：Codex rollout 统计轮次与工具调用（task_started/agent_message/function_call）", () => {
  clearSessions();
  const d = tmpDir("codex");
  const sub = path.join(d, "2026", "09", "11");
  mkdirSync(sub, { recursive: true });
  const f = path.join(sub, "rollout-2026-09-11T20-00-00-abc.jsonl");
  writeFileSync(f, [
    JSON.stringify({ timestamp: "2026-09-11T12:00:00.000Z", type: "session_meta", payload: { id: "c1", cwd: "D:\\proj" } }),
    JSON.stringify({ timestamp: "2026-09-11T12:00:01.000Z", type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ timestamp: "2026-09-11T12:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "shell" } }),
    JSON.stringify({ timestamp: "2026-09-11T12:00:03.000Z", type: "response_item", payload: { type: "local_shell_call" } }),
    JSON.stringify({ timestamp: "2026-09-11T12:00:04.000Z", type: "event_msg", payload: { type: "agent_message", message: "做完了" } }),
  ].join("\n") + "\n", "utf8");

  assert.equal(backfillFromJsonl(d, "codex"), 1);
  const row = db.prepare("SELECT * FROM agent_sessions WHERE id='codex:rollout-2026-09-11T20-00-00-abc'").get();
  assert.equal(row.turns, 1, "agent_message → 1 轮");
  assert.equal(row.tool_calls, 2, "function_call + local_shell_call");
  assert.equal(row.partial, 0);
  rmSync(d, { recursive: true, force: true });
});
