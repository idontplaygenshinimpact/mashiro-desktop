// 平台账号配置单测：读写/默认值/频率限制/投递计数（临时文件隔离）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpDir;
before(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "mianshi-pacc-"));
  process.env.MIANSHI_PLATFORM_ACCOUNTS = path.join(tmpDir, "accounts.json");
});
after(() => {
  delete process.env.MIANSHI_PLATFORM_ACCOUNTS;
  rmSync(tmpDir, { recursive: true, force: true });
});

test("loadAccounts：无文件时返回默认模板（boss 默认关闭/上限10/间隔30s）", async () => {
  const { loadAccounts } = await import("../lib/platform-accounts.mjs");
  const a = loadAccounts();
  assert.ok(a.boss, "boss 默认存在");
  assert.equal(a.boss.enabled, false);
  assert.equal(a.boss.applyDailyLimit, 10);
  assert.equal(a.boss.applyMinIntervalSec, 30);
  assert.equal(a.boss.applyCountToday, 0);
});

test("saveAccount：部分 patch 合并并持久化", async () => {
  const { saveAccount, loadAccounts } = await import("../lib/platform-accounts.mjs");
  saveAccount("boss", { enabled: true, greeting: "您好" });
  const a = loadAccounts();
  assert.equal(a.boss.enabled, true);
  assert.equal(a.boss.greeting, "您好");
  assert.equal(a.boss.applyDailyLimit, 10, "未 patch 的字段保留默认");
  assert.ok(existsSync(path.join(tmpDir, "accounts.json")), "已落盘");
});

test("checkApplyRateLimit：每日上限拦截", async () => {
  const { saveAccount, checkApplyRateLimit, recordApply } = await import("../lib/platform-accounts.mjs");
  saveAccount("boss", { enabled: true, applyDailyLimit: 2 });
  const now = Date.parse("2026-08-15T10:00:00Z");
  assert.equal(checkApplyRateLimit("boss", now).ok, true);
  recordApply("boss", now + 1000);
  recordApply("boss", now + 2000);
  const r = checkApplyRateLimit("boss", now + 3000);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("上限"), `理由含上限: ${r.reason}`);
});

test("checkApplyRateLimit：最小间隔拦截 + 跨天重置", async () => {
  const { saveAccount, checkApplyRateLimit, recordApply } = await import("../lib/platform-accounts.mjs");
  saveAccount("boss", { enabled: true, applyDailyLimit: 10, applyMinIntervalSec: 60 });
  const t1 = Date.parse("2026-08-15T10:00:00Z");
  recordApply("boss", t1);
  const r1 = checkApplyRateLimit("boss", t1 + 10 * 1000);
  assert.equal(r1.ok, false);
  assert.ok(r1.reason.includes("频繁"), "间隔不足被拦");
  assert.ok(r1.nextAt > t1, "给出下次可投时间");
  // 跨天：计数重置
  const t2 = Date.parse("2026-08-16T09:00:00Z");
  const r2 = checkApplyRateLimit("boss", t2);
  assert.equal(r2.ok, true);
  assert.equal(r2.remaining, 10, "跨天剩余恢复满额");
});

test("未启用平台 / 未知平台在注册表层被拦", async () => {
  const { registerPlatform, searchJobsOnPlatform } = await import("../lib/job-platforms.mjs");
  // 清理：注册表是模块级单例，这里直接注册一个唯一名 fake 平台验证路由
  registerPlatform({
    name: "pacc-fake",
    label: "Fake",
    async searchJobs() { return { ok: true, jobs: [] }; },
  });
  const r1 = await searchJobsOnPlatform("pacc-fake", "前端"); // 未启用
  assert.ok(r1.error, "未启用被拦");
  const r2 = await searchJobsOnPlatform("no-such", "前端");
  assert.ok(r2.error, "未知平台被拦");
});
