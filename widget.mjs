// Mashiro 数据服务
// 功能：
//   1. 本地面板 http://127.0.0.1:8799 —— 展示今日新趋势、学习任务、秋招情报
//   2. 系统通知 —— 爬取到新趋势/新产出时弹通知
//   3. 学习提醒 —— 每天固定时间提醒做面经/笔试学习
// 用法: node widget.mjs [--no-notify]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import notifier from "node-notifier";
import { config } from "./config.mjs";
import * as reviewApi from "./lib/review.mjs";
import * as knowledgeApi from "./lib/knowledge.mjs";
import { pick as pickEmotion, EMOTIONS } from "./lib/emotions.mjs";
import { submit as laneSubmit } from "./lib/lane.mjs";
import * as jobsApi from "./lib/jobs.mjs";
import * as learningApi from "./lib/learning.mjs";
import * as ragApi from "./lib/rag.mjs";
import * as rssApi from "./lib/rss.mjs";
import * as focusApi from "./lib/focus.mjs";
import * as mailApi from "./lib/mail.mjs";
import { scanNewestFiles, loadOrCreateToken, checkBearerAuth, createCrawlMutex } from "./lib/widget-core.mjs";
import { classifyStudyFiles, pickDistinct } from "./lib/recommend.mjs";
import { createRouter } from "./lib/routes/router.mjs";
import { registerCoreRoutes } from "./lib/routes/core.mjs";
import { loadAllPlugins } from "./lib/plugin-loader.mjs";
import { db } from "./lib/db.mjs";
import { createPatrol } from "./lib/patrol.mjs";

// 纵向拆分路由注册：核心基础设施域直注册；业务域（秋招助手）经插件加载器
const router = createRouter();
const getCorsOrigin = (req) => req.headers.origin || "*";
// 插件加载：秋招助手（plugins/job-hunter，聚合 12 个业务路由域）。
// 单插件失败隔离不拖垮宿主；加载结果打日志（面板 /api/health 可查）
await loadAllPlugins({ router, db, getCorsOrigin, laneSubmit }).then((results) => {
  for (const r of results) {
    console.log(r.ok ? `[plugin] ${r.name} v${r.version} 已加载（${r.id}）` : `[plugin] ${r.error}`);
  }
});
// 核心基础设施域（health/widget-data/chat/stats/observability/refresh/notify/approval/
// run-discover/patrol/progress/schedule/首页）：runtime 全部用取数函数注入，
// 因为 patrolState/crawlMutex/DISABLE_PATROL/PATROL_MIN/MAX 声明在此之后（TDZ），
// actualPort 端口回退后会变（闭包快照会取旧值）
registerCoreRoutes(router, {
  getCorsOrigin: (req) => req.headers.origin || "*",
  laneSubmit,
  runtime: {
    getActualPort: () => actualPort,
    parseTitle: () => parseTitle,
    getStudyPlan: () => getStudyPlan(),
    checkTrends: () => checkTrends(),
    sendNotification: (t, m, o) => sendNotification(t, m, o),
    logErr: (m) => logErr(m),
    runDiscoverHidden: () => runDiscoverHidden(),
    crawlMutex: () => crawlMutex,
    patrolGetConfig: () => patrol.getConfig(),
    patrolWriteSetting: (k, v) => patrol.writeSetting(k, v),
    patrolSetBudget: (t) => patrol.setBudget(t),
    patrolGetBudget: () => patrol.dailyBudget(),
    patrolGetUsed: () => patrol.usedTokensToday(),
    patrolScheduleNext: () => patrol.scheduleNext(),
    patrolState: () => patrol.state,
    patrolDisabled: () => DISABLE_PATROL,
    patrolRun: () => patrol.run(),
    patrolMinMinutes: () => patrol.minMinutes,
    patrolMaxMinutes: () => patrol.maxMinutes,
  },
});

const PORT = Number(process.env.MIANSHI_PORT) || 8899;
const NO_NOTIFY = process.argv.includes("--no-notify");
// 测试隔离：集成测试起实例时禁用巡检定时器（生产不设置则正常巡检）
const DISABLE_PATROL = process.env.MIANSHI_DISABLE_PATROL === "1";

