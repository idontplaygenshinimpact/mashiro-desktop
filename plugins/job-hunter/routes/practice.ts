// 题库域路由（纵向拆分：原 widget.mjs /api/challenges/*、/api/oj/mark-done、/api/oj/progress）
// 手写/算法题库（ai-career.mjs 沙箱判题）+ 牛客刷题进度（oj.mjs）
import * as challengeApi from "#lib/ai-career.mjs";
import * as ojApi from "#lib/oj.mjs";
import { readBody } from "#lib/widget-core.mjs";

// 全量 TS 升级工单阶段 4（插件）：实现迁至 practice.ts，practice.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown；message 为空/非 Error 抛出退回 String(e)） */
const eMsg = (e: unknown): string => {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(e);
};

export function registerPracticeRoutes(router: Router): void {
  // ---------- 手写/算法题库 ----------
  router.route("/api/challenges", (req: IncomingMessage, res: ServerResponse) => {
    try {
      const u = new URL(String(req.url), "http://x");
      const list = challengeApi.getChallenges({
        category: u.searchParams.get("category") || "",
        difficulty: Number(u.searchParams.get("difficulty")) || 0,
      });
      const stats = challengeApi.getChallengeStats();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, total: stats.total, done: stats.done, left: Math.max(0, stats.total - stats.done), list }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/challenges/detail", (req: IncomingMessage, res: ServerResponse) => {
    try {
      const u = new URL(String(req.url), "http://x");
      const detail = challengeApi.getChallengeDetail(u.searchParams.get("id") || "");
      if (!detail) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "题目不存在" })); return; }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, detail }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/challenges/run", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 沙箱判题：vm 隔离执行用户代码 + 测试用例（15s 超时/死循环掐断）
    readBody(req, res, async (body: string) => {
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
        // 学习事件埋点（长期学习计划引擎的唯一事实源）+ 通用即时反馈（事件流基线对比，
        // 与动作类型解耦——判题/复习/清单/手动记录统一走 buildFeedbackTip）
        let tip = null;
        try {
          const { recordLearningEvent, buildFeedbackTip } = await import("#lib/learning-plan.mjs");
          const ev = recordLearningEvent({
            topic: detail.title,
            kind: "challenge_done",
            result: r.success ? "pass" : "fail",
            quality: r.success ? 1 : 0,
            durationMs: r.durationMs,
          });
          tip = buildFeedbackTip({
            topic: detail.title, kind: "challenge_done",
            result: r.success ? "pass" : "fail", quality: r.success ? 1 : 0,
            durationMs: r.durationMs, planId: ev.planId,
          });
        } catch { /* 埋点/tip 失败不影响判题 */ }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // 契约：tests/logs/durationMs 必须回传（前端逐条展示断言结果与 console 输出定位失败）；tip 为节奏反馈
        res.end(JSON.stringify({ ok: true, success: r.success, error: r.error || null, tests: r.tests || [], logs: r.logs || [], durationMs: r.durationMs || 0, tip }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/challenges/mark-done", "POST", (req: IncomingMessage, res: ServerResponse) => {
    readBody(req, res, (body: string) => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        const r = challengeApi.markChallengeDone(String(id), { progress: true });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // 契约：必须回传 title（面板通知「「X」已标记完成」依赖它；曾丢失导致通知显示 undefined）
        // 注：markChallengeDone 从不返回 message（TS 迁移暴露）——这里就是固定文案，语义与旧行为一致
        res.end(JSON.stringify({ ok: r?.ok ?? true, title: r?.title, message: "已标记完成" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/challenges/mark-wrong", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 答错 → 自动建复习卡（错题进 FSRS 间隔复习，闭环）
    // 注意：markChallengeWrong 内部已建 `手写题·X` 卡——此处不再重复建卡（历史 bug：路由层又建一张 `X` 卡，
    // 导致每答错一次两张同题卡；且 `X` 与薄弱点 key 不一致导致答对复习清不掉薄弱点）
    readBody(req, res, (body: string) => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        const r = challengeApi.markChallengeWrong(String(id));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // 契约：必须回传 title（面板通知依赖它）
        res.end(JSON.stringify({ ok: r?.ok ?? true, title: r?.title, message: "已记录答错，自动加入复习卡" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  // ---------- 牛客刷题进度 ----------
  router.route("/api/oj/mark-done", "POST", (req: IncomingMessage, res: ServerResponse) => {
    readBody(req, res, (body: string) => {
      try {
        const { bm_no, title, category } = JSON.parse(body || "{}");
        if (!bm_no) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "bm_no required" })); return; }
        const r = ojApi.markOjDone({ bm_no: String(bm_no), title: String(title || ""), category: String(category || "") });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // markOjDone 恒带 ok 字段（返回类型 required）→ 原 { ok: true, ...r } 的 ok: true 必被覆盖，等价
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/oj/progress", (req: IncomingMessage, res: ServerResponse) => {
    try {
      const list = ojApi.getOjProgress();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, list, total: list.length }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
}
