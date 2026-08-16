// 平台注册表单测：注册/路由/启用检查/投递频率限制链路（fake 平台 + 临时账号文件）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpDir;
before(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "mianshi-jp-"));
  process.env.MIANSHI_PLATFORM_ACCOUNTS = path.join(tmpDir, "accounts.json");
});
after(() => {
  delete process.env.MIANSHI_PLATFORM_ACCOUNTS;
  rmSync(tmpDir, { recursive: true, force: true });
});

const FAKE = {
  name: "fakeplat",
  label: "假平台",
  authRequired: true,
  authMethods: ["cookie"],
  searchJobs: async (kw) => ({ ok: true, jobs: [{ title: kw, company: "C", url: "https://x/job/1.html" }] }),
  fetchDetail: async () => ({ ok: true, title: "D", jdText: "JD" }),
  prepareApply: async () => ({ ok: true, detail: "已投递" }),
};

test("registerPlatform + getPlatform + listPlatforms", async () => {
  const { registerPlatform, getPlatform, listPlatforms } = await import("../lib/job-platforms.mjs");
  registerPlatform(FAKE);
  assert.equal(getPlatform("fakeplat").label, "假平台");
  assert.equal(getPlatform("nope"), null);
  const list = listPlatforms();
  assert.ok(list.some((p) => p.name === "fakeplat"), "列表包含 fake");
});

test("非法平台模块注册抛错", async () => {
  const { registerPlatform } = await import("../lib/job-platforms.mjs");
  assert.throws(() => registerPlatform({ name: "bad" }), "无 searchJobs 的模块拒绝");
});

test("searchJobsOnPlatform：未启用被拦 → 启用后路由成功", async () => {
  const { searchJobsOnPlatform } = await import("../lib/job-platforms.mjs");
  const { saveAccount } = await import("../lib/platform-accounts.mjs");
  const r0 = await searchJobsOnPlatform("fakeplat", "前端");
  assert.ok(r0.error, "未启用被拦");
  saveAccount("fakeplat", { enabled: true });
  const r = await searchJobsOnPlatform("fakeplat", "React");
  assert.equal(r.ok, true);
  assert.equal(r.jobs[0].title, "React");
});

test("searchJobsOnPlatform：空关键词 / 平台抛错 → error 不抛", async () => {
  const { registerPlatform, searchJobsOnPlatform } = await import("../lib/job-platforms.mjs");
  const { saveAccount } = await import("../lib/platform-accounts.mjs");
  registerPlatform({ name: "errplat", label: "Err", async searchJobs() { throw new Error("boom"); } });
  saveAccount("errplat", { enabled: true });
  const r1 = await searchJobsOnPlatform("errplat", "  ");
  assert.ok(r1.error, "空关键词被拦");
  const r2 = await searchJobsOnPlatform("errplat", "x");
  assert.ok(r2.error.includes("boom"), "平台异常转 error");
});

test("applyJobOnPlatform：频率限制优先 → 通过后执行并计数", async () => {
  const { registerPlatform, applyJobOnPlatform } = await import("../lib/job-platforms.mjs");
  const { saveAccount, loadAccounts } = await import("../lib/platform-accounts.mjs");
  let calls = 0;
  registerPlatform({
    name: "applyplat",
    label: "Apply",
    searchJobs: async () => ({ ok: true, jobs: [] }),
    prepareApply: async () => { calls++; return { ok: true, detail: "已投递" }; },
  });
  saveAccount("applyplat", { enabled: true, applyDailyLimit: 1 });
  const r = await applyJobOnPlatform("applyplat", "https://x/job/1");
  assert.equal(r.ok, true);
  assert.equal(calls, 1, "执行了一次投递");
  assert.equal(loadAccounts().applyplat.applyCountToday, 1, "投递计数 +1");
  // 第二次：达上限被拦，不执行
  const r2 = await applyJobOnPlatform("applyplat", "https://x/job/2");
  assert.equal(r2.ok, false);
  assert.equal(calls, 1, "上限后不再执行");
});

test("applyJobOnPlatform：未启用 / 未知平台被拦", async () => {
  const { registerPlatform, applyJobOnPlatform } = await import("../lib/job-platforms.mjs");
  // 独立未启用平台（避免与前面测试的启用状态共享）
  registerPlatform({
    name: "applyplat2",
    label: "Apply2",
    searchJobs: async () => ({ ok: true, jobs: [] }),
    prepareApply: async () => ({ ok: true }),
  });
  const r1 = await applyJobOnPlatform("nope", "https://x");
  assert.ok(r1.error, "未知平台被拦");
  const r2 = await applyJobOnPlatform("applyplat2", "https://x"); // 未启用
  assert.ok(r2.error, "未启用被拦");
});
