// BOSS 直聘平台单测：解析纯函数（不碰真实浏览器/网络）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseJobCards, parseJobDetail, detectBlock, parseCookieHeader, platform,
} from "../lib/platforms/boss.mjs";

const FIX = (f) => path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", f);

test("platform 模块结构符合注册表契约", () => {
  assert.equal(platform.name, "boss");
  assert.equal(platform.label, "BOSS 直聘");
  assert.equal(platform.authRequired, true);
  assert.ok(platform.authMethods.includes("cookie"));
  assert.equal(typeof platform.searchJobs, "function");
  assert.equal(typeof platform.fetchDetail, "function");
  assert.equal(typeof platform.prepareApply, "function");
});

test("parseJobCards：提取岗位卡片（标题/公司/薪资/地点/URL），跳过无链接项", () => {
  const jobs = parseJobCards(readFileSync(FIX("boss-search.html"), "utf8"));
  assert.equal(jobs.length, 2, "无详情链接的卡片被跳过");
  const j0 = jobs[0];
  assert.equal(j0.id, "abc123");
  assert.ok(j0.title.includes("前端开发工程师"));
  assert.equal(j0.company, "字节跳动");
  assert.equal(j0.salary, "20-40K·16薪");
  assert.equal(j0.location, "北京·海淀区");
  assert.equal(j0.url, "https://www.zhipin.com/job_detail/abc123.html");
  assert.equal(jobs[1].id, "def456");
});

test("parseJobDetail：提取标题/公司/薪资/JD正文/标签", () => {
  const d = parseJobDetail(readFileSync(FIX("boss-detail.html"), "utf8"));
  assert.ok(d.title.includes("前端开发工程师"));
  assert.equal(d.company, "字节跳动");
  assert.equal(d.salary, "20-40K·16薪");
  assert.ok(d.jdText.includes("职位描述"));
  assert.ok(d.jdText.includes("React"), "JD 正文包含技术栈");
  assert.ok(d.tags.includes("React") && d.tags.includes("校招"));
});

test("detectBlock：风控/未登录识别，正常页返回 null", () => {
  assert.ok(detectBlock("", "请完成安全验证").includes("风控"));
  assert.ok(detectBlock("", "滑动验证").includes("风控"));
  assert.ok(detectBlock("", "请登录后查看").includes("未登录"));
  assert.equal(detectBlock("<div>岗位列表</div>", "招聘"), null);
});

test("parseCookieHeader：Cookie 头解析为 Playwright cookie（含域/路径）", () => {
  const cookies = parseCookieHeader("a=1; b=hello%20world; c=");
  assert.equal(cookies.length, 2, "空值对跳过");
  assert.equal(cookies[0].name, "a");
  assert.equal(cookies[0].value, "1");
  assert.equal(cookies[0].domain, ".zhipin.com");
  assert.equal(cookies[0].path, "/");
  assert.deepEqual(parseCookieHeader(""), []);
});
