// 杂项域路由（纵向拆分：对话历史/上下文计量/待办/闭环建议/问候语/自检/招聘平台/技能/专注目标/驾驶舱/提问）
import { memory } from "../memory.mjs";
import { getContextUsage } from "../context-meter.mjs";
import { getTodo } from "../todo.mjs";
import { loopSuggest, suggestFocusGoal } from "../loop.mjs";
import { getPendingAsks, answerAsk } from "../ask-user.mjs";
import * as studyApi from "../study.mjs";
import * as reviewApi from "../review.mjs";
import * as challengeApi from "../ai-career.mjs";
import { getFocusStats } from "../focus.mjs";
import * as jobsApi from "../jobs.mjs";
import { db } from "../db.mjs";
import { buildGreeting as buildGreetingText, polishGreeting as polishGreetingText } from "../greeting.mjs";
import { getResumeProfile } from "../jobs.mjs";
import { listPlatforms as listPlatformsApi, searchAndStoreJobs as searchAndStoreJobsApi, applyJobOnPlatform as applyJobOnPlatformApi } from "../job-platforms.mjs";
import { saveAccount as savePlatformAccount } from "../platform-accounts.mjs";
import * as personalProjectsApi from "../personal-projects.mjs";
import { runSelfCheck, getLastSelfCheck, saveSelfCheck } from "../self-check.mjs";
import { readBody } from "../widget-core.mjs";