// ============ 数据目录 + 错误日志（最小文件日志，便于诊断静默崩溃） ============
const DATA_DIR = path.join(import.meta.dirname, "data");

function logErr(msg) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(path.join(DATA_DIR, "widget-error.log"), `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch { /* ignore */ }
}

// 未捕获异常/未处理拒绝兜底：写日志后退出（桌面守护会重启，日志可诊断）
process.on("unhandledRejection", (reason) => {
  const msg = `unhandledRejection: ${reason instanceof Error ? (reason.stack || reason.message) : String(reason)}`;
  console.error(`[widget] ${msg}`);
  logErr(msg);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  const msg = `uncaughtException: ${err && err.stack ? err.stack : String(err)}`;
  console.error(`[widget] ${msg}`);
  logErr(msg);
  process.exit(1);
});

// ============ Bearer Token 认证（防 CSRF 数据泄露/驱动 agent） ============
// 优先级：环境变量 MIANSHI_TOKEN > data/widget-token.json > 生成并落盘
const AUTH_TOKEN = process.env.MIANSHI_TOKEN || loadOrCreateToken(
  path.join(DATA_DIR, "widget-token.json"),
  { randomUUID, existsSync, readFileSync, writeFileSync, mkdirSync }
);


function parseTitle(file) {
  // 从文件名提取公司/标题：01_公司_标题.md
  const parts = file.replace(/\.md$/, "").split("_").filter(Boolean);
  if (parts.length >= 2) return { company: parts[1], title: parts.slice(2).join("_") || parts[1] };
  return { company: "未分类", title: file };
}

// ============ 学习计划 ============

function getStudyPlan() {
  const files = scanNewestFiles(30, config.outputDir);
  // 分类：笔试（文件名含 笔试/bishi/机试）vs 面经（其余，含 discover 巡检产出）
  const { bishi, mianshi } = classifyStudyFiles(files);
  const today = new Date().toISOString().slice(0, 10);
  // 简单轮转：每天建议看 2 篇笔试 + 2 篇面经（从最新产出里轮，按 path 去重防堆叠）
  const dayNum = parseInt(today.replace(/-/g, ""), 10);
  return {
    date: today,
    bishi: pickDistinct(bishi, 2, dayNum),
    mianshi: pickDistinct(mianshi, 2, dayNum),
  };
}

// ============ 系统通知 ============

function sendNotification(title, message, { wait = false } = {}) {
  if (NO_NOTIFY) return;
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    notifier.notify(
      {
        title,
        message,
        sound: true,
        wait,
        appID: "Mashiro",
        icon: path.join(config.outputDir, "..", "icon.png"),
      },
      (err) => resolve(undefined)
    );
  }));
}

// 后台运行 discover.mjs（隐藏窗口 + 日志重定向 widget-run.log，不弹终端）
// 互斥：crawlMutex 防并发 discover 子进程（每个都会拉起 Playwright chromium）
const crawlMutex = createCrawlMutex();
const crawlChildren = []; // 已 spawn 的 discover 子进程，供优雅关闭时 kill

async function runDiscoverHidden() {
  return crawlMutex.begin(async () => {
    try {
      const { spawn } = await import("node:child_process");
      const { openSync } = await import("node:fs");
      const logFd = openSync(path.join(config.outputDir, "..", "widget-run.log"), "a");
      const child = spawn("node", ["discover.mjs"], {
        cwd: import.meta.dirname,
        windowsHide: true,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      crawlChildren.push(child);
      const cleanup = () => {
        const i = crawlChildren.indexOf(child);
        if (i >= 0) crawlChildren.splice(i, 1);
      };
      child.on("exit", cleanup);
      child.on("error", cleanup);
      child.unref();
      return true;
    } catch (e) {
      console.log(`[widget] 后台爬取启动失败: ${String(e.message).slice(0, 80)}`);
      return false;
    }
  });
}

// Windows toast 备用（node-notifier 在某些环境 silent）
function toastFallback(title, message) {  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($template.CreateTextNode('${title}')) > $null
$textNodes.Item(1).AppendChild($template.CreateTextNode('${message}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Mashiro').Show($toast)`;
  exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { windowsHide: true }, () => {});
}

