// 知识库域路由（纵向拆分：原 widget.mjs /api/knowledge/*、/api/learning/*、/api/career/profile、
// /api/knowledge/tree、/api/weak-points、/api/mastery）
import * as knowledgeApi from "#lib/knowledge.mjs";
import * as ragApi from "#lib/rag.mjs";
import * as kbApi from "#lib/knowledge-base.mjs";
import * as learningApi from "#lib/learning.mjs";
import * as studyApi from "#lib/study.mjs";
import { getCareerProfile, saveCareerProfile, resetCareerProfile } from "#lib/career.mjs";
import { memory } from "#lib/memory.mjs";
import { db } from "#lib/db.mjs";
import { readBody } from "#lib/widget-core.mjs";

export function registerKbRoutes(router) {
  // ---------- 方向画像 ----------
  router.route("/api/career/profile", "GET", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, profile: getCareerProfile() }));
  });
  router.route("/api/career/profile", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const j = JSON.parse(body || "{}");
        const r = j?.reset ? resetCareerProfile() : saveCareerProfile(j || {});
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...r, profile: r.profile || getCareerProfile() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 可配置知识树 ----------
  router.route("/api/knowledge/tree", "GET", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, tree: knowledgeApi.getKnowledgeTree(), isDefault: knowledgeApi.isDefaultTree() }));
  });
  router.route("/api/knowledge/tree", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const j = JSON.parse(body || "{}");
        const r = j?.reset ? knowledgeApi.resetKnowledgeTree() : knowledgeApi.saveKnowledgeTree(j?.tree);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...r, isDefault: !j?.reset && r?.ok ? false : undefined }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
  // ---------- 知识树方向模板（开源多方向：frontend/backend/algorithm 一键切换） ----------
  router.route("/api/knowledge/templates", "GET", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, templates: knowledgeApi.listTreeTemplates() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/knowledge/load-template", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { name } = JSON.parse(body || "{}");
        const r = knowledgeApi.loadTreeTemplate(String(name || ""));
        res.writeHead(r?.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 薄弱点 / 掌握度 ----------
  router.route("/api/weak-points", (req, res) => {
    try {
      const weak = memory.getTrustedWeakPoints(10).map((w) => ({
        topic: w.topic,
        failCount: w.failCount || 1,
        source: w.source || "",
        lastFailedAt: w.lastFailedAt || null,
      }));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // 薄弱点消灭进度可视化工单任务 1：已消灭计数（累计清除——用户可感知的进步）
      res.end(JSON.stringify({ ok: true, weak, clearedCount: memory.getClearedWeakCount() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // 薄弱点闭环补全工单任务 1②：薄弱点一键入清单（批量；topics 空 = 全部薄弱点）
  // 入清单后走"学完勾选 → 自动清除薄弱点"闭环（checkItem 任务 2①）
  router.route("/api/weak-points/to-plan", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { topics } = JSON.parse(body || "{}");
        const all = memory.getTrustedWeakPoints(100);
        const targets = Array.isArray(topics) && topics.length
          ? topics.map((t) => String(t || "").trim()).filter(Boolean)
          : all.map((w) => w.topic);
        const r = studyApi.addPlanItems(targets.map((t) => ({
          topic: t,
          why: "薄弱点一键入清单，优先补强",
          source: "薄弱点",
          level: "必会",
        })));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, added: r.added, total: targets.length, message: `已加入学习清单 ${r.added} 条（学完勾选即自动清除薄弱点）` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/iv-focus-sources", async (req, res) => {
    // 面试优先考察可选项（手动选配用）：复用 startInterview 的多源聚合——
    // 薄弱点/题库错题/复习错题/今日复习/到期卡/清单未完成，带来源原因
    try {
      const { buildInterviewFocus } = await import("#lib/interview.mjs");
      const items = await buildInterviewFocus();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, items }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/mastery", (req, res) => {
    try {
      const mastery = knowledgeApi.getMastery();
      const weak = knowledgeApi.getWeakKps(5);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        mastery,
        weak,
        stats: { total: mastery.length, weakCount: mastery.filter((k) => k.score < 50).length },
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 知识库检索/问答/统计/重建 ----------
  router.route("/api/knowledge/ask", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { query } = JSON.parse(body || "{}");
        const r = await ragApi.askKnowledge(query);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/knowledge/search", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { query, topK } = JSON.parse(body || "{}");
        // RAG 未启用：明确告知（面板显示提示而非"没有命中"）
        if (!ragApi.ragEnabled()) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, hits: [], disabled: true, message: "本地知识库未启用，可在设置中心开启（开启后自动重建索引，之后可搜索/问答）" }));
          return;
        }
        const hits = await ragApi.searchKnowledge(query, Math.min(topK || 5, 10));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, hits }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/knowledge/stats", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...ragApi.getKnowledgeStats() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // 个人学习知识库工单任务 1：段落级混合检索（BM25 + 向量 + RRF——追问段落加权）
  router.route("/api/knowledge/paragraphs/search", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { query, topK } = JSON.parse(body || "{}");
        // 首次检索前增量索引（mtime + 段落数变化才重刷——幂等）
        try { kbApi.indexStudyNotes(); } catch { /* 索引失败不影响检索 */ }
        const hits = await kbApi.searchParagraphs(query, Math.min(topK || 8, 12));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, hits, stats: kbApi.getParagraphStats() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/knowledge/paragraphs/stats", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...kbApi.getParagraphStats() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // 个人学习知识库工单任务 2：rerank 精排检索（RRF 粗排 top10 → 交叉编码器精排 top5）
  router.route("/api/knowledge/paragraphs/search-reranked", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { query, topK } = JSON.parse(body || "{}");
        try { kbApi.indexStudyNotes(); } catch { /* 索引失败不影响检索 */ }
        const hits = await kbApi.searchParagraphsReranked(query, Math.min(topK || 5, 8));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, hits, stats: kbApi.getParagraphStats() }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // 个人学习知识库工单任务 3：追问段落 → 复习卡（"问过 → 复习 → 掌握"闭环）
  router.route("/api/knowledge/followups-to-cards", "POST", (req, res) => {
    readBody(req, res, async (_body) => {
      try {
        const r = await kbApi.followupsToReviewCards();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, message: `已把 ${r.added.length} 个追问转成复习卡（进 FSRS 调度）` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/knowledge/rebuild", "POST", (req, res) => {
    readBody(req, res, async (_body) => {
      try {
        const r = await ragApi.rebuildKnowledgeBase();
        if (r === null) {
          res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "已有知识库重建/增量任务在进行中，请稍后再试" }));
          return;
        }
        if (r.disabled) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, ...r }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, message: `知识库重建完成：${r.items} 条，耗时 ${r.seconds}s` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 官方文档版本检测 ----------
  router.route("/api/learning", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...learningApi.getLearningDocs() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/learning/check", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { only } = JSON.parse(body || "{}");
        const results = await learningApi.checkDocVersions(Array.isArray(only) ? only : []);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/learning/project", "GET", (req, res) => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='docs_project'").get();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, path: row?.value ? String(row.value) : "" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/learning/project", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { path: p } = JSON.parse(body || "{}");
        const clean = String(p || "").trim();
        if (!clean) {
          db.prepare("DELETE FROM settings WHERE key='docs_project'").run();
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, path: "", message: "已清除项目路径" }));
          return;
        }
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('docs_project', ?, ?)")
          .run(clean, Date.now());
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, path: clean, message: "已保存项目路径（重新检查后生效对比）" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 薄弱点闭环工单任务 1：知识树三档自评摸底（冷启动画像） ----------
  // 入口：用户设置目标方向后弹"5 分钟摸底"引导；自评页按知识树分类/知识点三档自评（熟悉/一般/不会）
  // 数据模型：
  //   - "不会"（weak）→ weak_points 写入（origin="self_assess"——可信级别同 owner，failCount=0）+ 入学习清单（source=自评摸底）
  //   - "一般"（ok）→ 仅写掌握度（kp_mastery 映射 0.5）
  //   - "熟悉"（familiar）→ 不建薄弱点（不对称采信：自评"不会"是强信号采信，"熟悉"是弱信号不采信——防 Dunning-Kruger 高估）
  // 幂等：已自评过/已存在薄弱点/清单已有 → 不重复建
  router.route("/api/self-assess/status", "GET", (req, res) => {
    // 摸底状态：是否已完成（settings self_assess_done）+ 已自评知识点（幂等用）
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='self_assess_done'").get();
      const done = row?.value === "1";
      const assessed = done
        ? (db.prepare("SELECT topic FROM weak_points WHERE origin='self_assess'").all() || []).map((r) => r.topic)
        : [];
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, done, assessed }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/self-assess", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { assessments } = JSON.parse(body || "{}");
        const list = Array.isArray(assessments) ? assessments : [];
        const weakAdded = [], planAdded = [], mastered = [], skipped = [];
        for (const a of list) {
          const topic = String(a?.topic || "").trim().slice(0, 30);
          const level = a?.level; // "familiar" | "ok" | "weak"
          if (!topic || !["familiar", "ok", "weak"].includes(level)) continue;
          if (level === "weak") {
            // 幂等：已存在薄弱点（任何来源）→ 不重复建
            const exists = memory.getTrustedWeakPoints(100).some((w) => w.topic === topic);
            if (!exists) {
              memory.addWeakPoint(topic, "自评摸底", "self_assess", {});
              weakAdded.push(topic);
              // 入学习清单（source=自评摸底）——幂等：清单已有同 topic 不重复加
              const plan = studyApi.getPlan();
              const inPlan = (plan.items || []).some((i) => i.topic === topic);
              if (!inPlan) {
                studyApi.addPlanItems([{ topic, why: "自评摸底：不会，优先补强", source: "自评摸底", level: "必会" }]);
                planAdded.push(topic);
              }
            } else {
              skipped.push(topic);
            }
          } else if (level === "ok") {
            // 一般 → 仅写掌握度（映射 0.5）
            const kpId = knowledgeApi.matchKp(topic);
            if (kpId) { knowledgeApi.setMasteryScore(kpId, 50); mastered.push(topic); }
          }
          // familiar → 不建薄弱点（不对称采信）
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        // 提交完成 → 标记摸底完成（幂等：下次不再弹引导）
        try { db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('self_assess_done', '1', ?)").run(Date.now()); } catch { /* ignore */ }
        res.end(JSON.stringify({
          ok: true,
          weakAdded, planAdded, mastered, skipped,
          message: `已建立 ${weakAdded.length} 个薄弱点（入清单 ${planAdded.length} 条）、掌握度 ${mastered.length} 项`,
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
}
