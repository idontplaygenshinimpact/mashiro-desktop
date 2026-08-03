// 集成测试：widget HTTP 服务全路由（spawn 真实服务 + 临时库 + 禁巡检）
// 策略：无 LLM 路由全测；LLM 路由逻辑已在单测层 mock 覆盖，这里测参数错误路径（不花钱）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dbDir = mkdtempSync(path.join(tmpdir(), "mianshi-int-"));
let child;

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/widget-data`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

before(async () => {
  child = spawn(process.execPath, ["widget.mjs"], {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      MIANSHI_PORT: String(PORT),
      MIANSHI_DB_PATH: path.join(dbDir, "test.db"),
      MIANSHI_DISABLE_PATROL: "1",
      DEEPSEEK_API_KEY: "sk-test-dummy",
    },
  });
  const ready = await waitReady();
  assert.ok(ready, `widget 服务 ${BASE} 未在 15s 内就绪`);
});

after(async () => {
  if (child && !child.killed) {
    child.kill();
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2000); // 兜底：2s 内没退出也继续
    });
  }
  // 等文件句柄释放再删临时库
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------- 读路由 ----------
test("GET /api/widget-data", async () => {
  const r = await (await fetch(`${BASE}/api/widget-data`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.plan && typeof r.plan.date === "string", "plan 有日期");
  assert.ok(Array.isArray(r.plan?.bishi) && Array.isArray(r.plan?.mianshi), "推荐列表是数组");
  assert.ok(r.review && typeof r.review.total === "number");
});

test("GET /api/study-plan", async () => {
  const r = await (await fetch(`${BASE}/api/study-plan`)).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.plan?.items));
  if (r.plan.items[0]) {
    const it = r.plan.items[0];
    assert.ok("id" in it && "topic" in it && "level" in it && "filePath" in it, "条目字段完整");
  }
});

test("GET /api/review/due", async () => {
  const r = await (await fetch(`${BASE}/api/review/due`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.stats && typeof r.stats.total === "number");
});

test("GET /api/stats", async () => {
  const r = await (await fetch(`${BASE}/api/stats`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.stats && typeof r.stats.chats === "number");
});

test("GET /api/observability", async () => {
  const r = await (await fetch(`${BASE}/api/observability`)).json();
  assert.equal(r.ok, true);
  assert.ok(r.llm && typeof r.llm.total === "number");
  assert.ok(Array.isArray(r.tools));
});

test("GET /api/interview/history", async () => {
  const r = await (await fetch(`${BASE}/api/interview/history`)).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.history));
});

// ---------- 写路由（无 LLM） ----------
test("POST /api/study-check 不存在的 id → 错误不崩溃", async () => {
  const r = await (await fetch(`${BASE}/api/study-check?id=nope&done=1`)).json();
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("POST /api/study-check 合法 id 勾选 → ok + 情感反馈", async () => {
  const plan = await (await fetch(`${BASE}/api/study-plan`)).json();
  const item = plan.plan?.items?.[0];
  if (!item) { console.log("  ⏭️ 无清单条目，跳过"); return; }
  const r = await (await fetch(`${BASE}/api/study-check?id=${item.id}&done=1`)).json();
  assert.equal(r.ok, true);
  assert.equal(r.item.done, true);
  assert.ok(r.emotion, "有情感反馈");
});

test("POST /api/review/add 缺 topic → 400", async () => {
  const r = await fetch(`${BASE}/api/review/add`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});

test("POST /api/review/add + submit 完整复习流程", async () => {
  const add = await (await fetch(`${BASE}/api/review/add`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: "集成测试知识点", question: "q", source: "集成测试" }) })).json();
  assert.equal(add.ok, true);
  assert.ok(add.card?.id);
  const sub = await (await fetch(`${BASE}/api/review/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: add.card.id, rating: 3 }) })).json();
  assert.equal(sub.ok, true);
  assert.ok(sub.card?.fsrs, "FSRS 状态更新");
});

test("POST /api/review/submit 不存在的卡 → ok:false", async () => {
  const r = await (await fetch(`${BASE}/api/review/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "nope", rating: 2 }) })).json();
  assert.equal(r.ok, false);
});

test("POST /api/interview-notes 空 topics → 不崩溃", async () => {
  const r = await (await fetch(`${BASE}/api/interview-notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topics: [] }) })).json();
  assert.ok(r.ok === true || r.error, "返回 ok 或 error 都不算崩溃");
});

// ---------- 错误路径 ----------
test("POST /api/chat 缺 message → 400", async () => {
  const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});

test("POST /api/chat 非法 JSON body → 500 错误不崩溃", async () => {
  const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" });
  assert.equal(r.status, 500);
  const j = await r.json();
  assert.ok(j.error);
});

test("未知路由 → 非 500（服务不崩）", async () => {
  const r = await fetch(`${BASE}/api/不存在的路由`);
  assert.notEqual(r.status, 500);
});