// ============ 状态跟踪（检测新趋势） ============

const state = { lastScan: null, seenFiles: new Set() };

async function checkTrends() {
  const files = scanNewestFiles(15, config.outputDir);
  if (files.length === 0) return;
  // 首次运行：只记录不通知（避免启动就轰炸）
  if (state.lastScan === null) {
    for (const f of files) state.seenFiles.add(f.path);
    state.lastScan = new Date();
    console.log(`[widget] 初始扫描完成，已记录 ${files.length} 个产出文件`);
    return;
  }
  const fresh = files.filter((f) => !state.seenFiles.has(f.path));
  if (fresh.length > 0) {
    for (const f of fresh) state.seenFiles.add(f.path);
    const { company, title } = parseTitle(fresh[0].file);
    const names = fresh.map((f) => parseTitle(f.file).company).join("、");
    console.log(`[widget] 发现 ${fresh.length} 个新产出: ${names}`);
    await sendNotification("📌 真白新产出", `新增 ${fresh.length} 篇：${names}\n${fresh[0].dir}`);
    if (fresh[0].dir.includes("discover")) {
      await sendNotification("🆕 新趋势/新变化", `AI 逛网发现新内容：${names}，去 output 目录看看吧`);
    }
  }
  state.lastScan = new Date();
}

// ============ 学习提醒（每天固定时间） ============

const STUDY_HOURS = [20, 21]; // 每天 20:00 / 21:00 提醒学习
const remindedToday = new Set();

async function checkStudyReminder() {
  // 设置中心开关（默认开；"0" = 关闭）
  try {
    const enabled = (db.prepare("SELECT value FROM settings WHERE key='notify_study_reminder'").get()?.value ?? "1") !== "0";
    if (!enabled) return;
  } catch { /* settings 不可用按默认开 */ }
  const now = new Date();
  const h = now.getHours();
  const todayKey = now.toISOString().slice(0, 10);
  if (STUDY_HOURS.includes(h) && !remindedToday.has(`${todayKey}-${h}`)) {
    remindedToday.add(`${todayKey}-${h}`);
    const plan = getStudyPlan();
    const bishiCount = plan.bishi.length;
    const mianshiCount = plan.mianshi.length;
    // 到期复习卡片数
    let dueCount = 0;
    try { dueCount = reviewApi.review.getDueCards().length; } catch { /* ignore */ }
    console.log(`[widget] 学习提醒触发 ${h}:00`);
    const dueText = dueCount > 0 ? `，还有 ${dueCount} 张复习卡片到期` : "";
    await sendNotification(
      "📚 面经笔试学习时间",
      `今天建议：笔试 ${bishiCount} 篇 + 面经 ${mianshiCount} 篇${dueText}\n在面板「复习」Tab 完成到期卡片`
    );
  }
}

// ============ 复习到期提醒（有到期卡主动提示：设置开关 + 19-22 点 + 每天一次，不打扰白天） ============
async function checkReviewReminder() {
  try {
    // 设置中心开关（默认开；"0" = 关闭）
    const enabled = (db.prepare("SELECT value FROM settings WHERE key='notify_review_reminder'").get()?.value ?? "1") !== "0";
    if (!enabled) return;
    const due = reviewApi.review.getDueCards();
    if (due.length === 0) return;
    // 只在晚间活跃时段提醒（19-22 点）——此前 9 点后随时弹（启动 1 分钟 + 30 分钟一轮）被用户感知为"突然触发复习"
    const h = new Date().getHours();
    if (h < 19 || h > 22) return;
    // 每天最多一次（替代 2h 冷却，进一步降打扰）
    const todayKey = new Date().toISOString().slice(0, 10);
    const lastDay = db.prepare("SELECT value FROM settings WHERE key='last_review_remind_date'").get()?.value || "";
    if (lastDay === todayKey) return;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('last_review_remind_date', ?, ?)").run(todayKey, Date.now());
    console.log(`[widget] 复习到期提醒：${due.length} 张`);
    await sendNotification(
      "📚 复习提醒",
      `${due.length} 张复习卡到期（最易忘的优先）\n方便时在面板「🔁 复习」Tab 完成，答对会自动拉长下次间隔`
    );
  } catch { /* ignore */ }
}

