// 流式链路故障注入工单任务 2：LLM 挂起（MIANSHI_MOCK_LLM=hang）→ 流式链路超时 error + 连接关闭
// 独立 spawn（hang 模式 + 短超时 env——测试用 3s，生产默认 60s；验证超时路径真实触发而非 60s 等待）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "hang-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const dbDir = mkdtempSync(path.join(tmpdir(), "mianshi-hang-"));
let child, childErr = "";

function api(p, opts = {}) {
  return fetch(`${BASE}${p}`, { ...opts, headers: { ...AUTH, ...(opts.headers || {}) } });
}
async function waitReady(timeoutMs = 30000) {
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
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      MIANSHI_PORT: String(PORT),
      MIANSHI_DB_PATH: path.join(dbDir, "test.db"),
      MIANSHI_OUTPUT_DIR: path.join(dbDir, "output"),
      MIANSHI_DISABLE_PATROL: "1",
      MIANSHI_DISABLE_BACKGROUND: "1",
      MIANSHI_MOCK_LLM: "hang", // 挂起模式：LLM 永不返回——路由 withLLMTimeout 超时分支真实触发
      MIANSHI_LLM_TIMEOUT_MS: "3000", // 测试用短超时（生产默认 60s——快速验证超时链路，3s 也在"60s 内"）
      MIANSHI_TOKEN: TOKEN,
      DEEPSEEK_API_KEY: "sk-test-dummy",
    },
  });
  child.stderr.on("data", (d) => { childErr += d; });
  const ready = await waitReady();
  if (!ready) console.log(`[hang-test] widget 未就绪: ${childErr.slice(0, 1000)}`);
  assert.ok(ready, `widget ${BASE} 未就绪`);
  // 造清单条目 + 讲解存档（consolidate 需要 content ≥200 字；detail 用无存档条目走生成路径）
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dbDir, "test.db"));
  db.exec("INSERT OR REPLACE INTO study_plan_items (id, topic, why, source, verify_question, level, done, reviewed, grp, date, created_at) VALUES ('hang1','事件循环','w','s','q','必会',0,0,'JavaScript 核心','2026-09-07',1)");
  db.exec("INSERT OR REPLACE INTO study_plan_items (id, topic, why, source, verify_question, level, done, reviewed, grp, date, created_at) VALUES ('hang2','闭包','w','s','q','必会',0,0,'JavaScript 核心','2026-09-07',1)");
  db.close();
  const notesDir = path.join(dbDir, "output", "study_notes");
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "事件循环.md"), "# 事件循环讲解\n\n" + "宏任务微任务执行顺序详解。".repeat(40), "utf8");
});
after(async () => {
  if (child && !child.killed) {
    child.kill();
    await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  }
  try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 读 SSE 流直到 error/done 事件或超时；返回事件数组 */
async function readSse(pathname, timeoutMs = 15000) {
  const events = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await api(pathname, { signal: controller.signal });
    assert.equal(res.status, 200, `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
        }
      }
      if (events.some((e) => e.type === "error" || e.type === "done")) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

// ---------- 故障注入：3 条流式链路挂起 → 超时 error + 连接关闭 ----------
test("故障注入①：study-detail-stream LLM 挂起 → 超时 error（不挂死）", async () => {
  const t0 = Date.now();
  const events = await readSse("/api/study-detail-stream?id=hang2", 15000); // hang2 无存档 → 走流式生成（hang）
  const err = events.find((e) => e.type === "error");
  assert.ok(err, `收到 error 事件（实际: ${events.map((e) => e.type).join(",")}）`);
  assert.match(String(err.error || ""), /超时/, "超时错误信息");
  assert.ok(Date.now() - t0 < 12000, "连接在超时后关闭（不挂死）");
});

test("故障注入②：study-append-stream LLM 挂起 → 超时 error", async () => {
  // 纯英文独特问题（防命中 followup 语义缓存——相似度匹配会命中"事件循环"相关历史追问）
  const events = await readSse("/api/study-append-stream?id=hang1&question=HANGTEST-9f3a-xyz", 15000);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "收到 error 事件");
  assert.match(String(err.error || ""), /超时/, "超时错误信息");
});

test("故障注入③：study-consolidate-stream LLM 挂起 → 超时 error", async () => {
  const events = await readSse("/api/study-consolidate-stream?id=hang1", 15000);
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "收到 error 事件");
  assert.match(String(err.error || ""), /超时/, "超时错误信息");
});
