// 杂项域路由（纵向拆分：对话历史/上下文计量/待办/闭环建议/问候语/自检/招聘平台/技能/专注目标）
import { memory } from "../memory.mjs";
import { getContextUsage } from "../context-meter.mjs";
import * as studyApi from "../study.mjs";
import * as reviewApi from "../review.mjs";
import { loopSuggest, suggestFocusGoal } from "../loop.mjs";
import { buildGreeting as buildGreetingText, polishGreeting as polishGreetingText } from "../greeting.mjs";
import { getResumeProfile } from "../jobs.mjs";
import { listPlatforms as listPlatformsApi, searchAndStoreJobs as searchAndStoreJobsApi, applyJobOnPlatform as applyJobOnPlatformApi } from "../job-platforms.mjs";
import { runSelfCheck, getLastSelfCheck, saveSelfCheck } from "../self-check.mjs";
import { readBody } from "../widget-core.mjs";

export function registerMiscRoutes(router) {
  // ---------- 对话历史 / 上下文计量 ----------
  router.route("/api/chat-history", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, history: memory.getChatHistory() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/context-meter", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getContextUsage()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 今日待办（学习清单未完成 + 到期复习卡） ----------
  router.route("/api/todo", (req, res) => {
    try {
      const items = [];
      const plan = studyApi.getPlan();
      for (const i of (plan.items || []).filter((x) => !x.done).slice(0, 6)) {
        items.push({ content: `📚 ${i.topic}`, done: false, id: i.id });
      }
      for (const c of reviewApi.review.getDueCards().slice(0, 4)) {
        items.push({ content: `🔁 复习：${c.topic}`, done: false, id: c.id });
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, items }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 学习-求职闭环（多向驱动状态 + 规则建议） ----------
  router.route("/api/loop", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(loopSuggest()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 问候语（GET 规则版 / POST LLM 精修，失败回退规则） ----------
  router.route("/api/greeting", "GET", (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      const greeting = buildGreetingText({ company: u.searchParams.get("company") || "", title: u.searchParams.get("title") || "" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, greeting }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/greeting", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { company = "", title = "", summary = "" } = JSON.parse(body || "{}");
        const r = await polishGreetingText({ company, title, summary });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, greeting: r?.greeting || buildGreetingText({ company, title }), polished: !!r?.greeting }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 系统自检（表堆积/产出污染/巡检停摆/LLM 失败率） ----------
  router.route("/api/self-check", "POST", (req, res) => {
    try {
      const r = runSelfCheck();
      saveSelfCheck(r); // 持久化报告（GET /api/self-check 读取展示）
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...r }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/self-check", "GET", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, report: getLastSelfCheck() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 招聘平台（BOSS 等：列表/搜索入库/投递） ----------
  router.route("/api/platforms", (req, res) => {
    try {
      ensurePlatformsSafe();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, platforms: listPlatformsApi() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/platforms/search", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { name = "boss", keyword } = JSON.parse(body || "{}");
        if (!keyword) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "keyword required" })); return; }
        await ensurePlatformsSafe();
        const r = await searchAndStoreJobsApi(String(name), String(keyword));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
  router.route("/api/platforms/apply", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        const { name = "boss", url, greeting } = JSON.parse(body || "{}");
        if (!url) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "url required" })); return; }
        await ensurePlatformsSafe();
        const r = await applyJobOnPlatformApi(String(name), String(url), { greeting });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 简历技能（供投递问候语生成/岗位匹配参考） ----------
  router.route("/api/skills", (req, res) => {
    try {
      const profile = getResumeProfile();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, skills: profile?.skills || [], directions: profile?.directions || [] }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 专注目标推荐（从到期复习卡/薄弱点/清单/题库取 top） ----------
  router.route("/api/focus/goal-suggest", (req, res) => {
    try {
      const goals = suggestFocusGoal(3);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, goals }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// 平台惰性加载（与旧 widget 行为一致：首访时 ensure）
let platformsReady = null;
function ensurePlatformsSafe() {
  if (!platformsReady) platformsReady = import("../job-platforms.mjs").then(({ ensurePlatforms }) => ensurePlatforms());
  return platformsReady;
}