// ============ 校招岗位截止/笔试提醒（3 天内主动提示，9 点后 + 6 小时冷却防骚扰） ============
let lastJobDeadlineNotify = 0; // 上次岗位提醒时间戳（ms），6 小时冷却

async function checkJobDeadline() {
  try {
    const upcoming = jobsApi.getUpcomingJobDeadlines(jobsApi.getJobs());
    if (upcoming.length === 0) return;
    // 9 点后才提醒（避免半夜打扰）；距上次提醒 >6 小时才再次提醒
    const h = new Date().getHours();
    if (h < 9) return;
    const now = Date.now();
    if (now - lastJobDeadlineNotify < 6 * 3600 * 1000) return;
    lastJobDeadlineNotify = now;
    console.log(`[widget] 岗位截止/笔试提醒：${upcoming.length} 个`);
    const lines = upcoming.slice(0, 5).map((j) => `${j.company}·${j.title}（${j.dueDate} ${j.kind}）`);
    await sendNotification(
      "⏰ 校招岗位提醒",
      `${upcoming.length} 个岗位即将截止/笔试：\n${lines.join("\n")}${upcoming.length > 5 ? `\n…等 ${upcoming.length} 个` : ""}`
    );
  } catch { /* ignore */ }
}

// ============ 每日技术资讯摘要（8:00-10:00 窗口内每天一次） ============

async function checkRssDigest() {
  const h = new Date().getHours();
  if (h < 8 || h >= 10) return; // 只在早上 8-10 点窗口内摘要，避免半夜打扰
  const today = rssApi.localToday();
  const last = rssApi.getLastDigestAt();
  if (last && rssApi.localToday(new Date(last)) === today) return; // 今天已摘要过（幂等门控）
  try {
    console.log("[widget] 开始今日技术资讯摘要…");
    const r = await rssApi.runDailyDigest();
    if (r.digest.length) {
      const top3 = r.digest.slice(0, 3).map((d) => d.title.slice(0, 24)).join("\n");
      await sendNotification("📰 今日技术资讯", `${top3}\n面板查看全部`);
    } else {
      console.log("[widget] 今日资讯摘要为空（各源无新条目）");
    }
  } catch (e) {
    console.log(`[widget] 资讯摘要失败: ${String(e.message).slice(0, 80)}`);
  }
}

// ============ 面试/笔试邀约提醒（24h 内提前提醒，4 小时冷却防重复轰炸） ============

async function checkScheduleReminder() {
  try {
    // 未来 24h 内的邀约
    const events = mailApi.getUpcomingEvents({ withinDays: 1 });
    if (!events.length) return;
    const now = Date.now();
    for (const ev of events) {
      // 距上次提醒 >4h 才再次提醒（lastNotifiedAt 持久化在 schedule_events.last_notified_at）
      if (ev.lastNotifiedAt && now - ev.lastNotifiedAt < 4 * 3600 * 1000) continue;
      const time = new Date(ev.interviewAt).toLocaleString("zh-CN", { hour12: false });
      console.log(`[widget] 面试提醒触发：${ev.company}·${ev.role} ${time}`);
      await sendNotification(
        "⏰ 面试提醒",
        `${ev.company}·${ev.role} ${time}（${ev.form || "形式待定"}）${ev.link ? `\n${ev.link}` : ""}`
      );
      mailApi.markNotified(ev.id); // 更新 last_notified_at，避免同一邀约反复提醒
    }
  } catch { /* ignore */ }
}

// ============ 专注结束自动结算（到点自动完成 + 通知，30 秒检查一次） ============

async function checkFocusEnd() {
  try {
    const s = focusApi.getFocusStatus();
    if (!s.active) return;
    if (Date.now() >= s.endAt) {
      focusApi.stopFocus(true);
      console.log("[widget] 专注结束自动结算");
      await sendNotification("⏰ 专注结束", `${s.mode} 分钟到了，休息一下`);
    }
  } catch { /* ignore */ }
}

// 请求体读取/限流（readBody，1MB 上限）已抽到 lib/widget-core.mjs（可单测）

