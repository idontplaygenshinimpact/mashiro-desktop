// 模拟面试域路由（纵向拆分：/api/interview/* 从 widget.mjs 迁出）
import * as interviewApi from "../interview.mjs";
import * as studyApi from "../study.mjs";
import * as reviewApi from "../review.mjs";
import { memory } from "../memory.mjs";
import { readBody } from "../widget-core.mjs";

export function registerInterviewRoutes(router, { laneSubmit = (fn) => fn() } = {}) {
  router.route("/api/interview/start", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const r = await laneSubmit(() => interviewApi.startInterview(JSON.parse(body || "{}")));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/interview/answer", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const r = await laneSubmit(() => interviewApi.submitAnswer(JSON.parse(body || "{}").answer || ""));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/interview/end", (req, res) => {
    laneSubmit(() => interviewApi.endInterview())
      .then((r) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
  });

  router.route("/api/interview/history", (req, res) => {
    // 面试历史（复盘报告）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, history: memory.getInterviewHistory() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/interview-notes", (req, res) => {
    // 面试实录：把真实面试被问住的知识点加入学习清单（必会）+ 建复习卡
    readBody(req, res, (body) => {
      try {
        const input = JSON.parse(body || "{}");
        // topics 支持数组或字符串（逗号/顿号/换行/分号分隔）
        let raw = input.topics || [];
        if (typeof raw === "string") raw = raw.split(/[,，、;\n；]+/).map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(raw) || !raw.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "topics required" })); return; }
        const added = [], existing = [], skipped = [];
        for (const t of raw.slice(0, 8)) {
          const rawTopic = String(t).trim().slice(0, 40);
          if (!rawTopic) continue;
          // 伪知识点过滤 + 规范化（返回清洗后的 topic，保证与薄弱点口径一致）
          const topic = memory._cleanTopic ? memory._cleanTopic(rawTopic) : rawTopic;
          if (!topic) { skipped.push({ topic: rawTopic, reason: "非具体知识点" }); continue; }
          const r = studyApi.addPlanItems([{
            topic,
            why: "真实面试中被问住，需优先补强",
            source: "面试实录",
            verify_question: `请完整回答并讲清原理：${topic}`,
            level: "必会",
          }]);
          if (r.added > 0) {
            added.push(topic);
            // 自动建复习卡（进入间隔复习）
            try {
              reviewApi.review.addCard({ topic, question: `请完整回答并讲清原理：${topic}`, answer: "", source: "面试实录" });
            } catch { /* ignore */ }
          } else {
            existing.push(topic);
          }
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, added, existing, skipped, hint: `新增 ${added.length} 个知识点（已在清单 ${existing.length} 个${skipped.length ? `，跳过 ${skipped.length} 个非知识点` : ""}），可在「📋 学习清单」查看，点「💡 讲解」生成详细讲解` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
}
