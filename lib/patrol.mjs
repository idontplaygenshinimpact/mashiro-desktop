// lib/patrol.mjs —— 主动推送巡检模块（纵向拆分：从 widget.mjs 迁出）
// 关注点巡检：配置持久化（settings 表）+ 动态排程 + 多站搜索新帖 → 分类/方向过滤 →
// 具体题目检测 → 完整讲解存档（output/<date>_patrol/），带每日 token 预算门控
// 依赖注入（widget 运行时设施）：disabled/sendNotification/crawlMutex/runDiscoverHidden；
// db/memory/config 直接 import
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";
import { db } from "./db.mjs";
import { memory } from "./memory.mjs";
import { getCareerProfile } from "./career.mjs";

// ---------- 巡检配置（面板可改，持久化到 settings 表） ----------
// patrol_enabled: "1"/"0"（默认开启；MIANSHI_DISABLE_PATROL=1 环境变量强制关闭且忽略面板开关）
// patrol_interval_min: 分钟（默认 60，合法 15-1440 整数）
// patrol_last_run: 上次定时巡检完成时间戳（毫秒，widget 重启不丢）
const PATROL_MIN_MINUTES = 15;
const PATROL_MAX_MINUTES = 1440;

// ---------- DS 峰谷时段工具（纯函数，可单测） ----------
// DeepSeek 2026-08-16 起峰谷计价（官方 + dsh-handbook 14-cost 实测）：
// 峰时（北京时间）= 09:00-12:00 + 14:00-18:00（价格 2 倍），其余为谷时（半价）
// 自动任务应避开峰时（长跑挪到晚上或早 8 点前，账单直接减半）
/** 是否处于峰时（按本地时间） */
export function isDsPeakHour(d) {
  const h = d.getHours() + d.getMinutes() / 60;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 避开峰时：at 落在峰时窗口 → 推迟到该窗口结束（12:00 / 18:00，已过则次日 00:30 谷时）；谷时或 avoidPeak=false → 原样 */
export function avoidPeakTime(at, avoidPeak = true) {
  if (!avoidPeak) return at;
  const d = new Date(at);
  const h = d.getHours() + d.getMinutes() / 60;
  let target = at;
  if (h >= 9 && h < 12) { const n = new Date(d); n.setHours(12, 0, 0, 0); target = n.getTime(); }
  else if (h >= 14 && h < 18) { const n = new Date(d); n.setHours(18, 0, 0, 0); target = n.getTime(); }
  else return at; // 谷时：不推迟
  if (target <= Date.now()) { // 窗口结束已过 → 次日 00:30（谷时起点，避免再撞次日峰时）
    const n = new Date(target);
    n.setDate(n.getDate() + 1);
    n.setHours(0, 30, 0, 0);
    target = n.getTime();
  }
  return target;
}
const PATROL_DEFAULT_MINUTES = 60;
const PATROL_BUDGET_KEY = "patrol_daily_tokens";
const PATROL_BUDGET_DEFAULT = 100000; // 默认每日上限（4 帖 × 讲解 ~2.4 万 token/帖 + 分类/题目检测）

/**
 * 创建巡检器（widget.mjs 组装；也可独立测试）
 * @param {object} deps
 * @param {boolean} [deps.disabled=false] 环境变量强制关闭（MIANSHI_DISABLE_PATROL=1）
 * @param {Function} [deps.sendNotification] (title, message) => void
 * @param {{isRunning: () => boolean}} [deps.crawlMutex] 全量爬取互斥
 * @param {Function} [deps.runDiscoverHidden] 后台触发 discover.mjs
 */
export function createPatrol({
  disabled = false,
  sendNotification = async () => {},
  crawlMutex = { isRunning: () => false },
  runDiscoverHidden = async () => {},
} = {}) {
  function readSetting(key, fallback) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      return row && row.value != null ? String(row.value) : fallback;
    } catch { /* settings 表暂不可用时走默认值 */ }
    return fallback;
  }
  function writeSetting(key, value) {
    try {
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, String(value), Date.now());
    } catch { /* ignore */ }
  }
  function normalizeInterval(v) {
    const n = Math.round(Number(v));
    return Number.isInteger(n) && n >= PATROL_MIN_MINUTES && n <= PATROL_MAX_MINUTES ? n : PATROL_DEFAULT_MINUTES;
  }

  const state = {
    enabled: !disabled && readSetting("patrol_enabled", "1") !== "0",
    intervalMin: normalizeInterval(readSetting("patrol_interval_min", String(PATROL_DEFAULT_MINUTES))),
    // 避开 DS 峰时（北京 09:00-12:00 + 14:00-18:00，价格 2 倍）：峰时内的触发推迟到谷时
    avoidPeak: readSetting("patrol_avoid_peak", "1") !== "0",
    lastRun: Number(readSetting("patrol_last_run", "0")) || 0,
    startedAt: Date.now(),
    timer: null,
    nextRun: null,
  };

  let running = false; // 巡检重入保护标记
  let lastFullCrawl = null; // 全量爬取限频标记

  /** 读取巡检 token 预算（0=不限） */
  function dailyBudget() {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(PATROL_BUDGET_KEY);
      const n = row?.value != null ? Number(String(row.value)) : PATROL_BUDGET_DEFAULT;
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } catch { return PATROL_BUDGET_DEFAULT; }
  }

  /** 今日巡检已用 token（trace_llm 按 role=patrol 汇总） */
  function usedTokensToday() {
    try {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const r = db.prepare("SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM trace_llm WHERE role='patrol' AND ts >= ?").get(start.getTime());
      return (Number(r?.i) || 0) + (Number(r?.o) || 0);
    } catch { return 0; }
  }

  /** 巡检 token 预算检查：剩余可用；超限返回剩余 0（run/processPosts 开头调用） */
  function budgetRemaining() {
    const budget = dailyBudget();
    if (budget <= 0) return Infinity; // 0 = 不限
    return budget - usedTokensToday();
  }

  /** 更新巡检配置里的预算（patrol-config API 用） */
  function setBudget(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "预算必须是 ≥0 的整数（0=不限）" };
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(PATROL_BUDGET_KEY, String(Math.floor(n)), Date.now());
    return { ok: true };
  }

  function getConfig() {
    const forceOff = disabled;
    return {
      ok: true,
      enabled: forceOff ? false : state.enabled,
      intervalMin: state.intervalMin,
      avoidPeak: state.avoidPeak,
      lastRun: state.lastRun || null,
      nextRun: forceOff || !state.enabled ? null : state.nextRun,
      note: forceOff ? "环境变量 MIANSHI_DISABLE_PATROL=1 已强制关闭巡检（面板开关不可用）" : undefined,
    };
  }

  // 动态排程：读配置 → setTimeout 到下次触发 → 触发后重新排程（递归，替代固定 setInterval）
  // 避开高峰：触发时刻落在 DS 高峰（北京 00:30-08:30）→ 推迟到 08:30 后（价格上浮 50%，省钱）
  function scheduleNext() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (disabled || !state.enabled) { state.nextRun = null; return; }
    const base = state.lastRun || state.startedAt;
    let at = base + state.intervalMin * 60 * 1000;
    at = avoidPeakTime(at, state.avoidPeak); // 模块级纯函数（避开高峰）
    state.nextRun = at;
    const delay = Math.max(at - Date.now(), 1000);
    state.timer = setTimeout(async () => {
      state.timer = null;
      try {
        await run();
        state.lastRun = Date.now();
        writeSetting("patrol_last_run", String(state.lastRun));
      } catch (e) {
        console.log(`[widget] 巡检异常: ${String(e.message).slice(0, 80)}`);
      }
      scheduleNext();
    }, delay);
    console.log(`[widget] 自动巡检已排程: ${new Date(at).toLocaleString("zh-CN")} 触发（每 ${state.intervalMin} 分钟）`);
  }

  // 巡检方向白名单：跟随求职目标（方向画像 direction；默认前端/Agent）
  // backend → 只巡检后端/全栈；fullstack → 全方向；frontend/agent/未设置 → 前端/Agent
  function goodDirs() {
    try {
      const { direction } = getCareerProfile();
      if (direction === "backend") return ["backend", "fullstack"];
      if (direction === "fullstack") return ["frontend", "agent", "fullstack", "backend"];
      if (direction === "agent") return ["agent", "frontend"];
    } catch { /* ignore */ }
    return ["frontend", "agent"];
  }

  // 巡检帖 → 抓正文 → 分类/方向过滤 → 具体题目检测 → 完整讲解 → 存档
  // 返回 { saved: [文件名], skipped: { 原因: 篇数 } }
  async function processPosts(posts) {
    const saved = [];
    const skipped = {};
    const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
    try {
      const { fetchPage } = await import("./fetch-page.mjs");
      const { classifyPage, detectQuestions, solveQuestion } = await import("./ai.mjs");
      const GOOD_DIRS = goodDirs(); // 方向过滤跟随求职目标（转后端后只巡检后端相关）
      for (const p of posts) {
        try {
          // 每日 token 预算：每帖处理前检查，超限停止（讲解是 token 大户）
          if (budgetRemaining() <= 0) {
            console.log(`[widget] 巡检讲解停止：今日 token 预算已用尽`);
            skip("token 预算用尽");
            break;
          }
          // 标记已看（避免下次重复通知）
          memory.markSeen(p.url);
          const page = await fetchPage(p.url, { maxTextChars: 6000 });
          if (!page.ok || page.invalid || !page.text || page.text.length < 200) { skip("页面无效/404"); continue; }
          // 方向过滤：跟随求职目标
          const cls = await classifyPage({ title: page.title, text: page.text }, "patrol");
          if (!GOOD_DIRS.includes(cls.direction)) { skip("非目标方向"); continue; }
          if (cls.worth < 40) { skip("内容价值低"); continue; }
          // 具体题目检测：攻略文跳过
          const dq = await detectQuestions({ title: page.title, text: page.text }, "patrol");
          if (!dq.hasQuestion || !dq.questions?.length) { skip("攻略文/无具体题"); continue; }
          // 完整讲解
          const md = await solveQuestion({
            title: page.title,
            text: dq.questions.slice(0, 3).map((q, i) => `【题${i + 1}】${q.question}`).join("\n"),
            company: cls.company,
            position: cls.position,
            sourceUrl: p.url,
          }, "patrol");
          // 存档到 output/<date>_patrol/
          const date = new Date().toISOString().slice(0, 10);
          const dir = path.join(config.outputDir, `${date}_patrol`);
          mkdirSync(dir, { recursive: true });
          const fname = `${String(saved.length + 1).padStart(2, "0")}_${(cls.company || cls.type || "patrol").replace(/[\\/:*?"<>|]/g, "_")}_${page.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 30)}.md`;
          writeFileSync(path.join(dir, fname), `# ${page.title}\n\n> 来源: ${p.url}\n\n${md}\n`, "utf8");
          saved.push(fname);
          console.log(`[widget] 巡检讲解完成: ${fname}`);
        } catch (e) {
          console.log(`[widget] 巡检讲解失败 ${p.url}: ${e.message}`);
          skip("讲解失败");
        }
      }
    } catch (e) {
      console.log(`[widget] processPatrolPosts 异常: ${e.message}`);
    }
    return { saved, skipped };
  }

  // 主动巡检一轮（定时触发 / 手动 /api/patrol-run 共用）
  async function run() {
    if (running) return; // 重入保护：定时巡检与手动 /api/patrol-run 重叠时跳过
    // 每日 token 预算检查（设置中心可配；超限跳过本轮巡检）
    const remaining = budgetRemaining();
    if (remaining <= 0) {
      console.log(`[widget] 巡检跳过：今日 token 预算已用尽（上限 ${dailyBudget()}）`);
      return;
    }
    const interests = memory.getInterests();
    if (!interests.length) return;
    running = true;
    try {
      const { fetchPage } = await import("./fetch-page.mjs");
      const re = /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+)/;
      // 标题级方向过滤：方向排除词来自画像 ignoreNote（转方向/开源自动跟随）+ 与方向无关的噪音词
      const { getCareerProfile } = await import("./career.mjs");
      const prof = getCareerProfile();
      const noiseRe = /嵌入式|单片机|硬件|驱动|PCB|STM32|ESP32|ARM|芯片|FPGA|物联网|上位机|爬虫开发/;
      const ignoreWords = String(prof.ignoreNote || "")
        .split(/[/、,，\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && !/[（()）]/.test(s));
      const dirRe = ignoreWords.length
        ? new RegExp(ignoreWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
        : null;
      const EXCLUDE_TITLE = dirRe ? new RegExp(`${noiseRe.source}|${dirRe.source}`, "i") : noiseRe;
      const newPosts = [];
      // 取前 2 个关注点，每个搜多站（牛客/掘金/CSDN）
      const searchSites = [
        (q) => `https://www.nowcoder.com/discuss?type=2&query=${encodeURIComponent(q)}`,
        (q) => `https://juejin.cn/search?query=${encodeURIComponent(q + " 面经")}`,
        (q) => `https://so.csdn.net/so/search?q=${encodeURIComponent(q + " 面经")}`,
      ];
      for (const topic of interests.slice(0, 2)) {
        for (const makeUrl of searchSites) {
          const url = makeUrl(topic);
          try {
            const page = await fetchPage(url, { maxTextChars: 1500, collectLinks: true });
            for (const l of page.links) {
              if (re.test(l.href) && l.text.length > 8) {
                if (EXCLUDE_TITLE.test(l.text)) continue; // 非前端方向标题跳过
                const clean = l.href.replace(/[?&]searchId=[^&]*/g, "").split("?")[0];
                if (!memory.isSeen(clean)) {
                  newPosts.push({ title: l.text.slice(0, 50), url: clean, topic });
                }
              }
            }
          } catch { /* ignore */ }
        }
      }
      if (newPosts.length) {
        const names = newPosts.slice(0, 3).map((p) => p.title.slice(0, 20)).join("、");
        console.log(`[widget] 巡检发现 ${newPosts.length} 条新内容（关注点 ${interests.slice(0, 2).join("、")}）`);
        // 真正处理：抓正文 → 分类过滤 → 讲解 → 存档（通知不再"空口说白话"）
        const result = await processPosts(newPosts.slice(0, 4));
        const saved = result.saved;
        let detail;
        if (saved.length) {
          detail = `已生成讲解：\n${saved.map((s) => `  📄 ${s}`).join("\n")}\n在面板「🔍 爬取产出」查看`;
        } else {
          // 如实说明未生成的原因（不再是笼统的"都是旧内容"）
          const reasons = Object.entries(result.skipped || {}).filter(([, n]) => n > 0);
          const reasonText = reasons.length
            ? reasons.map(([k, n]) => `${k} ${n} 篇`).join("；")
            : "未说明原因";
          detail = `未生成新讲解（${reasonText}）`;
        }
        await sendNotification("🆕 真白发现新面经", `${names}${newPosts.length > 3 ? ` 等 ${newPosts.length} 条` : ""}\n${detail}`);
      } else {
        // 多站都没找到新帖：触发一次完整 discover 全量爬取（7 源），但限制频率（2 小时一次）
        const now = Date.now();
        if (now - (lastFullCrawl || 0) > 2 * 60 * 60 * 1000) {
          lastFullCrawl = now;
          if (crawlMutex.isRunning()) {
            console.log("[widget] 巡检无新帖，但已有爬取任务运行中，跳过全量爬取");
          } else {
            console.log("[widget] 巡检无新帖，触发全量爬取");
            try {
              runDiscoverHidden();
            } catch { /* ignore */ }
          }
        } else {
          console.log("[widget] 巡检无新帖，全量爬取冷却中（2 小时限频）");
        }
      }
    } catch { /* ignore */ } finally {
      running = false;
    }
  }

  // 停止排程（退出/测试清理用：清掉挂起的 timer）
  function stop() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.nextRun = null;
  }

  return {
    state,
    minMinutes: PATROL_MIN_MINUTES,
    maxMinutes: PATROL_MAX_MINUTES,
    getConfig,
    scheduleNext,
    stop,
    run,
    dailyBudget,
    usedTokensToday,
    budgetRemaining,
    setBudget,
    writeSetting,
  };
}