// 集成测试：widget HTTP 服务全路由（spawn 真实服务 + 临时库 + 禁巡检）
// 策略：无 LLM 路由全测；LLM 路由逻辑已在单测层 mock 覆盖，这里测参数错误路径（不花钱）
// 认证：widget 已加 Bearer token 门禁，测试用 MIANSHI_TOKEN=test-token + 所有请求带 Authorization 头
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const dbDir = mkdtempSync(path.join(tmpdir(), "mianshi-int-"));
let child;
let childErr = "";

// 统一 API 请求：自动带 Bearer token（opts 可覆盖 headers）
function api(pathname, opts = {}) {
  const headers = { ...AUTH, ...(opts.headers || {}) };
  return fetch(`${BASE}${pathname}`, { ...opts, headers });
}

async function waitReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await api("/api/widget-data", { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

before(async () => {
  child = spawn(process.execPath, ["widget.mjs", "--no-notify"], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      MIANSHI_PORT: String(PORT),
      MIANSHI_DB_PATH: path.join(dbDir, "test.db"),
      MIANSHI_OUTPUT_DIR: path.join(dbDir, "output"), // M8：产出/存档全临时（不写真实 output 目录）
      MIANSHI_DISABLE_PATROL: "1",
      MIANSHI_DISABLE_BACKGROUND: "1", // 关闭 RAG 构建/每日搜集等后台任务（防测试触发真实网络/模型下载）
      MIANSHI_TOKEN: TOKEN,
      DEEPSEEK_API_KEY: "sk-test-dummy",
    },
  });
  child.stderr.on("data", (d) => { childErr += d; });
  const ready = await waitReady();
  if (!ready) {
    console.log(`[集成测试] widget 未就绪，stderr: ${childErr.slice(0, 1500)}`);
  }
  assert.ok(ready, `widget 服务 ${BASE} 未在 90s 内就绪（并发跑时 playwright 加载慢）`);
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

// ---------- 健康检查 + 认证门禁 ----------
test("GET /api/health 无需认证", async () => {
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.port, "number");
  assert.equal(typeof j.uptime, "number");
});

test("无 token 的 /api/* 请求 → 401", async () => {
  const r = await fetch(`${BASE}/api/widget-data`);
  assert.equal(r.status, 401);
});

// ---------- 读路由 ----------
test("GET /api/widget-data", async () => {
  const r = await (await api("/api/widget-data")).json();
  assert.equal(r.ok, true);
  assert.ok(r.plan && typeof r.plan.date === "string", "plan 有日期");
  assert.ok(Array.isArray(r.plan?.bishi) && Array.isArray(r.plan?.mianshi), "推荐列表是数组");
  assert.ok(r.review && typeof r.review.total === "number");
});

test("GET /api/study-plan", async () => {
  const r = await (await api("/api/study-plan")).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.plan?.items));
  if (r.plan.items[0]) {
    const it = r.plan.items[0];
    assert.ok("id" in it && "topic" in it && "level" in it && "filePath" in it, "条目字段完整");
  }
});

test("GET /api/review/due", async () => {
  const r = await (await api("/api/review/due")).json();
  assert.equal(r.ok, true);
  assert.ok(r.stats && typeof r.stats.total === "number");
});

test("GET /api/pet-events（事件驱动内核表达队列 drain）", async () => {
  const r = await (await api("/api/pet-events")).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.events), "events 数组（无表达时为空）");
  // 队列 drain 语义：连续两次都是空数组（取走即清空）
  const r2 = await (await api("/api/pet-events")).json();
  assert.ok(Array.isArray(r2.events));
});

test("GET /api/stats", async () => {
  const r = await (await api("/api/stats")).json();
  assert.equal(r.ok, true);
  assert.ok(r.stats && typeof r.stats.chats === "number");
});

test("GET /api/observability", async () => {
  const r = await (await api("/api/observability")).json();
  assert.equal(r.ok, true);
  assert.ok(r.llm && typeof r.llm.total === "number");
  assert.ok(Array.isArray(r.tools));
});

test("GET /api/interview/history", async () => {
  const r = await (await api("/api/interview/history")).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.history));
});

test("GET /api/interview/status 无进行中会话 → active:false", async () => {
  const r = await (await api("/api/interview/status")).json();
  assert.equal(r.ok, true);
  assert.equal(r.active, false);
});

