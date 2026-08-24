// 题库域路由（纵向拆分：原 widget.mjs /api/challenges/*、/api/oj/mark-done、/api/oj/progress）
// 手写/算法题库（ai-career.mjs 沙箱判题）+ 牛客刷题进度（oj.mjs）
import * as challengeApi from "#lib/ai-career.mjs";
import * as ojApi from "#lib/oj.mjs";
import { readBody } from "#lib/widget-core.mjs";

export function registerPracticeRoutes(router) {
  // ---------- 手写/算法题库 ----------
  router.route("/api/challenges", (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      const list = challengeApi.getChallenges({
        category: u.searchParams.get("category") || "",
        difficulty: Number(u.searchParams.get("difficulty")) || 0,
      });
      const stats = challengeApi.getChallengeStats();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, total: stats.total, done: stats.done, left: Math.max(0, stats.total - stats.done), list }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/challenges/detail", (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      const detail = challengeApi.getChallengeDetail(u.searchParams.get("id") || "");
      if (!detail) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "题目不存在" })); return; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, detail }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/challenges/run", "POST", (req, res) => {
    // 沙箱判题：vm 隔离执行用户代码 + 测试用例（15s 超时/死循环掐断）
    readBody(req, res, async (body) => {
      try {
        const { id, userCode } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        const detail = challengeApi.getChallengeDetail(String(id));
        if (!detail) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "题目不存在" })); return; }
        const r = await challengeApi.runChallengeCode({
          userCode: String(userCode || ""),
          testCode: detail.testCode,
          skeleton: detail.skeleton,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // 契约：tests/logs/durationMs 必须回传（前端逐条展示断言结果与 console 输出定位失败）
        res.end(JSON.stringify({ ok: true, success: r.success, error: r.error || null, tests: r.tests || [], logs: r.logs || [], durationMs: r.durationMs || 0 }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/challenges/mark-done", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        const r = challengeApi.markChallengeDone(String(id), { progress: true });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // 契约：必须回传 title（面板通知「「X」已标记完成」依赖它；曾丢失导致通知显示 undefined）
        res.end(JSON.stringify({ ok: r?.ok ?? true, title: r?.title, message: r?.message || "已标记完成" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/challenges/mark-wrong", "POST", (req, res) => {
    // 答错 → 自动建复习卡（错题进 FSRS 间隔复习，闭环）
    // 注意：markChallengeWrong 内部已建 `手写题·X` 卡——此处不再重复建卡（历史 bug：路由层又建一张 `X` 卡，
    // 导致每答错一次两张同题卡；且 `X` 与薄弱点 key 不一致导致答对复习清不掉薄弱点）
    readBody(req, res, (body) => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        const r = challengeApi.markChallengeWrong(String(id));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // 契约：必须回传 title（面板通知依赖它）
        res.end(JSON.stringify({ ok: r?.ok ?? true, title: r?.title, message: "已记录答错，自动加入复习卡" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 牛客刷题进度 ----------
  router.route("/api/oj/mark-done", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { bm_no, title, category } = JSON.parse(body || "{}");
        if (!bm_no) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "bm_no required" })); return; }
        const r = ojApi.markOjDone({ bm_no: String(bm_no), title: String(title || ""), category: String(category || "") });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/oj/progress", (req, res) => {
    try {
      const list = ojApi.getOjProgress();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, list, total: list.length }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}
