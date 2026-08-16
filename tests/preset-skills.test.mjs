// 预设技能测试：5 个内置技能加载/形态/工具路由/mock LLM 跑通
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses, mockFetchPage, setMockPages } from "./helpers.mjs";

let tmpDir;
before(() => {
  tmpDir = setupTempDb("preset");
  mockLLM();
  mockFetchPage();
});
after(() => cleanupTempDb(tmpDir));

test("预设技能全部加载（5 个：3 声明 + 2 可编程）", async () => {
  const { loadSkills, getSkillTools, getSkillHints } = await import("../lib/skills.mjs");
  const r = await loadSkills(); // 生产目录
  for (const name of ["frontend-cheatsheet", "interview-warmup", "tech-compare", "resume-coach", "company-intel", "github-repo"]) {
    assert.ok(r.names.includes(name), `预设技能 ${name} 已加载`);
  }
  // 形态验证：3 个纯声明（无工具）+ 3 个有工具
  const tools = getSkillTools();
  const toolNames = tools.map((t) => t.function.name);
  assert.ok(!toolNames.some((n) => n.startsWith("skill__frontend-cheatsheet")), "frontend-cheatsheet 纯声明");
  assert.ok(toolNames.includes("skill__resume-coach__review_resume"), "resume-coach 有工具");
  assert.ok(toolNames.includes("skill__company-intel__collect_company_intel"), "company-intel 有工具");
  assert.ok(toolNames.includes("skill__github-repo__get_repo_info"), "github-repo 有工具");
  // hints 注入（声明技能的使用说明进 system prompt）
  const hints = getSkillHints();
  assert.ok(hints.some((h) => h.name === "frontend-cheatsheet"), "八股速查 hint 注入");
  assert.ok(hints.some((h) => h.name === "interview-warmup"), "面试热身 hint 注入");
});

test("预设技能工具权限为 auto（只读）", async () => {
  const { getSkillPermission } = await import("../lib/skills.mjs");
  assert.equal(getSkillPermission("skill__resume-coach__review_resume"), "auto");
  assert.equal(getSkillPermission("skill__company-intel__collect_company_intel"), "auto");
});

test("review_resume：简历优化工具 mock LLM 跑通（结构化输出）", async () => {
  const { callSkillTool } = await import("../lib/skills.mjs");
  setLlmResponses('{"highlights":["项目经历完整"],"risks":["无量化结果"],"improvements":[{"issue":"描述笼统","fix":"加数字","example":"性能提升 40%"}],"interviewQuestions":["讲一下项目难点"]}');
  const r = await callSkillTool("skill__resume-coach__review_resume", {
    resume: "2026 届前端方向应届生，曾在某互联网公司前端组实习三个月，负责内部管理系统的页面开发与组件封装，参与过一次性能优化专项。",
    target: "前端校招",
  });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.highlights) && r.highlights.length >= 1);
  assert.ok(r.risks.some((x) => x.includes("量化")), "风险含量化建议");
  assert.ok(Array.isArray(r.interviewQuestions) && r.interviewQuestions.length >= 1);
});

test("review_resume：简历太短 → error 不抛", async () => {
  const { callSkillTool } = await import("../lib/skills.mjs");
  const r = await callSkillTool("skill__resume-coach__review_resume", { resume: "太短" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("太短"));
});

test("collect_company_intel：公司面经情报 mock 链路跑通（搜索→抓页→汇总）", async () => {
  const { callSkillTool } = await import("../lib/skills.mjs");
  // mock 页面序列：牛客搜索页(3 条链接，<4 不触发 AI 挑帖) → 掘金搜索页(空) → Bing 搜索页(空) → 正文页
  setMockPages([
    { links: [
      { text: "字节前端一面面经", href: "https://www.nowcoder.com/discuss/1001" },
      { text: "字节前端二面面经", href: "https://www.nowcoder.com/discuss/1002" },
      { text: "字节前端笔试", href: "https://www.nowcoder.com/discuss/1003" },
    ] },
    { links: [] },
    { links: [] },
    { text: "面试问了事件循环、React Hooks、手写防抖。".repeat(20), title: "字节前端面经" },
  ]);
  setLlmResponses('{"topTopics":["事件循环","React Hooks","手写防抖"],"patterns":["重手写"],"advice":["优先补手写"]}');
  const r = await callSkillTool("skill__company-intel__collect_company_intel", { company: "字节跳动", position: "前端" });
  assert.equal(r.ok, true);
  assert.ok(r.topTopics.includes("事件循环"), "考点提炼");
  assert.ok(r.sources.length >= 1, "带来源链接");
});

test("collect_company_intel：无搜索结果 → 明确 error", async () => {
  const { callSkillTool } = await import("../lib/skills.mjs");
  setMockPages([{ links: [] }]); // 空搜索页
  const r = await callSkillTool("skill__company-intel__collect_company_intel", { company: "不存在的公司" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("没找到"), "提示换关键词");
});