// ---------- 写路由（无 LLM） ----------
test("POST /api/study-check 不存在的 id → 错误不崩溃", async () => {
  const r = await (await api("/api/study-check?id=nope&done=1")).json();
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("POST /api/study-check 合法 id 勾选 → ok + 情感反馈", async () => {
  const plan = await (await api("/api/study-plan")).json();
  const item = plan.plan?.items?.[0];
  if (!item) { console.log("  ⏭️ 无清单条目，跳过"); return; }
  const r = await (await api(`/api/study-check?id=${item.id}&done=1`)).json();
  assert.equal(r.ok, true);
  assert.equal(r.item.done, true);
  assert.ok(r.emotion, "有情感反馈");
});

test("POST /api/review/add 缺 topic → 400", async () => {
  const r = await api("/api/review/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});

test("POST /api/review/add + submit 完整复习流程", async () => {
  const add = await (await api("/api/review/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: "集成测试知识点", question: "q", source: "集成测试" }) })).json();
  assert.equal(add.ok, true);
  assert.ok(add.card?.id);
  const sub = await (await api("/api/review/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: add.card.id, rating: 3 }) })).json();
  assert.equal(sub.ok, true);
  assert.ok(sub.card?.fsrs, "FSRS 状态更新");
  assert.ok("tip" in sub, "复习提交返回学习计划即时反馈字段（可为 null）");
});

test("POST /api/review/submit 不存在的卡 → ok:false", async () => {
  const r = await (await api("/api/review/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "nope", rating: 2 }) })).json();
  assert.equal(r.ok, false);
});

test("POST /api/interview-notes 空 topics → 不崩溃", async () => {
  const r = await (await api("/api/interview-notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topics: [] }) })).json();
  assert.ok(r.ok === true || r.error, "返回 ok 或 error 都不算崩溃");
});

test("GET /api/approval-pending 返回结构", async () => {
  const r = await (await api("/api/approval-pending")).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.pending));
  assert.ok(Array.isArray(r.sessionApproved));
});

test("POST /api/approval 缺 toolName → 400", async () => {
  const r = await api("/api/approval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});

test("POST /api/approval 不存在的请求 → ok:false", async () => {
  const r = await (await api("/api/approval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toolName: "nope", allow: true }) })).json();
  assert.equal(r.ok, false);
});

// ---------- 核心基础设施域（纵向拆分：lib/routes/core.mjs） ----------
test("GET / 与 /index.html 返回状态页", async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes("Mashiro"));
  const r2 = await fetch(`${BASE}/index.html`);
  assert.equal(r2.status, 200);
  assert.ok((await r2.text()).includes("Mashiro"));
});

test("GET /api/patrol-config 返回配置+预算（强制关闭态）", async () => {
  const r = await (await api("/api/patrol-config")).json();
  assert.equal(r.ok, true);
  assert.equal(r.enabled, false); // MIANSHI_DISABLE_PATROL=1
  assert.ok(typeof r.intervalMin === "number");
  assert.ok(typeof r.dailyTokenBudget === "number");
  assert.ok(typeof r.usedToday === "number");
});

test("POST /api/patrol-config 改 intervalMin → 生效", async () => {
  const r = await (await api("/api/patrol-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intervalMin: 30 }) })).json();
  assert.equal(r.ok, true);
  assert.equal(r.intervalMin, 30);
});

test("POST /api/patrol-config 非法 intervalMin → 400", async () => {
  const r = await api("/api/patrol-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intervalMin: 5 }) });
  assert.equal(r.status, 400);
});

test("POST /api/patrol-config 强制关闭下开启 → 400", async () => {
  const r = await api("/api/patrol-config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  assert.equal(r.status, 400);
});

test("POST /api/patrol-run 强制关闭 → 400 不触发巡检", async () => {
  const r = await api("/api/patrol-run", { method: "POST" });
  assert.equal(r.status, 400);
});

test("POST /api/refresh → ok（不崩溃）", async () => {
  const r = await (await api("/api/refresh", { method: "POST" })).json();
  assert.equal(r.ok, true);
});

test("POST /api/notify-test → ok", async () => {
  const r = await (await api("/api/notify-test", { method: "POST" })).json();
  assert.equal(r.ok, true);
});

test("GET /api/progress → 结构（idle 或 running）", async () => {
  const r = await (await api("/api/progress")).json();
  assert.ok(r.status === "idle" || r.status === "running", `status=${r.status}`);
});

test("GET /api/schedule → events 数组", async () => {
  const r = await (await api("/api/schedule")).json();
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.events));
});

// ---------- 错误路径 ----------
test("POST /api/chat 非法 JSON body → 400 INVALID_JSON（契约统一错误格式，客户端错误不落 500）", async () => {
  const r = await api("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json" });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, "INVALID_JSON");
  assert.ok(j.issues, "结构化 issues");
});

test("POST /api/chat 缺 message → 400 VALIDATION_ERROR + issues（契约校验）", async () => {
  const r = await api("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, "VALIDATION_ERROR");
  assert.ok(Array.isArray(j.issues) && j.issues.length > 0);
});

test("未知路由 → 非 500（服务不崩）", async () => {
  const r = await api("/api/不存在的路由");
  assert.notEqual(r.status, 500);
});

// ---------- 讲解存档链路（工单 3b：detail/append/reset——假 key 天然测失败路径） ----------
// 策略说明：integration 用假 DEEPSEEK_API_KEY（不花钱）→ LLM 调用必失败 → 正好覆盖"生成失败不写档"；
// 正常生成路径在 tests/study-routes.test.mjs（mock LLM）覆盖。⑧⑪ 合并、⑨⑫ 合并（同场景）。

function insertPlanItem(dbPath, { id = "it1", topic = "事件循环", date = "2026-08-31" } = {}) {
  
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`INSERT OR REPLACE INTO study_plan_items (id, date, topic, why, source, verify_question, done, reviewed, level, from_interview, grp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, '必会', 0, 'JavaScript 核心', ?)`)
      .run(id, date, topic, "w", "s", `请简述：${topic}`, Date.now());
  } finally { db.close(); }
}

test("⑧⑪ study-detail-stream：参数错误路径（id 不存在 → 404；生成失败注入在单测层 study-routes ① 覆盖）", async () => {
  const r = await api(`/api/study-detail-stream?id=no-such-id&noSimilar=1`, { signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 404, "条目不存在 → 404");
  const text = await r.text();
  assert.ok(text.includes("条目不存在"), "错误提示");
});

test("⑨⑫ study-append：文件不存在 → 拒绝追问（提示先生成讲解）", async () => {
  insertPlanItem(path.join(dbDir, "test.db"), { id: "it9", topic: "zzz测试专用知识点2" });
  // 前置清理：确保"文件不存在"前提（CI 失败 saved=true——残留存档污染）。
  // 修复：widget 用 MIANSHI_OUTPUT_DIR=dbDir/output 启动（M8），存档在 dbDir/output/study_notes/
  // ——此前清理 ROOT/output/study_notes（M8 前的真实 output 路径）清不到，CI 上残留存档导致 saved:true
  try { rmSync(path.join(dbDir, "output", "study_notes", "zzz测试专用知识点2.md"), { force: true }); } catch { /* ignore */ }
  const r = await api(`/api/study-append-stream?id=it9&question=追问`, { signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  assert.ok(text.includes('"saved":false'), "不保存");
  assert.ok(text.includes("先点"), "提示先生成讲解");
});

test("⑩ study-note/reset：删除存档（幂等）", async () => {
  insertPlanItem(path.join(dbDir, "test.db"), { id: "it10", topic: "zzz测试专用知识点" });
  // 造存档到 widget 的 study_notes（临时 output 目录——M8：不写真实 output）
  const notesDir = path.join(dbDir, "output", "study_notes");
  mkdirSync(notesDir, { recursive: true });
  const f = path.join(notesDir, "zzz测试专用知识点.md");
  writeFileSync(f, "# zzz测试专用知识点\n\n## 题目\n讲解内容\n### 结论\n结论\n", "utf8");
  assert.equal(existsSync(f), true, "存档存在");
  try {
    const r = await api(`/api/study-note/reset`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "it10" }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(r.ok, true, "reset 成功");
    assert.equal(existsSync(f), false, "reset 删除存档");
  } finally {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});


