// 知识库域路由（纵向拆分：原 widget.mjs /api/knowledge/*、/api/learning/*、/api/career/profile、
// /api/knowledge/tree、/api/weak-points、/api/mastery）
import * as knowledgeApi from "#lib/knowledge.mjs";
import * as ragApi from "#lib/rag.mjs";
import * as learningApi from "#lib/learning.mjs";
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
    res.end(JSON.stringify({ ok: true, tree: knowledgeApi.getKnowledgeTree(), isDefault: knowledgeApi.getKnowledgeTree() === knowledgeApi.KNOWLEDGE_TREE }));
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
      res.end(JSON.stringify({ ok: true, weak }));
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
}
