// 复习域路由（纵向拆分：原 widget.mjs /api/review/*）
// 依赖：lib/review.mjs（FSRS 调度）/ lib/quiz.mjs（选择题）/ lib/emotions.ts（真白情感反馈）
import * as reviewApi from "#lib/review.mjs";
import { ensureQuiz, drawQuiz, submitQuiz, getQuizStats } from "#lib/quiz.mjs";
import { pick as pickEmotion, EMOTIONS } from "#lib/emotions.ts";
import { memory } from "#lib/memory.mjs";
import { readBody } from "#lib/widget-core.mjs";
import { createSSEPush, withContract } from "#lib/routes/contract.mjs";
import { StudyStreamEvent } from "#lib/contracts/sse.mjs";
// 全量 TS 升级工单阶段 4（插件）：实现迁至 review.ts，review.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";
import { ReviewAddInput, ReviewAddOutput, ReviewSubmitInput, ReviewSubmitOutput, ReviewDueOutput, ReviewFeedbackOutput, ReviewRetryOutput } from "#lib/contracts/review.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown；message 为空/非 Error 抛出退回 String(e)） */
const eMsg = (e: unknown): string => {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(e);
};

/** 复习域 ctx（宿主注入取源回调；缺省 * 通配，与各路由域一致） */
export interface ReviewRoutesCtx { getCorsOrigin?: (req: IncomingMessage) => string }