// ============ HTTP 服务 ============

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // CORS 白名单（安全）：仅允许面板渲染层（Electron file:// 页面，Origin 为 null/缺失）
  // 与本机调用；拒绝任意网页跨域读取简历/驱动 agent/批准工具（防 CSRF + 数据泄露）
  const reqOrigin = req.headers.origin;
  const originOk = !reqOrigin || reqOrigin === "null" || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(reqOrigin);
  if (!originOk) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden: unknown origin");
    return;
  }
  const corsOrigin = reqOrigin || "*";
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Bearer token 认证：/api/*（除 /api/health）必须带 Authorization: Bearer <token>
  // 防 CSRF 数据泄露/驱动 agent；CORS 白名单已挡掉任意网页，这里再挡 Origin:null 沙盒 iframe
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health") {
    if (!checkBearerAuth(req.headers.authorization, AUTH_TOKEN)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "未授权：缺少或错误的 Bearer token" }));
      return;
    }
  }

  // 域路由分发（lib/routes/*.mjs 注册；未命中 404）
  {
    const h = router.resolve(url.pathname, req.method);
    if (h) { h.fn(req, res, url); return; }
  }

  res.writeHead(404); res.end("Not Found");
});

// 启动自检：key 缺失/格式异常时明确报错退出（避免静默运行全部 LLM 调用失败）
try {
  const { assertConfig } = await import("./config.mjs");
  assertConfig();
} catch (e) { /* config.mjs 无此导出时忽略 */ }

// ============ 启动：端口占用回退（EADDRINUSE 不再静默崩溃） ============
let actualPort = PORT;
let listenAttempt = 0;
const MAX_PORT_RETRIES = 3;

function writeWidgetPort(port) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path.join(DATA_DIR, "widget-port.json"), JSON.stringify({ port, ts: Date.now() }), "utf8");
  } catch (e) {
    console.log(`[widget] 写入端口文件失败: ${e.message}`);
  }
}

function tryListen() {
  server.listen(actualPort, "127.0.0.1", () => {
    console.log(`✅ 桌面小组件已启动: http://127.0.0.1:${actualPort}`);
    console.log(`   学习提醒: 每天 ${STUDY_HOURS.join(":00 / ")}:00 弹通知`);
    console.log(`   趋势检测: 每 5 分钟扫描 output 目录，发现新产出弹通知`);
    console.log(`   Ctrl+C 停止`);
    writeWidgetPort(actualPort);
  });
}

server.on("error", (/** @type {NodeJS.ErrnoException} */ err) => {
  const code = err.code;
  if (code === "EADDRINUSE" && listenAttempt < MAX_PORT_RETRIES) {
    listenAttempt++;
    const prev = actualPort;
    actualPort = PORT + listenAttempt;
    console.log(`[widget] 端口 ${prev} 被占用，改用 ${actualPort} 重试（${listenAttempt}/${MAX_PORT_RETRIES}）`);
    logErr(`端口 ${prev} 被占用，改用 ${actualPort} 重试`);
    tryListen();
  } else {
    console.error(`[widget] 服务器启动失败: ${code || err.message}（端口 ${actualPort}）`);
    logErr(`服务器启动失败: ${code || err.message}（端口 ${actualPort}）`);
    process.exit(1);
  }
});

tryListen();

// ============ 主动推送：按关注点定时巡检新内容（纵向拆分：逻辑在 lib/patrol.mjs，可独立测试） ============
const patrol = createPatrol({
  disabled: DISABLE_PATROL,
  sendNotification,
  crawlMutex,
  runDiscoverHidden,
});
patrol.scheduleNext(); // 启动巡检：读配置动态排程（环境变量强制关闭或面板关闭时不排程）
console.log(`[widget] 自动巡检: ${DISABLE_PATROL ? "关闭（环境变量 MIANSHI_DISABLE_PATROL=1）" : patrol.state.enabled ? `开启（每 ${patrol.state.intervalMin} 分钟）` : "关闭（面板设置）"}`);

