// dreaming.mjs 单测：候选收集（origin 门禁）/ 加权筛选 / 巩固流程（真实临时 DB + 注入 fake LLM）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

const dbDir = setupTempDb("dreaming");
// 注入独立日志目录，避免写真实 data/dreams
const logDir = mkdtempSync(path.join(tmpdir(), "dream-log-"));
const { collectCandidates, selectCandidates, buildConsolidationPrompt, runDreaming } = await import("../lib/dreaming.mjs");
const { db } = await import("../lib/db.mjs");

const now = Date.now();

beforeEach(() => {
  db.exec("DELETE FROM chat_history; DELETE FROM weak_points; DELETE FROM mastered_points; DELETE FROM interview_history; DELETE FROM curated_memory;");
});
after(() => {
  cleanupTempDb(dbDir);
  rmSync(logDir, { recursive: true, force: true });
});

// ---------- collectCandidates ----------
test("collectCandidates 排除 untrusted 来源（provenance 门禁）", () => {
  const candidates = collectCandidates({
    weakPoints: [
      { topic: "可信点", failCount: 2, lastFailedAt: new Date(now - 3600 * 1000).toISOString(), origin: "agent" },
      { topic: "不可信点", failCount: 3, lastFailedAt: new Date(now - 3600 * 1000).toISOString(), origin: "untrusted" },
    ],
    now,
  });
  assert.ok(candidates.length >= 1, "有可信候选");
  assert.ok(candidates.every((c) => c.origin !== "untrusted"), "untrusted 全部排除");
  assert.ok(candidates.some((c) => c.text.includes("可信点")), "保留可信点");
  assert.ok(candidates.every((c) => !c.text.includes("不可信点")), "不可信点未进入");
});

test("collectCandidates 确定性评分 + 时新度权重 + 重要度权重", () => {
  const older = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  const newer = new Date(now - 3600 * 1000).toISOString();
  const mk = (topic, lastFailedAt, failCount) => collectCandidates({ weakPoints: [{ topic, failCount, lastFailedAt, origin: "agent" }], now });
  // 确定性：相同输入 → 相同输出
  assert.deepEqual(mk("旧点", older, 1), mk("旧点", older, 1));
  // 时新度：越新 recencyScore 越高
  assert.ok(mk("新点", newer, 1)[0].recencyScore > mk("旧点", older, 1)[0].recencyScore);
  // 重要度：failCount 越高 importanceScore 越高
  assert.ok(mk("点", newer, 5)[0].importanceScore > mk("点", newer, 1)[0].importanceScore);
});

test("collectCandidates 覆盖 chat/mastered/interview 来源", () => {
  const candidates = collectCandidates({
    chatHistory: [{ role: "user", content: "我搞混宏任务微任务", ts: now - 1000 }],
    masteredPoints: [{ topic: "闭包", verifiedAt: new Date(now - 2000).toISOString() }],
    interviewHistory: [{ date: "2026-08-01", position: "前端", rounds: 3, report: "事件循环答得差" }],
    now,
  });
  const refs = candidates.map((c) => c.sourceRef);
  assert.ok(refs.some((r) => r.startsWith("chat:")), "对话候选");
  assert.ok(refs.some((r) => r.startsWith("mastered:")), "已掌握候选");
  assert.ok(refs.some((r) => r.startsWith("interview:")), "面试候选");
  assert.ok(candidates.every((c) => typeof c.recencyScore === "number" && typeof c.importanceScore === "number"));
});

// ---------- selectCandidates ----------
test("selectCandidates maxCount 截断 + 加权最高者胜出", () => {
  const cands = Array.from({ length: 20 }, (_, i) => ({
    text: `c${i}`, origin: "agent", sourceRef: `s:${i}`,
    recencyScore: i, importanceScore: i % 5,
  }));
  const selected = selectCandidates(cands, { maxCount: 5 });
  assert.equal(selected.length, 5);
  assert.equal(selected[0].text, "c19", "加权最高（19+4）排最前");
  // 默认 maxCount=12
  assert.equal(selectCandidates(cands).length, 12);
});