export function registerMiscRoutes(router) {
  // ---------- LLM API Key / Base URL / 模型配置（设置中心；settings > .env/环境变量，面板可改） ----------
  router.route("/api/settings/llm", "GET", (req, res) => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='llm_api_key'").get();
      const key = row?.value ? String(row.value).trim() : "";
      const baseRow = db.prepare("SELECT value FROM settings WHERE key='llm_api_base_url'").get();
      const baseUrl = baseRow?.value ? String(baseRow.value).trim() : "";
      const modelRow = db.prepare("SELECT value FROM settings WHERE key='llm_api_model'").get();
      const model = modelRow?.value ? String(modelRow.value).trim() : "";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        hasKey: !!key,
        masked: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : "",
        // 当前生效地址：设置 > 环境变量 > 默认（opencode 主端点）
        baseUrl: baseUrl || String(process.env.DEEPSEEK_BASE_URL || "https://opencode.ai/zen/go/v1"),
        baseUrlCustom: !!baseUrl,
        model: model || String(process.env.MIANSHI_MODEL || "deepseek-v4-flash"),
        modelCustom: !!model,
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/settings/llm", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const input = JSON.parse(body || "{}");
        // 只更新"body 里出现的字段"：两个保存按钮各提交子集，未提交的字段保留（否则互清）
        const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
        const writes = [];
        if (has("apiKey")) {
          const key = String(input.apiKey || "").trim();
          if (key && !/^(sk-|deepseek-|gsk_|AIza)/.test(key)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "API Key 格式异常（应以 sk- 等开头）" }));
            return;
          }
          if (key) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('llm_api_key', ?, ?)").run(key, Date.now());
          } else {
            db.prepare("DELETE FROM settings WHERE key='llm_api_key'").run();
          }
          writes.push(key ? "API Key" : "清除 API Key");
        }
        if (has("baseUrl")) {
          const base = String(input.baseUrl || "").trim().replace(/\/+$/, "");
          if (base && !/^https?:\/\//i.test(base)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Base URL 格式异常（应以 http:// 或 https:// 开头，如 https://api.deepseek.com/v1）" }));
            return;
          }
          if (base) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('llm_api_base_url', ?, ?)").run(base, Date.now());
          } else {
            db.prepare("DELETE FROM settings WHERE key='llm_api_base_url'").run();
          }
          writes.push(base ? `Base URL=${base}` : "清除 Base URL");
        }
        if (has("model")) {
          const mdl = String(input.model || "").trim();
          if (mdl) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('llm_api_model', ?, ?)").run(mdl, Date.now());
          } else {
            db.prepare("DELETE FROM settings WHERE key='llm_api_model'").run();
          }
          writes.push(mdl ? `模型=${mdl}` : "清除模型");
        }
        const key = has("apiKey") ? String(input.apiKey || "").trim() : (db.prepare("SELECT value FROM settings WHERE key='llm_api_key'").get()?.value || "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          hasKey: !!key,
          message: writes.length ? `✅ 已保存：${writes.join("、")}（立即生效；未改动的保留）` : "没有需要保存的字段",
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 本地知识库（RAG）开关（设置中心；rag_enabled "1"/"0"，默认关） ----------
  // 评估：agent 几乎不查知识库但 embedding 模型常驻内存大（bge-m3 曾占 800MB+）→ 默认关，按需开
  router.route("/api/settings/rag", "GET", (req, res) => {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='rag_enabled'").get();
      const enabled = row ? String(row.value) === "1" : false;
      let assets = 0;
      try { assets = db.prepare("SELECT COUNT(*) n FROM knowledge_items").get().n; } catch { /* 表未建 */ }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        enabled,
        assets,
        embedModel: "FTS5 trigram（纯关键词检索，零模型零内存）",
        note: "本地知识库：把面经/学习清单/岗位 JD 做成可检索库，对话、知识问答和复习选题可引用。已改为轻量关键词检索（FTS5，数据库版 grep），不再加载 embedding 模型、不占内存；开启后秒级构建。",
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/settings/rag", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { enabled } = JSON.parse(body || "{}");
        if (typeof enabled !== "boolean") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "enabled 必须是布尔值" })); return;
        }
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('rag_enabled', ?, ?)").run(enabled ? "1" : "0", Date.now());
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          enabled,
          message: enabled
            ? "✅ 知识库已开启：将自动重建索引（纯关键词检索，秒级完成，零模型占用），之后对话可引用"
            : "已关闭知识库：不再加载模型/构建索引，内存占用归零",
        }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  // ---------- 简历项目源码（设置中心；模拟面试拷打素材） ----------
  router.route("/api/settings/personal-projects", "GET", (req, res) => {
    try {
      const projects = personalProjectsApi.getPersonalProjects();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, projects: projects.map((p) => ({ name: p.name, dir: p.dir })), note: "扫描项目目录生成源码档案，模拟面试项目拷打时面试官会基于真实代码发问" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/settings/personal-projects", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { projects } = JSON.parse(body || "{}"); // [{name, dir}]
        const r = personalProjectsApi.savePersonalProjects(projects);
        const idx = r.ok ? personalProjectsApi.indexPersonalProjects() : { ok: 0, fail: 0 };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, indexed: idx, message: `✅ 已保存 ${r.projects.length} 个项目并生成源码档案（面试官拷打用）` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

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

  // ---------- Agent 任务清单（todo 工具系统持久化进度） ----------
  router.route("/api/todo", (req, res) => {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...getTodo() }));
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
        const { company = "", title = "", summary = "", polish } = JSON.parse(body || "{}");
        // ✨ 生成 = 规则版（毫秒级免费）；🪄 AI 精修 = LLM（10-30s）。此前 polish 被忽略，两个按钮都走 LLM
        const txt = polish ? await polishGreetingText({ company, title, summary }) : buildGreetingText({ company, title });
        const polished = !!polish && typeof txt === "string" && txt.trim().length > 0;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, greeting: typeof txt === "string" && txt.trim() ? txt : buildGreetingText({ company, title }), polished: polished }));
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

  // ---------- 招聘平台（BOSS 等：列表/配置保存/搜索入库/投递） ----------
  router.route("/api/platforms", (req, res) => {
    // 先确保平台注册就绪（惰性动态 import；避免首屏 GET 拿到空列表）
    ensurePlatformsSafe().then(() => {
      if (req.method === "POST") {
        // 配置保存：面板 启用切换/Cookie/浏览器登录态/投递设置 → 落盘（此前只返回列表，patch 被静默丢弃）
        readBody(req, res, (body) => {
          try {
            const { name, patch } = JSON.parse(body || "{}");
            if (!name || !patch || typeof patch !== "object") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "需要 { name, patch }" })); return;
            }
            const updated = savePlatformAccount(String(name), patch);
            if (!updated) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: `平台 ${name} 未注册` })); return; }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, account: updated, platforms: listPlatformsApi() }));
          } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, platforms: listPlatformsApi() }));
    }).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  });
  router.route("/api/platforms/search", "POST", (req, res) => {
    readBody(req, res, async (body) => {
      try {
        // 兼容 platform/name 两种字段（面板用 platform，agent/mcp 用 platform；limit 透传）
        const { platform, name, keyword, limit } = JSON.parse(body || "{}");
        const pname = String(platform || name || "boss");
        if (!keyword) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "keyword required" })); return; }
        await ensurePlatformsSafe();
        const r = await searchAndStoreJobsApi(pname, String(keyword), { storeLimit: Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 30) : undefined });
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
        const { platform, name, url, greeting, jobId } = JSON.parse(body || "{}");
        const pname = String(platform || name || "boss");
        if (!url) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "url required" })); return; }
        await ensurePlatformsSafe();
        const r = await applyJobOnPlatformApi(pname, String(url), { greeting });
        // 闭环：投递成功 → 岗位状态转"已投递"（ready 合法状态，自动记录 applied_at），
        // 推荐列表/截止提醒/统计随之正确（此前 jobId 被忽略，投了也永远显示"未处理"）
        if (r.ok && jobId) {
          try {
            const st = jobsApi.setJobStatus(String(jobId), "ready");
            if (st?.ok === false) console.log(`[platforms] 投递后状态更新失败: ${st.error}`);
          } catch (e) {
            console.log(`[platforms] 投递后状态更新异常: ${e.message}`);
          }
        }
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

  // ---------- 求职驾驶舱（本周总览 + 7 天活动 + 累计进度 + 规则周报） ----------
  router.route("/api/dashboard", (req, res) => {
    try {
      const WEEK_MS = 7 * 24 * 3600 * 1000;
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const weekStart = dayStart.getTime() - 6 * 24 * 3600 * 1000;
      const num = (v) => Number(v) || 0;
      // 专注分钟按天聚合（focus_sessions：started_at/ended_at 为 ms 时间戳，completed=1 才计入）
      const focusByDay = {};
      try {
        for (const r of db.prepare("SELECT started_at, ended_at, completed FROM focus_sessions WHERE started_at >= ?").all(weekStart)) {
          if (!Number(r.completed) || !r.ended_at) continue;
          const key = new Date(Number(r.started_at)).toISOString().slice(0, 10);
          focusByDay[key] = (focusByDay[key] || 0) + Math.max(0, Math.round((Number(r.ended_at) - Number(r.started_at)) / 60000));
        }
      } catch { /* ignore */ }
      // 7 天序列（学习完成/复习/刷题/专注分钟）
      const week = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(dayStart.getTime() - i * 24 * 3600 * 1000);
        const next = d.getTime() + 24 * 3600 * 1000;
        const study = num(db.prepare("SELECT COUNT(*) n FROM study_plan_items WHERE done=1 AND done_at >= ? AND done_at < ?").get(d.getTime(), next).n);
        const review = num(db.prepare("SELECT COUNT(*) n FROM card_reviews WHERE reviewed_at >= ? AND reviewed_at < ?").get(d.getTime(), next).n);
        const challenge = num(db.prepare("SELECT COUNT(*) n FROM challenges WHERE done=1 AND done_at >= ? AND done_at < ?").get(d.getTime(), next).n);
        const focus = focusByDay[d.toISOString().slice(0, 10)] || 0;
        week.push({ date: d.toISOString().slice(0, 10), study, review, challenge, focus });
      }
      const weekTotals = week.reduce((a, d) => ({ studyDone: a.studyDone + d.study, reviewDone: a.reviewDone + d.review, challengeDone: a.challengeDone + d.challenge, focusMinutes: a.focusMinutes + d.focus }), { studyDone: 0, reviewDone: 0, challengeDone: 0, focusMinutes: 0 });
      const interviewCount = num(db.prepare("SELECT COUNT(*) n FROM interview_history WHERE date >= ?").get(new Date(weekStart).toISOString()).n);
      const applyCount = jobsApi.getJobs().filter((j) => j.status === "ready" || j.status === "ready_bishi" || j.status === "done").length;
      // 累计进度
      const plan = studyApi.getPlan();
      const planTotal = (plan.items || []).length;
      const planDone = (plan.items || []).filter((i) => i.done).length;
      const chTotal = num(db.prepare("SELECT COUNT(*) n FROM challenges").get().n);
      const chDone = num(db.prepare("SELECT COUNT(*) n FROM challenges WHERE done=1").get().n);
      const reviewStats = reviewApi.review.getStats();
      let weakCount = 0;
      try { weakCount = memory.getTrustedWeakPoints(50).length; } catch { /* ignore */ }
      const jobs = jobsApi.getJobs();
      const openJobs = jobs.filter((j) => j.status === "new").length;
      // 规则周报（不调 LLM：快、免费、可测）
      const highlights = [];
      const gaps = [];
      const suggestions = [];
      if (weekTotals.reviewDone > 0) highlights.push(`复习 ${weekTotals.reviewDone} 张卡`);
      if (weekTotals.studyDone > 0) highlights.push(`完成 ${weekTotals.studyDone} 个学习项`);
      if (weekTotals.challengeDone > 0) highlights.push(`刷题 ${weekTotals.challengeDone} 道`);
      if (weekTotals.focusMinutes >= 60) highlights.push(`专注 ${Math.round(weekTotals.focusMinutes / 60 * 10) / 10} 小时`);
      if (interviewCount > 0) highlights.push(`面试 ${interviewCount} 场`);
      if (applyCount > 0) highlights.push(`投递 ${applyCount} 家`);
      if (reviewStats.due > 0) gaps.push(`${reviewStats.due} 张复习卡到期未清`);
      if (chTotal - chDone > 0 && weekTotals.challengeDone === 0) gaps.push("题库本周零进度");
      if (weekTotals.focusMinutes === 0) gaps.push("本周没有专注记录");
      if (openJobs > 0 && applyCount === 0) gaps.push("有岗位但本周未投递");
      if (!highlights.length && !gaps.length) gaps.push("本周还没有活动记录");
      if (reviewStats.due > 0) suggestions.push(`🔁 先清 ${reviewStats.due} 张到期复习卡（最易忘的优先）`);
      else if (planDone < planTotal) suggestions.push(`📚 学习清单还有 ${planTotal - planDone} 项未完成`);
      else if (chTotal - chDone > 0) suggestions.push(`✍️ 手写/算法题库还剩 ${chTotal - chDone} 道`);
      if (openJobs > 0) suggestions.push(`💼 ${openJobs} 个岗位未投——先按岗面试演练再投`);
      suggestions.push(`🎯 方向：${jobsApi.getTargetDirection() || "未设置"} · 累计掌握 ${reviewStats.mastered} 张卡`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        week: { ...weekTotals, applyCount, interviewCount },
        weekSeries: week,
        progress: {
          plan: { total: planTotal, done: planDone },
          challenges: { total: chTotal, done: chDone },
          review: reviewStats,
          weak: weakCount,
          jobs: { open: openJobs, applied: applyCount },
          direction: jobsApi.getTargetDirection() || "",
        },
        report: { highlights: highlights.slice(0, 4), gaps: gaps.slice(0, 4), suggestions: suggestions.slice(0, 4) },
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- Agent 提问（ask-user：agent 需要用户决策时挂起） ----------
  router.route("/api/ask/pending", (req, res) => {
    try {
      const asks = getPendingAsks();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, asks }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  router.route("/api/ask/answer", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const { id, selected = [], reason = "" } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        const r = answerAsk(String(id), { selected, reason });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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