// ============ 后台任务管理（门控 + 互斥 + 优雅关闭） ============
// 测试/无后台场景：MIANSHI_DISABLE_BACKGROUND=1 关闭所有后台定时任务（RAG 构建/每日搜集）
const DISABLE_BACKGROUND = process.env.MIANSHI_DISABLE_BACKGROUND === "1";
const timers = [];
const registerTimer = (fn, ms, ...args) => { timers.push(setTimeout(fn, ms, ...args)); };
const registerInterval = (fn, ms, ...args) => { timers.push(setInterval(fn, ms, ...args)); };

// 本地知识库：设置中心开关（rag_enabled，默认关）——开启后启动自动构建 + 每 6 小时增量
let ragBuilding = false;
const ragBuildTick = async () => {
  if (ragBuilding) return;
  if (!ragApi.ragEnabled()) return; // 未启用：不构建、不加载模型（0 内存）
  ragBuilding = true;
  try {
    const stats = ragApi.getKnowledgeStats();
    if (!stats.total) {
      console.log("[rag] 知识库为空，后台构建中…");
      const r = await ragApi.rebuildKnowledgeBase();
      if (r) console.log(`[rag] 知识库构建完成：${r.items} 条（${r.seconds}s）`);
      else console.log("[rag] 知识库构建被跳过（已有重建进行中）");
    } else {
      // 非空：增量更新（新面经 md 自动进库）
      const r = await ragApi.incrementalRebuild();
      if (r?.changed) console.log(`[rag] 知识库增量更新：+${r.added} -${r.removed}（${r.seconds}s）`);
    }
  } catch (e) {
    console.log(`[rag] 知识库构建失败：${String(e.message).slice(0, 80)}`);
  } finally {
    ragBuilding = false;
  }
};
if (!DISABLE_BACKGROUND) {
  registerTimer(ragBuildTick, 10 * 1000);
  registerInterval(ragBuildTick, 6 * 3600 * 1000); // 每 6 小时增量更新（新 md/新岗位/新复习卡自动进库）
}

// ============ 周期任务 ============

// 初始扫描（不通知）
registerTimer(checkTrends, 3000);
// 每 5 分钟检测新趋势
registerInterval(checkTrends, 5 * 60 * 1000);
// 每分钟检查学习提醒
registerInterval(checkStudyReminder, 60 * 1000);
// 每 30 分钟检查复习到期（9 点后，有到期卡每天提醒一次）
registerInterval(checkReviewReminder, 30 * 60 * 1000);
registerTimer(checkReviewReminder, 60 * 1000); // 启动 1 分钟后先查一次
// 每小时检查岗位截止/笔试（3 天内，9 点后 + 6 小时冷却）
registerInterval(checkJobDeadline, 60 * 60 * 1000);
registerTimer(checkJobDeadline, 3 * 60 * 1000); // 启动 3 分钟后先查一次
// 每日技术资讯摘要：每 30 分钟 tick（8-10 点窗口 + 每天一次门控）；启动 5 分钟后 catch-up
if (!DISABLE_BACKGROUND) {
  registerInterval(checkRssDigest, 30 * 60 * 1000);
  registerTimer(checkRssDigest, 5 * 60 * 1000);
}
// 专注结束自动结算：每 30 秒检查；启动 1 分钟后 catch-up
registerInterval(checkFocusEnd, 30 * 1000);
registerTimer(checkFocusEnd, 60 * 1000);
// 邮件/笔试邀约提醒：每 30 分钟检查（24h 内 + 4 小时冷却）；启动 2 分钟后 catch-up
registerInterval(checkScheduleReminder, 30 * 60 * 1000);
registerTimer(checkScheduleReminder, 2 * 60 * 1000);
// 系统自检（闭环：注释/面板承诺"启动后自动首检 + 每 6 小时"，此前 runSelfCheck 只被手动按钮触发从未接线）
let __selfCheckMod = null;
const runSelfCheckAndSave = async () => {
  try {
    if (!__selfCheckMod) __selfCheckMod = await import("./lib/self-check.mjs");
    const report = __selfCheckMod.runSelfCheck();
    __selfCheckMod.saveSelfCheck(report);
    if (report?.issues?.length) console.log(`[widget] 自检发现 ${report.issues.length} 个隐患：${report.issues.map((i) => i.name).join("、")}`);
  } catch (e) { console.log(`[widget] 自检失败: ${String(e?.message || e).slice(0, 80)}`); }
};
if (!DISABLE_BACKGROUND) {
  registerTimer(runSelfCheckAndSave, 60 * 1000);          // 启动 60s 后首检（面板承诺）
  registerInterval(runSelfCheckAndSave, 6 * 3600 * 1000); // 每 6 小时
}
// 邮箱自动检查（闭环：设置中心配置邮箱 → 定时拉未读 → LLM 识别邀约 → schedule_events → 提醒）。
// 此前只有手动「立即检查」触发，配置后从不自动拉取，日程/提醒永远空
const checkMail = async () => {
  try {
    const cfg = mailApi.getConfig();
    if (!cfg.enabled || !cfg.email || !cfg.authCode) return; // 未配置/未启用不拉取
    console.log("[widget] 邮箱自动检查…");
    await mailApi.runMailCheck();
  } catch (e) {
    console.log(`[widget] 邮箱检查失败: ${String(e?.message || e).slice(0, 80)}`);
  }
};
if (!DISABLE_BACKGROUND) {
  registerInterval(checkMail, 30 * 60 * 1000); // 每 30 分钟
  registerTimer(checkMail, 90 * 1000);         // 启动 90 秒后先检查一次
}

