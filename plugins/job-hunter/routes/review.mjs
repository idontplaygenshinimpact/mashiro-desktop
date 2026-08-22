// 复习域路由（纵向拆分：原 widget.mjs /api/review/*）
// 依赖：lib/review.mjs（FSRS 调度）/ lib/quiz.mjs（选择题）/ lib/emotions.mjs（真白情感反馈）
import * as reviewApi from "#lib/review.mjs";
import { ensureQuiz, drawQuiz, submitQuiz, getQuizStats } from "#lib/quiz.mjs";
import { pick as pickEmotion, EMOTIONS } from "#lib/emotions.mjs";
import { memory } from "#lib/memory.mjs";
import { readBody } from "#lib/widget-core.mjs";

/**
 * 注册复习域路由
 * @param {import("./router.mjs").createRouter().resolve extends never ? never : any} router
 * @param {{ getCorsOrigin: (req: any) => string }} ctx
 */
export function registerReviewRoutes(router, ctx) {
  const { getCorsOrigin } = ctx;

  router.route("/api/review/due", (req, res) => {
    // 今日到期复习卡片 + 统计 + 趋势（7 天复习量 + 连续天数）+ 今日已复习主题（面试检验用）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        due: reviewApi.review.getDailySession(),
        stats: reviewApi.review.getStats(),
        trend: reviewApi.review.getReviewTrend(),
        todayReviewed: reviewApi.review.getTodayReviewedTopics(),
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/review/wrong", (req, res) => {
    // 错题本：答错 >=2 次的卡（错题自动讲解闭环）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, wrong: reviewApi.review.getWrongCards(10) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/review/quiz", (req, res, url) => {
    // 复习选择题：随机抽 3 题 + 选项洗牌（题库空返回 total:0，前端触发懒生成）
    const id = url.searchParams.get("id") || "";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...drawQuiz(id) }));
  });

  router.route("/api/review/quiz/generate", "POST", (req, res) => {
    // 懒生成选择题题库（一次 LLM 批量产出 6 题；失败返回 error，前端降级纯文本卡）
    readBody(req, res, (body) => {
      try {
        const { cardId } = JSON.parse(body || "{}");
        if (!cardId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "cardId required" })); return; }
        ensureQuiz(String(cardId)).then((r) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: r.ok, total: r.total || 0, fromCache: !!r.fromCache, kbUsed: !!r.kbUsed, error: r.error || undefined }));
        }).catch((e) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 120) }));
        });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/review/quiz/stats", "GET", (req, res) => {
    // 自测统计（消费 quiz_attempts——此前每题答错明细只写不读，正确率对用户不可见）
    try {
      const cardId = new URL(req.url, "http://x").searchParams.get("cardId") || "";
      const stats = cardId ? getQuizStats(String(cardId)) : { total: 0, correct: 0, wrong: 0, wrongQuestions: 0 };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stats }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/review/quiz/submit", "POST", (req, res) => {
    // 判分 + 记录；答错 → 自动回流薄弱点（闭环：自测失败信号不再丢弃）
    readBody(req, res, (body) => {
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
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/review/explain-stream", (req, res, url) => {
    // 复习卡 AI 讲解（流式）：卡问题/答案 + 知识库检索段落 → 讲清原理（答错即学闭环）
    const id = url.searchParams.get("id") || "";
    const card = reviewApi.review.loadCards().cards.find((c) => c.id === id);
    if (!card) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "卡片不存在" })); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": getCorsOrigin(req),
    });
    res.on("error", () => {}); // 客户端断开避免无监听 error 崩溃
    const send = (obj) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    send({ type: "start", topic: card.topic });
    // 知识库检索（本地 RAG，快；失败静默降级为纯 LLM）→ 流式讲解
    Promise.resolve()
      .then(async () => {
        let kbContext = "";
        try {
          const { searchKnowledge } = await import("#lib/rag.mjs");
          const hits = await searchKnowledge(card.topic, 2);
          if (hits?.length) {
            kbContext = hits.map((h) => `【${h.title}】\n${String(h.content || "").slice(0, 900)}`).join("\n\n");
          }
        } catch { /* 知识库不可用走纯 LLM */ }
        return kbContext;
      })
      .then(async (kbContext) => {
        const { solveQuestionStream } = await import("#lib/ai.mjs");
        const { getCareerProfile } = await import("#lib/career.mjs");
        const prof = getCareerProfile();
        const text = `这是一道面试题「${card.topic}」，你在复习时答错了/答得困难，需要彻底讲透。
复习卡问题：${card.question || card.topic}
复习卡参考答案：${String(card.answer || "（无）").slice(0, 1500)}
${kbContext ? `本地知识库相关段落（仅作补充素材）：\n${kbContext}` : ""}
请重点讲解：核心原理（不只背 API）、常见追问、记忆口诀或易错点、一页纸总结。`;
        let full = "";
        await solveQuestionStream({
          title: card.topic,
          text,
          company: "复习错题讲解",
          position: prof.positionDefault || "前端",
          sourceUrl: "复习卡",
        }, (delta) => {
          full += delta;
          send({ type: "delta", delta });
        });
        // 讲解完成 → 更新卡答案（下次复习有完整参考）
        try {
          reviewApi.review.addCard({
            topic: card.topic,
            question: card.question || `请完整回答并讲清原理：${card.topic}`,
            answer: full.slice(0, 800),
            source: card.source || "复习错题讲解",
          });
        } catch { /* ignore */ }
        send({ type: "done", saved: true });
      })
      .catch((e) => {
        send({ type: "error", error: String(e?.message || e).slice(0, 200) });
      })
      .finally(() => { try { res.end(); } catch { /* ignore */ } });
  });

  router.route("/api/review/add", "POST", (req, res) => {
    // 添加复习卡（学习清单/薄弱点回流用）
    readBody(req, res, (body) => {
      try {
        const { topic, question = "", answer = "", source = "" } = JSON.parse(body || "{}");
        if (!topic) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "topic required" })); return; }
        const card = reviewApi.review.addCard({ topic, question, answer, source });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, card }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/review/submit", "POST", (req, res) => {
    // 复习提交评级 0-3
    readBody(req, res, (body) => {
      try {
        const { id, rating } = JSON.parse(body || "{}");
        const r = reviewApi.review.reviewCard(id, parseInt(rating, 10) || 2);
        // 答错（Again/Hard）→ 真白安慰
        let emotion = null;
        try {
          if ((parseInt(rating, 10) || 2) <= 1) {
            emotion = pickEmotion(EMOTIONS.comfort);
          } else if ((parseInt(rating, 10) || 2) >= 2 && r.card && r.card.fsrs && r.card.fsrs.stability >= 21) {
            emotion = pickEmotion(EMOTIONS.celebrate);
          }
        } catch { /* ignore */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...r, emotion }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
}