export function registerReviewRoutes(router: Router, ctx: ReviewRoutesCtx = {}): void {
  // 宿主未注入取源回调时的安全缺省（与各路由域一致：* 通配）——SSE 头必须有值
  const getCorsOrigin = ctx.getCorsOrigin || (() => "*");

  router.route("/api/review/due", "GET", withContract(
    // 今日到期复习卡片 + 统计 + 趋势（7 天复习量 + 连续天数）+ 今日已复习主题（面试检验用）
    () => ({
      ok: true,
      due: reviewApi.review.getDailySession(),
      stats: reviewApi.review.getStats(),
      trend: reviewApi.review.getReviewTrend(),
      todayReviewed: reviewApi.review.getTodayReviewedTopics(),
    }),
    { output: ReviewDueOutput }
  ));

  // 强化复习工单任务 2：复习反馈（今日 N 张/掌握 X/待重练 Y）+ 错题重练队列
  // 修复（TS 升级发现）：这两条路由原先把 **JSON-Schema 形状的普通对象** 传给 withContract 的 output，
  // 而 output 必须是 zod schema（内部调 output.safeParse）→ 运行期 TypeError
  // "output.safeParse is not a function" → 两条路由恒 500（.mjs 时代被隐式 any 掩盖，无人发现）。
  // 现改用契约层真实 schema（lib/contracts/review.ts 新增 ReviewFeedbackOutput/ReviewRetryOutput）。
  router.route("/api/review/feedback", "GET", withContract(
    () => ({ ok: true, ...reviewApi.review.getReviewFeedback() }),
    { output: ReviewFeedbackOutput }
  ));
  router.route("/api/review/retry", "GET", withContract(
    () => ({ ok: true, retry: reviewApi.review.getRetryQueue() }),
    { output: ReviewRetryOutput }
  ));

  router.route("/api/review/wrong", (req: IncomingMessage, res: ServerResponse) => {
    // 错题本：答错 >=2 次的卡（错题自动讲解闭环）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, wrong: reviewApi.review.getWrongCards(10) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/review/quiz", (req: IncomingMessage, res: ServerResponse, url?: URL) => {
    // 复习选择题：随机抽 3 题 + 选项洗牌（题库空返回 total:0，前端触发懒生成）
    const id = (url ?? new URL(String(req.url), "http://x")).searchParams.get("id") || "";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    // drawQuiz 恒带 ok 字段（返回类型 required）→ 原 { ok: true, ...drawQuiz(id) } 的 ok: true 必被覆盖，等价
    res.end(JSON.stringify(drawQuiz(id)));
  });

  router.route("/api/review/quiz/generate", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 懒生成选择题题库（一次 LLM 批量产出 6 题；失败返回 error，前端降级纯文本卡）
    readBody(req, res, (body: string) => {
      try {
        const { cardId } = JSON.parse(body || "{}");
        if (!cardId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "cardId required" })); return; }
        ensureQuiz(String(cardId)).then((r) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: r.ok, total: r.total || 0, fromCache: !!r.fromCache, kbUsed: !!r.kbUsed, error: r.error || undefined }));
        }).catch((e: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: eMsg(e).slice(0, 120) }));
        });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/review/quiz/stats", "GET", (req: IncomingMessage, res: ServerResponse) => {
    // 自测统计（消费 quiz_attempts——此前每题答错明细只写不读，正确率对用户不可见）
    try {
      const cardId = new URL(String(req.url), "http://x").searchParams.get("cardId") || "";
      const stats = cardId ? getQuizStats(String(cardId)) : { total: 0, correct: 0, wrong: 0, wrongQuestions: 0 };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stats }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/review/quiz/submit", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 判分 + 记录；答错 → 自动回流薄弱点（闭环：自测失败信号不再丢弃）
    readBody(req, res, (body: string) => {
      try {
        const { cardId, answers } = JSON.parse(body || "{}");
        if (!cardId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "cardId required" })); return; }
        const r = submitQuiz(String(cardId), answers);
        // 答错回流：有错题 → 知识点进薄弱点队列（学习清单/面试出题/复习卡都消费它）
        if (r.ok && Array.isArray(r.results) && r.results.some((x) => x && x.correct === false)) {
          try {
            const card = reviewApi.review.loadCards().cards.find((c) => c.id === String(cardId));
            if (card?.topic) {
              // 带参考答案（与 FSRS 复习答错路径一致，避免自测错卡空答案）
              memory.addWeakPoint(String(card.topic).slice(0, 40), "复习自测", "agent", {
                question: String(card.question || "").slice(0, 300),
                answer: String(card.answer || "").slice(0, 300),
              });
            }
          } catch { /* 回流失败不影响判分返回 */ }
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/review/explain-stream", (req: IncomingMessage, res: ServerResponse, url?: URL) => {
    // 复习卡 AI 讲解（流式）：卡问题/答案 + 知识库检索段落 → 讲清原理（答错即学闭环）
    const id = (url ?? new URL(String(req.url), "http://x")).searchParams.get("id") || "";
    const card = reviewApi.review.loadCards().cards.find((c) => c.id === id);
    if (!card) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "卡片不存在" })); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": getCorsOrigin(req),
    });
    res.on("error", () => {}); // 客户端断开避免无监听 error 崩溃
    // 统一 SSE push（Phase 2 §3.4：StudyStreamEvent 契约；开发期 MIANSHI_SSE_STRICT=1 校验漂移）
    const send = createSSEPush(res, { eventSchema: StudyStreamEvent }).push;
    send({ type: "start", topic: card.topic });
    // 知识库检索（本地 RAG，快；失败静默降级为纯 LLM）→ 流式讲解
    Promise.resolve()
      .then(async () => {
        let kbContext = "";
        try {
          const { searchKnowledge } = await import("#lib/rag.ts");
          const hits = await searchKnowledge(card.topic, 2);
          if (hits?.length) {
            kbContext = hits.map((h) => `【${h.title}】\n${String(h.content || "").slice(0, 900)}`).join("\n\n");
          }
        } catch { /* 知识库不可用走纯 LLM */ }
        return kbContext;
      })
      .then(async (kbContext) => {
        const { solveQuestionStream, withLLMTimeout } = await import("#lib/ai.ts");
        // 复习卡讲解方向统一"面试"（工单任务 3）：复习错题讲解不按岗位方向——
        // 卡是跨岗位的知识点，用 positionDefault 会让讲解偏岗位（如"前端实习生"）
        const text = `这是一道面试题「${card.topic}」，你在复习时答错了/答得困难，需要彻底讲透。
复习卡问题：${card.question || card.topic}
复习卡参考答案：${String(card.answer || "（无）").slice(0, 1500)}
${kbContext ? `本地知识库相关段落（仅作补充素材）：\n${kbContext}` : ""}
请重点讲解：核心原理（不只背 API）、常见追问、记忆口诀或易错点、一页纸总结。`;
        let full = "";
        // 流式链路超时统一修复工单任务 2④：solveQuestionStream 包 withLLMTimeout（空闲超时——流式输出中不超时）
        const activity = { touch: () => {} };
        await /** @type {any} */ (withLLMTimeout(
          solveQuestionStream({
            title: String(card.topic),
            text,
            company: "复习错题讲解",
            position: "面试",
            sourceUrl: "复习卡",
          }, (delta) => {
            full += delta;
            activity.touch(); // 流式活动——重置空闲超时
            send({ type: "delta", delta });
          }),
          undefined,
          "讲解生成超时（60s 无输出）——请重试",
          activity
        ));
        // 讲解完成 → 更新卡答案（下次复习有完整参考）
        try {
          reviewApi.review.addCard({
            topic: String(card.topic),
            question: String(card.question || `请完整回答并讲清原理：${card.topic}`),
            answer: full.slice(0, 800),
            source: String(card.source || "复习错题讲解"),
          });
        } catch { /* ignore */ }
        send({ type: "done", saved: true });
      })
      .catch((e: unknown) => {
        send({ type: "error", error: eMsg(e).slice(0, 200) });
      })
      .finally(() => { try { res.end(); } catch { /* ignore */ } });
  });

  router.route("/api/review/add", "POST", withContract(
    // 添加复习卡（学习清单/薄弱点回流用）
    (input) => {
      const card = reviewApi.review.addCard({ topic: input.topic, question: input.question, answer: input.answer, source: input.source });
      return { ok: true, card };
    },
    { input: ReviewAddInput, output: ReviewAddOutput }
  ));

  router.route("/api/review/submit", "POST", withContract(
    // 复习提交评级 0-3（0=Again 忘了——注意 0 是合法值，不能用 || 兜底）
    (input) => {
      // 归一化一次：非法值才兜底 2（契约已保证 0-3，此处防御性保留）
      const rn = Number.isInteger(input.rating) && input.rating >= 0 && input.rating <= 3 ? input.rating : 2;
      const r = reviewApi.review.reviewCard(input.id, rn);
      // 答错（Again/Hard）→ 真白安慰
      let emotion = null;
      try {
        if (rn <= 1) {
          emotion = pickEmotion(EMOTIONS.comfort);
        } else if (rn >= 2 && r.ok && r.card.fsrs && r.card.fsrs.stability >= 21) {
          emotion = pickEmotion(EMOTIONS.celebrate);
        }
      } catch { /* ignore */ }
      return { ...r, emotion };
    },
    { input: ReviewSubmitInput, output: ReviewSubmitOutput }
  ));
}