// ============ 持久化定时任务（scheduled_jobs，OpenClaw Automations 风格） ============
// 现有硬编码定时器（巡检/资讯摘要/学习提醒）保持不变；scheduler 是 ADDITIVE 层：
// 把调度写进 SQLite，可配置/可禁用/失败自动停用。种子任务默认禁用，不抢现有定时器的活（防双重触发）。
import { createScheduler } from "./lib/scheduler.mjs";

const scheduler = createScheduler({
  db,
  executes: {
    patrol: async () => {
      try {
        if (DISABLE_PATROL) return { ok: false, error: "MIANSHI_DISABLE_PATROL=1 强制关闭巡检" };
        await patrol.run(); // 调度器 patrol job → 真实巡检（patrolInterests 从未定义，历史死调用）
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    rss_digest: async () => {
      try {
        await checkRssDigest();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    study_remind: async () => {
      try {
        await checkStudyReminder();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
  },
});

// 种子默认任务（表空才种，防重启重复）：默认禁用（enabled:false），config.seeded 标记来源
function seedDefaultJobs() {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM scheduled_jobs").get();
    if (Number(row && row.n) > 0) return;
    scheduler.registerJob({
      name: "自动巡检",
      job_type: "patrol",
      schedule_spec: `interval:${patrol.state.intervalMin}`, // 沿用现有巡检间隔设置
      enabled: false,
      config: { seeded: true, source: "widget-defaults" },
    });
    const rss = scheduler.registerJob({
      name: "每日技术资讯摘要",
      job_type: "rss_digest",
      schedule_spec: "daily:0900", // 沿用现有 8-10 点摘要窗口（取 9 点）
      enabled: false,
      config: { seeded: true, source: "widget-defaults" },
    });
    console.log(`[scheduler] 已种默认任务: ${patrol.id}（巡检）/ ${rss.id}（资讯摘要）——默认禁用，不抢现有定时器`);
  } catch (e) {
    logErr(`scheduler 种子默认任务失败: ${e && e.message ? e.message : String(e)}`);
  }
}
seedDefaultJobs();

// 每分钟 tick 一次，串行跑到期任务（内部有重入保护 + 全 try/catch，绝不抛崩进程）
if (!DISABLE_BACKGROUND) {
  registerInterval(() => { scheduler.checkDue().catch(() => {}); }, 60 * 1000);
}

// ---------- 每日自动岗位搜集（24h 门控：白天执行，距上次搜集 >24h 才跑；running 互斥防重叠） ----------
let collectJobsRunning = false;
const collectJobsDailyTick = async () => {
  if (collectJobsRunning) return; // 互斥：手动触发/定时 tick 重叠时跳过
  const h = new Date().getHours();
  if (h < 8 || h > 23) return; // 白天窗口，避免半夜打扰/反爬
  collectJobsRunning = true;
  try {
    const r = await jobsApi.collectJobsDaily();
    if (r?.ok && r.totalNew > 0) console.log(`[jobs] 每日自动搜集完成：新增 ${r.totalNew} 条岗位`);
  } catch (e) {
    console.log(`[jobs] 每日自动搜集失败：${String(e.message).slice(0, 80)}`);
  } finally {
    collectJobsRunning = false;
  }
};
if (!DISABLE_BACKGROUND) {
  registerTimer(collectJobsDailyTick, 2 * 60 * 1000); // 启动 2 分钟后首查
  registerInterval(collectJobsDailyTick, 30 * 60 * 1000); // 每 30 分钟 tick（24h 门控幂等）
}

// ---------- 每日记忆巩固（dreaming，OpenClaw 风格：候选 → 提炼 → 长期记忆） ----------
// 24h 门控：读 settings['last_dreaming']，距上次 <24h 跳过；fire-and-forget 安全（全 try/catch，绝不抛）
let dreamingRunning = false;
const dreamingTick = async () => {
  if (dreamingRunning) return; // 互斥：定时 tick 与上一次尚未完成重叠时跳过
  try {
    let last = 0;
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("last_dreaming");
      last = row ? Number(row.value) || 0 : 0;
    } catch { /* settings 不可用按 0 处理 */ }
    if (last && Date.now() - last < 24 * 3600 * 1000) return; // 距上次 <24h 跳过
    dreamingRunning = true;
    try {
      const { runDreaming } = await import("./lib/dreaming.mjs");
      const r = await runDreaming();
      if (r && r.ok) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
          .run("last_dreaming", String(Date.now()), Date.now());
        console.log(`[dreaming] 记忆巩固完成：候选 ${r.candidates} 条，新增 ${r.added}，更新 ${r.updated}，丢弃 ${r.dropped}`);
      } else {
        logErr(`dreaming: ${(r && r.error) || "未知错误"}`);
      }
    } finally {
      dreamingRunning = false;
    }
  } catch (err) {
    logErr(`dreaming: ${err && err.message ? err.message : String(err)}`);
  }
};
if (!DISABLE_BACKGROUND) {
  registerTimer(dreamingTick, 4 * 60 * 1000); // 启动 4 分钟后首查
  registerInterval(dreamingTick, 12 * 3600 * 1000); // 每 12 小时检查（24h 门控幂等）
  // MCP 自环配置自愈：data/mcp-servers.json 缺失时生成默认自环（桌宠经 mcp__mianshi__* 消费个人数据/核心能力）
  try {
    const mcpCfgFile = path.join(import.meta.dirname, "data", "mcp-servers.json");
    if (!existsSync(mcpCfgFile)) {
      mkdirSync(path.dirname(mcpCfgFile), { recursive: true });
      writeFileSync(mcpCfgFile, JSON.stringify([{
        name: "mashiro",
        command: "node",
        args: [path.join(import.meta.dirname, "mcp-server.mjs").replace(/\\/g, "/")],
        permission: "auto",
        description: "Mashiro 自身能力（搜索面经/讲解/学习清单/模拟面试/个人数据：简历/校招/日程/学习进度）",
      }], null, 2), "utf8");
      console.log("[widget] 已生成默认 MCP 自环配置（data/mcp-servers.json）");
    }
  } catch (e) {
    logErr(`MCP 自环配置自愈失败: ${e && e.message ? e.message : String(e)}`);
  }
}

// 优雅关闭：停止接收连接 → 清理定时器 → kill 爬取子进程 → 关闭 DB（WAL checkpoint）→ 退出
const cleanupTimers = () => { for (const t of timers) clearTimeout(t); };
server.on("close", cleanupTimers);

function shutdown() {
  console.log("[widget] 收到退出信号，优雅关闭中…");
  cleanupTimers();
  try { server.close(); } catch { /* ignore */ }
  for (const c of crawlChildren) {
    try { c.kill(); } catch { /* ignore */ }
  }
  try { db.close(); } catch { /* ignore */ } // WAL checkpoint + 释放连接
  setTimeout(() => process.exit(0), 200);
  setTimeout(() => process.exit(1), 3000).unref(); // 兜底：3s 后强制退出
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
