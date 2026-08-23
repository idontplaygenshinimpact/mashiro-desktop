// 平台注册表单测：注册/路由/启用检查/投递频率限制链路（fake 平台 + 临时账号文件）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

let tmpDir;
const dbDir = setupTempDb("job-platforms"); // 隔离 DB：searchAndStoreJobs 入库测试不污染真实 mianshi.db（须在任何动态 import 之前）
before(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "mianshi-jp-"));
  process.env.MIANSHI_PLATFORM_ACCOUNTS = path.join(tmpDir, "accounts.json");
  await clearAllTables();
});
after(() => {
  delete process.env.MIANSHI_PLATFORM_ACCOUNTS;
  rmSync(tmpDir, { recursive: true, force: true });
  cleanupTempDb(dbDir);
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

test("searchAndStoreJobs：direction/job_type 从 title 推断（修复：原硬编码 frontend/校招）", async () => {
  const { registerPlatform, searchAndStoreJobs } = await import("../lib/job-platforms.mjs");
  const { saveAccount } = await import("../lib/platform-accounts.mjs");
  const { db } = await import("../lib/db.mjs");
  registerPlatform({
    name: "inferplat",
    label: "Infer",
    searchJobs: async () => ({
      ok: true,
      jobs: [
        { title: "前端开发工程师", company: "A", url: "https://x/1.html", salary: "20K", location: "北京" },
        { title: "AI Agent 研发实习生", company: "B", url: "https://x/2.html", salary: "", location: "" },
        { title: "Java 后端开发", company: "C", url: "https://x/3.html" },
        { title: "算法工程师", company: "D", url: "https://x/4.html" },
        { title: "产品经理", company: "E", url: "https://x/5.html" },
      ],
    }),
  });
  saveAccount("inferplat", { enabled: true });
  const r = await searchAndStoreJobs("inferplat", "岗位");
  assert.equal(r.ok, true);
  assert.equal(r.addedCount, 5);
  const rows = db.prepare("SELECT company, direction, job_type FROM job_posts ORDER BY company").all();
  const by = Object.fromEntries(rows.map((x) => [x.company, x]));
  assert.equal(by["A"].direction, "frontend", "前端关键词 → frontend");
  assert.equal(by["A"].job_type, "校招");
  assert.equal(by["B"].direction, "agent", "AI Agent → agent");
  assert.equal(by["B"].job_type, "实习", "标题含实习 → 实习");
  assert.equal(by["C"].direction, "backend", "Java 后端 → backend");
  assert.equal(by["D"].direction, "algorithm", "算法 → algorithm");
  assert.equal(by["E"].direction, "other", "无关键词 → other");
});
