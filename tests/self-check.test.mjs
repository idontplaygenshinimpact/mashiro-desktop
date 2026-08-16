// 系统自检测试：表堆积自动清理 / 产出污染检测 / 巡检停摆 / LLM 失败率 / 错误日志 / 正常态
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dbDir = setupTempDb("self-check");
const sc = await import("../lib/self-check.mjs");
const { db } = await import("../lib/db.mjs");

// 临时产出目录（隔离真实 output）
const outDir = mkdtempSync(path.join(tmpdir(), "mianshi-sc-out-"));

function insertTrace(ok, n) {
  const ins = db.prepare("INSERT INTO trace_llm (ts, role, model, stream, input_tokens, output_tokens, duration_ms, ok, error, endpoint) VALUES (?, 'agent', 'test', 0, 10, 10, 100, ?, NULL, 'http://x')");
  for (let i = 0; i < n; i++) ins.run(Date.now(), ok ? 1 : 0);
}

beforeEach(async () => {
  await clearAllTables();
  db.prepare("DELETE FROM chat_history").run();
  db.prepare("DELETE FROM trace_llm").run();
  db.prepare("DELETE FROM seen_urls").run();
});

test("表堆积：chat_history 超 200 自动清理，报告标记 fixed", () => {
  const ins = db.prepare("INSERT INTO chat_history (role, content, ts) VALUES ('user', ?, ?)");
  for (let i = 0; i < 250; i++) ins.run(`msg${i}`, Date.now());
  const r = sc.runSelfCheck({ outputDir: outDir });
  const n = db.prepare("SELECT COUNT(*) n FROM chat_history").get().n;
  assert.equal(n, 200, "清理后剩 200");
  const issue = r.issues.find((i) => i.name === "数据表堆积");
  assert.ok(issue, "报告含堆积问题");
  assert.equal(issue.fixed, true, "标记已修复");
  assert.equal(r.ok, false, "有 warn 则整体 ok=false（供通知判断）");
});

test("seen_urls 超 1000 自动清理", () => {
  const ins = db.prepare("INSERT OR IGNORE INTO seen_urls (url, seen_at) VALUES (?, ?)");
  for (let i = 0; i < 1200; i++) ins.run(`https://x.com/${i}`, Date.now());
  sc.runSelfCheck({ outputDir: outDir });
  const n = db.prepare("SELECT COUNT(*) n FROM seen_urls").get().n;
  assert.equal(n, 1000);
});

test("产出目录异常小文件：<300B 的 md 被报告", () => {
  const sub = path.join(outDir, "chat_solutions");
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, "2026-08-16_000001_测试.md"), "# 空讲解\n", "utf8"); // 15B
  writeFileSync(path.join(sub, "正常讲解.md"), "# 结论\n" + "内容".repeat(300), "utf8"); // >300B
  const r = sc.runSelfCheck({ outputDir: outDir });
  const issue = r.issues.find((i) => i.name === "产出目录异常");
  assert.ok(issue, "报告含污染问题");
  assert.ok(issue.detail.includes("测试"), "点名异常文件");
  assert.ok(!issue.fixed, "只报告不自动删（防误删真实笔记）");
  rmSync(sub, { recursive: true, force: true });
});

test("巡检停摆：lastRun 超过 2 倍间隔被报告；正常不报告", () => {
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('patrol_last_run', ?, ?)").run(String(now - 3 * 3600 * 1000), now); // 3h 前
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('patrol_interval_min', '60', ?)").run(String(now));
  let r = sc.runSelfCheck({ outputDir: outDir, now });
  assert.ok(r.issues.some((i) => i.name === "自动巡检疑似停摆"), "3h 未巡检（间隔 60min）→ 报告");
  // 正常：20 分钟前跑过
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('patrol_last_run', ?, ?)").run(String(now - 20 * 60 * 1000), now);
  r = sc.runSelfCheck({ outputDir: outDir, now });
  assert.ok(!r.issues.some((i) => i.name === "自动巡检疑似停摆"), "20 分钟前跑过 → 正常");
});

test("LLM 失败率：>30% 报告；正常态不报告", () => {
  insertTrace(false, 40); // 40 次全失败
  let r = sc.runSelfCheck({ outputDir: outDir });
  assert.ok(r.issues.some((i) => i.name === "LLM 调用失败率高"), "40/40 失败 → 报告");
  db.prepare("DELETE FROM trace_llm").run();
  insertTrace(true, 40);
  insertTrace(false, 2);
  r = sc.runSelfCheck({ outputDir: outDir });
  assert.ok(!r.issues.some((i) => i.name === "LLM 调用失败率高"), "2/42 失败 → 正常");
});

test("全绿时 ok=true、无 issues", () => {
  const r = sc.runSelfCheck({ outputDir: outDir });
  assert.equal(r.ok, true);
  assert.equal(r.issues.length, 0);
  assert.ok(Array.isArray(r.checks) && r.checks.length > 5, "检查项齐全");
});

test("报告持久化：saveSelfCheck/getLastSelfCheck 往返", () => {
  const r = sc.runSelfCheck({ outputDir: outDir });
  sc.saveSelfCheck(r);
  const back = sc.getLastSelfCheck();
  assert.ok(back, "能读回");
  assert.equal(back.at, r.at);
});

cleanupTempDb(dbDir);
rmSync(outDir, { recursive: true, force: true });
