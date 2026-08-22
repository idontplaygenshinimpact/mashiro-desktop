// 路由注册表回归测试：把 widget.mjs 的全部域路由注册到 fake router，
// 断言关键路径齐全（防纵向拆分再次丢路由——曾丢过 focus/start·stop·distract、
// jobs/profile GET、rss/check、mail/test·check 共 7 条方法门控路由）
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

const tmpDir = setupTempDb("routes-registry");

// 原版 widget.mjs（git HEAD 之前）的全部内联路由路径——拆分后必须一个不少
const ORIGINAL_PATHS = [
  "/api/health", "/api/widget-data", "/api/chat", "/api/study-plan",
  "/api/study-detail-stream", "/api/study-append-stream", "/api/study-consolidate-stream",
  "/api/study-cluster-stream", "/api/study-detail", "/api/study-generate",
  "/api/study-check", "/api/study-review", "/api/study-answer",
  "/api/interview/start", "/api/interview/answer", "/api/interview/end", "/api/interview/history",
  "/api/stats", "/api/observability", "/api/refresh", "/api/notify-test",
  "/api/jobs/profile", "/api/jobs/direction", "/api/jobs", "/api/jobs/recommended",
  "/api/jobs/status", "/api/jobs/favorite", "/api/jobs/daily-collect", "/api/jobs/collect",
  "/api/jobs/fetch-details", "/api/companies", "/api/zhenti", "/api/oj/problems",
  "/api/oj/detail", "/api/oj/collect-all-stream", "/api/oj/collect",
  "/api/zhenti/collect", "/api/zhenti/cookie", "/api/zhenti/questions", "/api/zhenti/wrong",
  "/api/zhenti/plan", "/api/resume-plan", "/api/approval-pending", "/api/approval",
  "/api/interview-notes", "/api/run-discover", "/api/patrol-config", "/api/progress",
  "/api/rss/digest", "/api/rss/config", "/api/focus/status", "/api/focus/stats",
  "/api/focus/blacklist", "/api/mail/config", "/api/schedule", "/",
];

// 曾经被拆分器丢掉的方法门控路由（regression：必须存在且方法正确）
const METHOD_GATED = [
  ["/api/jobs/profile", "GET"],
  ["/api/jobs/profile", "POST"],
  ["/api/rss/check", "POST"],
  ["/api/focus/start", "POST"],
  ["/api/focus/stop", "POST"],
  ["/api/focus/distract", "POST"],
  ["/api/mail/test", "POST"],
  ["/api/mail/check", "POST"],
  ["/api/patrol-run", "POST"],
];

test("全部域路由注册齐全（原版 55 条内联路径一个不少；业务域经插件入口）", async () => {
  const { createRouter } = await import("../lib/routes/router.mjs");
  const router = createRouter();
  // 秋招助手插件入口：聚合 12 个业务域（与 widget.mjs 的插件加载同协议）
  const { register } = await import("../plugins/job-hunter/server.mjs");
  const { registerCoreRoutes } = await import("../lib/routes/core.mjs");
  register({ router, db: null, getCorsOrigin: () => "*", laneSubmit: (fn) => fn() });
  registerCoreRoutes(router); // runtime 全用默认空实现，注册本身不依赖 widget 运行时

  // 原版路径：任意方法命中即可（method 拆分后 GET/POST 分开注册也算命中）
  const missing = ORIGINAL_PATHS.filter((p) => {
    if (p === "/") return !router.resolve("/", "GET") && !router.resolve("/index.html", "GET");
    const hitAny = router.resolve(p, "GET") || router.resolve(p, "POST");
    return !hitAny;
  });
  assert.deepEqual(missing, [], `原版路由缺失：\n${missing.join("\n")}`);

  // 方法门控路由：精确方法必须命中
  const badMethod = METHOD_GATED.filter(([p, m]) => !router.resolve(p, m));
  assert.deepEqual(badMethod, [], `方法门控路由缺失：\n${badMethod.map((x) => x.join(" ")).join("\n")}`);

  // 注册总数 sanity（现 13 个域注册条数，防整个域文件被误删）
  assert.ok(router.size() >= 100, `注册路由总数异常少：${router.size()}`);
});

test.after(() => cleanupTempDb(tmpDir));