// ---------- buildConsolidationPrompt ----------
test("buildConsolidationPrompt 要求 JSON + 每条 entry 带 sourceRef", () => {
  const prompt = buildConsolidationPrompt(
    [{ text: "薄弱点：事件循环", sourceRef: "weak:事件循环", origin: "agent" }],
    [{ topic: "旧记忆", source_ref: "weak:旧" }]
  );
  assert.ok(prompt.includes("entries"), "要求 entries 数组");
  assert.ok(prompt.includes("sourceRef"), "要求 sourceRef");
  assert.ok(prompt.includes("drop"), "要求 drop 数组");
  assert.ok(prompt.includes("weak:事件循环"), "候选素材带上来源引用");
  assert.ok(prompt.includes("旧记忆"), "带上已有记忆");
});

// ---------- runDreaming（真实临时 DB + 注入 fake LLM） ----------
const seedWeak = () => {
  db.prepare("INSERT INTO weak_points (id, topic, fail_count, last_failed_at, source, origin, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("wp_1", "事件循环", 2, new Date(now - 3600 * 1000).toISOString(), "复盘", "agent", now);
  db.prepare("INSERT INTO chat_history (role, content, ts) VALUES (?,?,?)").run("user", "宏任务微任务分不清", now - 7200 * 1000);
};

test("runDreaming 成功：写 curated_memory + 日志 + 汇总计数", async () => {
  seedWeak();
  const fakeLlm = async () => JSON.stringify({
    entries: [
      { topic: "事件循环", content: "宏任务先于微任务执行", sourceRef: "weak:事件循环", importance: 4, keep: "高频考点" },
      { topic: "微任务", content: "Promise.then 回调属微任务", sourceRef: "chat:0", importance: 3, keep: "易混淆" },
    ],
    drop: ["过时主题"],
  });
  const r = await runDreaming({ llm: fakeLlm, now, logDir });
  assert.equal(r.ok, true);
  assert.equal(r.added, 2);
  assert.equal(r.updated, 0);
  assert.equal(r.dropped, 1);
  assert.ok(r.candidates >= 2);

  const rows = db.prepare("SELECT topic, content, source_ref, importance, origin FROM curated_memory ORDER BY topic").all();
  assert.equal(rows.length, 2, "两条长期记忆入库");
  const ev = rows.find((x) => x.topic === "事件循环");
  assert.equal(ev.source_ref, "weak:事件循环");
  assert.equal(ev.importance, 4);
  assert.equal(ev.origin, "agent", "来源 weak → origin 沿用候选的 agent");

  assert.ok(r.logFile && existsSync(r.logFile), "日志文件写盘");
  const log = readFileSync(r.logFile, "utf8");
  assert.ok(log.includes("事件循环") && log.includes("丢弃"), "日志含条目与统计");
});

test("runDreaming 重复运行：同主题记 updated 不重复堆叠", async () => {
  seedWeak();
  const fakeLlm = async () => JSON.stringify({ entries: [{ topic: "事件循环", content: "更新后的内容", sourceRef: "weak:事件循环", importance: 5, keep: "x" }], drop: [] });
  const r1 = await runDreaming({ llm: fakeLlm, now, logDir });
  const r2 = await runDreaming({ llm: fakeLlm, now, logDir });
  assert.equal(r1.added, 1);
  assert.equal(r2.added, 0);
  assert.equal(r2.updated, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM curated_memory").get().n, 1, "同主题不重复堆叠");
});

test("runDreaming LLM 抛错 → ok:false（不向上抛）", async () => {
  seedWeak();
  const r = await runDreaming({ llm: async () => { throw new Error("boom"); }, now, logDir });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("boom"));
});

test("runDreaming LLM 返回垃圾 → ok:false", async () => {
  seedWeak();
  const r = await runDreaming({ llm: async () => "这不是JSON也不是对象", now, logDir });
  assert.equal(r.ok, false);
  assert.ok(r.error, "带错误信息");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM curated_memory").get().n, 0, "垃圾输出不入库");
});

test("runDreaming 无候选 → ok:true 且不调 LLM 不写日志", async () => {
  let called = false;
  const r = await runDreaming({ llm: async () => { called = true; return "{}"; }, now, logDir });
  assert.equal(r.ok, true);
  assert.equal(r.candidates, 0);
  assert.equal(r.added, 0);
  assert.equal(called, false, "无候选不调 LLM");
  assert.equal(r.logFile, null);
});
