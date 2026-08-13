// jobs.mjs 测试：岗位入库/去重/推荐/状态 + 公司档案 + 官网搜集（mock fetch-page/LLM）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, mockFetchPage, setLlmResponses, setMockPages } from "./helpers.mjs";

const dbDir = setupTempDb("jobs");
mockLLM();
mockFetchPage();
const jobs = await import("../lib/jobs.mjs");

beforeEach(async () => {
  await clearAllTables();
  setMockPages([]);
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 岗位入库/去重 ----------
test("addJob 入库 + 覆盖更新（同公司+同岗位+同类型刷新字段，保留 jd_text）", () => {
  const r1 = jobs.addJob({ company: "字节跳动", title: "前端开发工程师", job_type: "校招", direction: "frontend", apply_url: "u1", deadline: "2026-08-01", summary: "旧摘要" });
  assert.ok(r1.id && !r1.dup);
  // 同三键重复 → 覆盖更新（刷新 deadline/summary；新值缺失时旧链接保留；jd_text 保留已有）
  const r2 = jobs.addJob({ company: "字节跳动", title: "前端开发工程师", job_type: "校招", deadline: "2026-09-15", summary: "新摘要" });
  assert.equal(r2.dup, true, "重复入库标记");
  assert.equal(r2.updated, true, "覆盖更新标记");
  const j = jobs.getJobs().find((x) => x.id === r1.id);
  assert.equal(j.deadline, "2026-09-15", "截止日期已刷新");
  assert.equal(j.summary, "新摘要", "摘要已刷新");
  assert.equal(j.applyUrl, "u1", "新值缺失时旧链接保留");
  const r3 = jobs.addJob({ company: "字节跳动", title: "Agent 工程师", job_type: "校招", direction: "agent" });
  assert.ok(!r3.dup, "不同岗位不重复");
  assert.equal(jobs.getJobs().length, 2);
});

test("addJob URL 去重：同公司+同详情页 URL 视为同一岗位（列表页 URL 不算）", () => {
  const a = jobs.addJob({ company: "字节跳动", title: "后端开发工程师", job_type: "校招", apply_url: "https://jobs.bytedance.com/campus/position/123/detail" });
  assert.ok(!a.dup);
  const b = jobs.addJob({ company: "字节跳动", title: "后端开发工程师（可内推）", job_type: "校招", apply_url: "https://jobs.bytedance.com/campus/position/123/detail" });
  assert.equal(b.updated, true, "同详情页 URL → 覆盖更新");
  assert.equal(b.dup, true);
  assert.equal(jobs.getJobs().length, 1, "同 URL 不新增行");
  // 列表兜底 URL（多岗位共用）不算同一岗位
  const c = jobs.addJob({ company: "美团", title: "岗位A", job_type: "校招", apply_url: "https://campus.meituan.com/positions" });
  const d = jobs.addJob({ company: "美团", title: "岗位B", job_type: "校招", apply_url: "https://campus.meituan.com/positions" });
  assert.ok(c.id && !c.dup);
  assert.equal(d.dup, false, "列表页 URL 不触发去重");
  assert.equal(jobs.getJobs().length, 3);
});

test("fetchJobDetails：官网详情页抓 JD 正文入库 + 列表页/非官网跳过 + 24h 幂等", async () => {
  setMockPages([
    { title: "岗位详情", text: "前端开发工程师（校招）\n岗位职责：负责 Web 前端开发、性能优化与工程化建设，参与核心业务迭代。\n任职要求：精通 JavaScript、TypeScript、React，熟悉 Node.js，有组件库或脚手架开发经验者优先。\n工作地点：北京。\n截止时间：2026-09-30。" },
  ]);
  setLlmResponses('{"deadline":"2026-09-30","bishi_date":"","city":"北京","batch":"秋招"}');
  const r1 = jobs.addJob({ company: "字节跳动", title: "前端开发工程师", job_type: "校招", source: "字节跳动官网", apply_url: "https://jobs.bytedance.com/campus/position/123/detail" });
  jobs.addJob({ company: "美团", title: "前端实习", job_type: "实习", source: "美团官网", apply_url: "https://campus.meituan.com/positions" }); // 列表兜底
  jobs.addJob({ company: "京东", title: "前端", job_type: "校招", source: "京东官网", apply_url: "https://campus.jd.com/#/jobs" }); // hash
  jobs.addJob({ company: "牛客公司", title: "后端", job_type: "校招", source: "牛客", apply_url: "https://www.nowcoder.com/discuss/123" }); // 非官网 source
  const res = await jobs.fetchJobDetails();
  assert.equal(res.total, 1, "只有字节详情页计入");
  assert.equal(res.done, 1, "详情页抓取成功");
  assert.equal(res.failed, 0);
  const j = jobs.getJobs().find((x) => x.id === r1.id);
  assert.ok(j.jdText.includes("前端开发工程师"), "JD 正文已入库");
  assert.ok(j.jdText.length <= 4000, "正文截断 4000 字符");
  assert.equal(j.deadline, "2026-09-30", "LLM 提取的截止日期已覆盖");
  // 幂等：jd_text 非空且 updated_at 24h 内 → 跳过
  const res2 = await jobs.fetchJobDetails();
  assert.equal(res2.skipped, 1, "24h 内幂等跳过");
  assert.equal(res2.done, 0);
});

test("addJob 缺 company/title 跳过 + 默认值", () => {
  assert.equal(jobs.addJob({}), null);
  assert.equal(jobs.addJob({ company: "A" }), null);
  const r = jobs.addJob({ company: "B", title: "前端" }); // 无 direction/job_type
  assert.ok(r.id);
  const j = jobs.getJobs()[0];
  assert.equal(j.jobType, "校招", "默认校招");
  assert.equal(j.direction, "other", "默认 other");
});

// ---------- 推荐排序 ----------
test("getRecommendedJobs 排序：新岗位 + 高匹配优先", () => {
  jobs.addJob({ company: "A", title: "前端工程师", job_type: "校招", direction: "frontend", deadline: "2026-09-01" });
  jobs.addJob({ company: "B", title: "Java 后端", job_type: "校招", direction: "backend" });
  jobs.addJob({ company: "C", title: "Agent 研发", job_type: "校招", direction: "agent" });
  const rec = jobs.getRecommendedJobs();
  assert.equal(rec[0].company, "C", "agent 高匹配优先");
  assert.ok(rec[0].match >= rec[1].match);
});

test("setJobStatus 状态流转 + 非法状态拒绝", () => {
  const r = jobs.addJob({ company: "A", title: "前端", job_type: "校招", direction: "frontend" });
  assert.equal(jobs.setJobStatus(r.id, "ready").ok, true);
  assert.equal(jobs.getJobs()[0].status, "ready");
  assert.equal(jobs.setJobStatus(r.id, "nope").ok, false, "非法状态拒绝");
  assert.equal(jobs.setJobStatus("不存在", "ready").ok, false);
});

// ---------- 公司档案 ----------
test("addCompanyProfile 建档 + 更新 + 列表", () => {
  jobs.addCompanyProfile({ company: "中厂X", scale: "中厂", description: "做 XX 业务" });
  jobs.addCompanyProfile({ company: "中厂X", url: "https://career.x.com" }); // 更新补官网
  const companies = jobs.getCompanies();
  assert.equal(companies.length, 1);
  assert.equal(companies[0].hasCareerSite, true);
  assert.equal(companies[0].scale, "中厂");
  assert.equal(jobs.getCompanies({ hasCareerSite: false }).length, 0);
});

// ---------- 官网搜集（mock 页面 + mock LLM 提取） ----------
test("collectFromOfficialSites：mock 官网页 → 岗位入库", async () => {
  // 页面返回公司岗位列表文本；LLM 提取岗位
  setMockPages([{ title: "xx公司校招", text: "前端开发工程师 校招 地点：北京 截止2026-09-01", links: [] }]);
  setLlmResponses('{"jobs":[{"company":"测试公司","title":"前端开发工程师","job_type":"校招","direction":"frontend","apply_url":"https://career.test.com","deadline":"2026-09-01","summary":"负责前端"}]}');
  const r = await jobs.collectFromOfficialSites();
  assert.ok(r.totalNew >= 1, "官网搜集到岗位");
  assert.ok(jobs.getJobs().some((j) => j.company === "测试公司"));
});

test("非技术岗过滤：运营/营销岗不入推荐", () => {
  jobs.addJob({ company: "美团", title: "销售招聘实习生", job_type: "实习", direction: "other", summary: "协助招聘经理完成销售岗位招聘" });
  jobs.addJob({ company: "美团", title: "前端开发实习生", job_type: "实习", direction: "frontend", summary: "负责 Web 前端开发 React" });
  const rec = jobs.getRecommendedJobs();
  assert.ok(rec.every((j) => !j.title.includes("销售招聘")), "非技术岗被排除");
  assert.ok(rec.some((j) => j.title.includes("前端开发")), "技术岗保留");
});

test("extractJobFromText 从招聘帖提取岗位", async () => {
  setLlmResponses('{"company":"某中厂","title":"前端实习","job_type":"实习","direction":"frontend","apply_url":"","deadline":"","bishi_date":"","summary":"Vue 开发"}');
  const j = await jobs.extractJobFromText({ title: "某中厂实习招聘", text: "招前端实习生，要求 Vue…", url: "u", source: "牛客" });
  assert.equal(j.company, "某中厂");
  assert.equal(j.direction, "frontend");
  const r = jobs.addJob(j);
  assert.ok(r.id);
});

// ---------- 简历画像驱动匹配 + 意向方向 ----------
test("setResumeProfile 提取技能画像 + 影响推荐排序", async () => {
  setLlmResponses('{"skills":["React","TypeScript","AI Agent","LLM"],"directions":["agent"]}');
  const r = await jobs.setResumeProfile("简历：用过 React/TS，做过 AI Agent 项目");
  assert.equal(r.ok, true);
  assert.ok(r.skills.includes("React"));

  // 两个岗位：一个 Agent 相关（技能命中），一个纯后端
  jobs.addJob({ company: "A", title: "AI Agent 研发工程师", job_type: "校招", direction: "agent", summary: "LLM 应用开发，React 前端" });
  jobs.addJob({ company: "B", title: "Java 后端开发", job_type: "校招", direction: "backend" });
  const rec = jobs.getRecommendedJobs();
  assert.equal(rec[0].company, "A", "简历技能命中的岗位优先");
});

test("setTargetDirection + generateDirectionAdvice", async () => {
  setLlmResponses('{"skills":["Vue","JavaScript"],"directions":["frontend"]}');
  await jobs.setResumeProfile("简历：Vue 前端");
  assert.equal(jobs.setTargetDirection("nope").ok, false, "非法方向拒绝");
  assert.equal(jobs.setTargetDirection("agent").ok, true);
  assert.equal(jobs.getTargetDirection(), "agent");

  setLlmResponses("## 差距分析\n当前偏传统前端，需补充 LLM/Agent 相关技能\n## 简历调整建议\n突出 Agent 项目\n## 需补充\n1. LangChain 2. MCP");
  const advice = await jobs.generateDirectionAdvice();
  assert.equal(advice.ok, true);
  assert.ok(advice.advice.includes("差距分析"));
  assert.ok(advice.advice.includes("Agent"));
});

test("setResumeProfile 存档原文（resume_raw）", async () => {
  setLlmResponses('{"skills":["React"],"directions":["frontend"]}');
  const r = await jobs.setResumeProfile("我的简历原文：React 项目经历……");
  assert.equal(r.ok, true);
  assert.equal(r.savedRaw, true);
  const raw = jobs.getResumeRaw();
  assert.ok(raw, "原文已保存");
  assert.ok(raw.text.includes("React 项目经历"), "原文内容完整");
  assert.ok(raw.updatedAt > 0, "记录更新时间");
});

test("collectJobsDaily 24h 门控（幂等：短间隔内跳过）", async () => {
  // mock LLM 返回空岗位/空公司（无新增）；mock 页面给官网抓取用
  setLlmResponses(
    '{"jobs":[]}',  // collectFromOfficialSites 提取
    '{"companies":[]}', // collectCompanyList
    '{"jobs":[]}'   // collectJobsForCompaniesWithoutSite
  );
  setMockPages([{ text: "校招岗位列表内容足够长，用于抓取", invalid: false, links: [] }]);
  const r1 = await jobs.collectJobsDaily();
  assert.equal(r1.ok, true);
  assert.ok(!r1.skipped, "首次执行不跳过");
  assert.ok(jobs.getJobsLastCollect() > 0, "持久化上次搜集时间");

  // 24h 内再次调用 → 跳过
  const r2 = await jobs.collectJobsDaily();
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true, "24h 内跳过");
});
