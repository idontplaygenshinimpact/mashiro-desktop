// job-collect.mjs 测试：官网搜集/公司档案/公司名单/中厂兜底/每日门控（mock fetch-page/LLM）
// 纵向拆分第 2 刀：搜集管线从 jobs.mjs 拆出后独立直测
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, mockFetchPage, setLlmResponses, setMockPages, getLastMessages } from "./helpers.mjs";

const dbDir = setupTempDb("job-collect");
mockLLM();
mockFetchPage();
// 搜集域直连（jobs.mjs 为数据层，经桶 re-export 保持引用方兼容）
const collect = await import("../lib/job-collect.mjs");
const jobs = await import("../lib/jobs.mjs");

beforeEach(async () => {
  await clearAllTables();
  setMockPages([]);
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 公司档案 ----------
test("addCompanyProfile 建档 + 更新 + 列表", () => {
  collect.addCompanyProfile({ company: "中厂X", scale: "中厂", description: "做 XX 业务" });
  collect.addCompanyProfile({ company: "中厂X", url: "https://career.x.com" }); // 更新补官网
  const companies = collect.getCompanies();
  assert.equal(companies.length, 1);
  assert.equal(companies[0].hasCareerSite, true);
  assert.equal(companies[0].scale, "中厂");
  assert.equal(collect.getCompanies({ hasCareerSite: false }).length, 0);
});

// ---------- 官网搜集（mock 页面 + mock LLM 提取） ----------
test("collectFromOfficialSites：mock 官网页 → 岗位入库", async () => {
  // 页面返回公司岗位列表文本；LLM 提取岗位
  setMockPages([{ title: "xx公司校招", text: "前端开发工程师 校招 地点：北京 截止2026-09-01", links: [] }]);
  setLlmResponses('{"jobs":[{"company":"测试公司","title":"前端开发工程师","job_type":"校招","direction":"frontend","apply_url":"https://career.test.com","deadline":"2026-09-01","summary":"负责前端"}]}');
  const r = await collect.collectFromOfficialSites();
  assert.ok(r.totalNew >= 1, "官网搜集到岗位");
  assert.ok(jobs.getJobs().some((j) => j.company === "测试公司"));
});

test("extractJobFromText 从招聘帖提取岗位", async () => {
  setLlmResponses('{"company":"某中厂","title":"前端实习","job_type":"实习","direction":"frontend","apply_url":"","deadline":"","bishi_date":"","summary":"Vue 开发"}');
  const j = await collect.extractJobFromText({ title: "某中厂实习招聘", text: "招前端实习生，要求 Vue…", url: "u", source: "牛客" });
  assert.equal(j.company, "某中厂");
  assert.equal(j.direction, "frontend");
  const r = jobs.addJob(j);
  assert.ok(r.id);
});

test("extractJobsFromTextList：linkHints 也按不可信数据包裹（修复：外部链接文本直拼 prompt）", async () => {
  setMockPages([{ title: "xx公司校招", text: "前端开发工程师 校招 地点：北京 截止2026-09-01", links: [{ href: "https://career.xx.com/position/1", text: "前端开发工程师" }] }]);
  setLlmResponses('{"jobs":[{"company":"测试公司","title":"前端开发工程师","job_type":"校招","direction":"frontend","apply_url":"https://career.xx.com/position/1","deadline":"2026-09-01","summary":"负责前端"}]}');
  await collect.collectFromOfficialSites();
  const msgs = getLastMessages();
  const user = msgs.find((m) => m.role === "user")?.content || "";
  assert.ok(user.includes("<untrusted_data>"), "linkHints 被包裹在不可信标记内");
  assert.ok(user.includes("career.xx.com/position/1"), "链接内容仍传入");
});

test("collectJobsDaily 24h 门控（幂等：短间隔内跳过）", async () => {
  // mock LLM 返回空岗位/空公司（无新增）；mock 页面给官网抓取用
  setLlmResponses(
    '{"jobs":[]}',  // collectFromOfficialSites 提取
    '{"companies":[]}', // collectCompanyList
    '{"jobs":[]}'   // collectJobsForCompaniesWithoutSite
  );
  setMockPages([{ text: "校招岗位列表内容足够长，用于抓取", invalid: false, links: [] }]);
  const r1 = await collect.collectJobsDaily();
  assert.equal(r1.ok, true);
  assert.ok(!r1.skipped, "首次执行不跳过");
  assert.ok(collect.getJobsLastCollect() > 0, "持久化上次搜集时间");

  // 24h 内再次调用 → 跳过
  const r2 = await collect.collectJobsDaily();
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true, "24h 内跳过");
});
