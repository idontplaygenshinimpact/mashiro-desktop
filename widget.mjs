// mianshi-agent 桌面小组件
// 功能：
//   1. 本地面板 http://127.0.0.1:8799 —— 展示今日新趋势、学习任务、秋招情报
//   2. 系统通知 —— 爬取到新趋势/新产出时弹通知
//   3. 学习提醒 —— 每天固定时间提醒做面经/笔试学习
// 用法: node widget.mjs [--no-notify]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import notifier from "node-notifier";
import { config } from "./config.mjs";
import * as studyApi from "./lib/study.mjs";
import { chatWithAgent } from "./lib/agent.mjs";
import { startInterview, submitAnswer, endInterview } from "./lib/interview.mjs";
import * as reviewApi from "./lib/review.mjs";

const PORT = 8899;
const NO_NOTIFY = process.argv.includes("--no-notify");

// ============ 数据读取 ============

function latestOutputs(limit = 12) {
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: d.name, mtime: statSync(path.join(outDir, d.name)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function scanNewestFiles(limit = 20) {
  // 扫最新产出目录里的 md 文件，返回标题/公司/路径
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return [];
  const files = [];
  for (const d of readdirSync(outDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(outDir, d.name);
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".md")) continue;
      const fp = path.join(dirPath, f);
      files.push({ file: f, dir: d.name, mtime: statSync(fp).mtime, path: fp });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function parseTitle(file) {
  // 从文件名提取公司/标题：01_公司_标题.md
  const parts = file.replace(/\.md$/, "").split("_").filter(Boolean);
  if (parts.length >= 2) return { company: parts[1], title: parts.slice(2).join("_") || parts[1] };
  return { company: "未分类", title: file };
}

// ============ 学习计划 ============

function getStudyPlan() {
  const files = scanNewestFiles(30);
  const bishi = files.filter((f) => f.dir.includes("discover") || /笔试|bishi/.test(f.file));
  const mianshi = files.filter((f) => !bishi.includes(f));
  const today = new Date().toISOString().slice(0, 10);
  // 简单轮转：每天建议看 2 篇笔试 + 2 篇面经（从最新产出里轮）
  const dayNum = parseInt(today.replace(/-/g, ""), 10);
  const pick = (arr, n) => {
    const out = [];
    for (let i = 0; i < n && i < arr.length; i++) out.push(arr[(dayNum + i) % arr.length]);
    return out;
  };
  return {
    date: today,
    bishi: pick(bishi, 2),
    mianshi: pick(mianshi, 2),
  };
}

// ============ 系统通知 ============

function sendNotification(title, message, { wait = false } = {}) {
  if (NO_NOTIFY) return;
  return new Promise((resolve) => {
    notifier.notify(
      {
        title,
        message,
        sound: true,
        wait,
        appID: "MianshiAgent",
        icon: path.join(config.outputDir, "..", "icon.png"),
      },
      (err) => resolve()
    );
  });
}

// Windows toast 备用（node-notifier 在某些环境 silent）
function toastFallback(title, message) {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($template.CreateTextNode('${title}')) > $null
$textNodes.Item(1).AppendChild($template.CreateTextNode('${message}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('MianshiAgent').Show($toast)`;
  exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, () => {});
}

// ============ 状态跟踪（检测新趋势） ============

const state = { lastScan: null, seenFiles: new Set() };

async function checkTrends() {
  const files = scanNewestFiles(15);
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
    await sendNotification("📌 mianshi-agent 新产出", `新增 ${fresh.length} 篇：${names}\n${fresh[0].dir}`);
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

// ============ 面板 HTML ============

function renderPanel() {
  const outputs = latestOutputs(10);
  const files = scanNewestFiles(15);
  const plan = getStudyPlan();
  const trends = files.slice(0, 8).map((f) => {
    const { company, title } = parseTitle(f.file);
    return `<div class="trend">
      <span class="tag">${company}</span>
      <span class="t">${title.slice(0, 30)}</span>
      <span class="d">${f.dir}</span>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>mianshi-agent</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; font-family: "Microsoft YaHei", sans-serif; }
  body { background: rgba(18,18,24,0.92); color:#e8e8ef; padding:14px; width: 340px; }
  .logo { font-size:16px; font-weight:700; color:#fff; margin-bottom:10px; display:flex; justify-content:space-between; }
  .logo span { color:#7c7c8c; font-size:12px; font-weight:400; }
  .card { background:rgba(255,255,255,0.06); border-radius:10px; padding:10px 12px; margin-bottom:10px; }
  .card h3 { font-size:13px; color:#9d9dff; margin-bottom:6px; }
  .trend { display:flex; align-items:center; gap:8px; font-size:12px; padding:3px 0; }
  .tag { background:#3a3a55; color:#c6c6ff; border-radius:4px; padding:1px 6px; font-size:11px; white-space:nowrap; }
  .t { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .d { color:#6c6c7c; font-size:10px; }
  .plan-item { font-size:12px; padding:3px 0; color:#d8d8e8; }
  .plan-item b { color:#ffd98a; font-weight:600; }
  .empty { color:#6c6c7c; font-size:12px; padding:4px 0; }
  .footer { color:#5c5c6c; font-size:10px; text-align:center; margin-top:4px; }
  .btn { background:#3a3a55; border:none; color:#fff; border-radius:6px; padding:4px 10px; font-size:11px; cursor:pointer; margin-right:6px; }
  .btn:hover { background:#4a4a6a; }
  .actions { display:flex; margin-bottom:8px; }
</style>
</head>
<body>
  <div class="logo">📌 mianshi-agent <span>${new Date().toLocaleString("zh-CN")}</span></div>
  <div class="actions">
    <button class="btn" onclick="fetch('/api/refresh').then(()=>location.reload())">立即刷新</button>
    <button class="btn" onclick="fetch('/api/notify-test')">测试通知</button>
    <button class="btn" onclick="fetch('/api/run-discover').then(()=>location.reload())">开始爬取</button>
  </div>

  <div class="card">
    <h3>📚 今日学习计划（${plan.date}）</h3>
    ${plan.bishi.length || plan.mianshi.length ? "" : '<div class="empty">还没有产出，先跑一次爬取吧</div>'}
    ${plan.bishi.map((f) => `<div class="plan-item">✏️ <b>笔试</b> ${parseTitle(f.file).company} · ${parseTitle(f.file).title.slice(0, 24)}</div>`).join("")}
    ${plan.mianshi.map((f) => `<div class="plan-item">💬 <b>面经</b> ${parseTitle(f.file).company} · ${parseTitle(f.file).title.slice(0, 24)}</div>`).join("")}
  </div>

  <div class="card">
    <h3>🆕 最新产出 / 趋势</h3>
    ${trends || '<div class="empty">暂无产出</div>'}
  </div>

  <div class="card">
    <h3>📂 输出目录</h3>
    ${outputs.map((o) => `<div class="trend"><span class="d">${o.dir}</span><span class="d">${o.mtime.toLocaleString("zh-CN")}</span></div>`).join("")}
  </div>

  <div class="footer">自动刷新中 · 学习提醒 ${STUDY_HOURS.join(":00 / ")}:00 · 通知可用</div>
  <script>
    setInterval(() => { fetch('/api/refresh').then(() => location.reload()); }, 60000);
  </script>
</body>
</html>`;
}

// ============ HTTP 服务 ============

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/api/widget-data") {
    // 看板娘数据：学习计划 + 最新产出 + 趋势 + 爬取进度
    const plan = getStudyPlan();
    const files = scanNewestFiles(12).map((f) => {
      const { company, title } = parseTitle(f.file);
      return { company, title, dir: f.dir, path: f.path, mtime: f.mtime.toISOString() };
    });
    const outputs = latestOutputs(6).map((o) => ({ dir: o.dir, mtime: o.mtime.toISOString() }));
    let progress = { status: "idle", message: "暂无爬取任务" };
    try {
      progress = JSON.parse(readFileSync(path.join(config.outputDir, "..", "progress.json"), "utf8"));
    } catch { /* ignore */ }
    let reviewStats = { total: 0, due: 0 };
    try { reviewStats = reviewApi.review.getStats(); } catch { /* ignore */ }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, plan, files, outputs, progress, review: reviewStats, time: new Date().toISOString() }));
    return;
  }
  if (url.pathname === "/api/chat") {
    // 桌宠对话：用户消息 → agent 工具循环 → 回复
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { message, history } = JSON.parse(body || "{}");
        if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: "message required" })); return; }
        const result = await chatWithAgent(message, history || []);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message, stack: String(e.stack).slice(0, 300) }));
      }
    });
    return;
  }
  if (url.pathname === "/api/study-plan") {
    // 学习清单（读取）——study.mjs 已在顶部导入
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, plan: studyApi.getPlan() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/study-generate") {
    // 从产出生成学习清单
    studyApi
      .generateStudyPlan()
      .then((plan) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, plan }));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }
  if (url.pathname === "/api/study-check") {
    // 勾选完成
    try {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const r = studyApi.checkItem(u.searchParams.get("id"), u.searchParams.get("done") === "1");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/study-review") {
    // 复盘：出验证题
    studyApi
      .startReview()
      .then((r) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }
  if (url.pathname === "/api/study-answer") {
    // 复盘：提交答案判分
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const r = await studyApi.answerReview(JSON.parse(body || "{}").answers || []);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/interview/start") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const r = await startInterview(JSON.parse(body || "{}"));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/interview/answer") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const r = await submitAnswer(JSON.parse(body || "{}").answer || "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/interview/end") {
    endInterview()
      .then((r) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      })
      .catch((e) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }
  if (url.pathname === "/api/review/due") {
    // 今日到期复习卡片
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, due: reviewApi.review.getDailySession(), stats: reviewApi.review.getStats() }));
    return;
  }
  if (url.pathname === "/api/review/submit") {
    // 复习提交评级 0-3
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { id, rating } = JSON.parse(body || "{}");
        const r = reviewApi.review.reviewCard(id, parseInt(rating, 10) || 2);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/refresh") {
    checkTrends().then(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
    return;
  }
  if (url.pathname === "/api/notify-test") {
    sendNotification("✅ 通知测试", "mianshi-agent 小组件通知正常");
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/api/run-discover") {
    // 重置进度并后台启动爬取
    try {
      writeFileSync(path.join(config.outputDir, "..", "progress.json"), JSON.stringify({ status: "running", step: "start", message: "爬取启动中...", current: 0, total: 0 }), "utf8");
    } catch { /* ignore */ }
    exec('start cmd /c "cd /d D:\\mianshi-agent && node discover.mjs > widget-run.log 2>&1"', { windowsHide: true });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, msg: "后台已触发" }));
    return;
  }
  if (url.pathname === "/api/progress") {
    // 桌宠轮询爬取进度
    try {
      const p = JSON.parse(readFileSync(path.join(config.outputDir, "..", "progress.json"), "utf8"));
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(p));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "idle", message: "暂无爬取任务" }));
    }
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPanel());
    return;
  }
  res.writeHead(404); res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ 桌面小组件已启动: http://127.0.0.1:${PORT}`);
  console.log(`   学习提醒: 每天 ${STUDY_HOURS.join(":00 / ")}:00 弹通知`);
  console.log(`   趋势检测: 每 5 分钟扫描 output 目录，发现新产出弹通知`);
  console.log(`   Ctrl+C 停止`);
});

// ============ 主动推送：按关注点定时巡检新内容 ============
import { memory } from "./lib/memory.mjs";

// 巡检间隔：30 分钟一次（避免频繁请求）
const PATROL_INTERVAL = 30 * 60 * 1000;

async function patrolInterests() {
  const interests = memory.getInterests();
  if (!interests.length) return;
  try {
    const { chatWithAgent } = { chatWithAgent: null }; // 避免循环依赖，直接调 search
    const { fetchPage } = await import("./lib/fetch-page.mjs");
    const re = /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+)/;
    const newPosts = [];
    // 取前 2 个关注点，各搜一个站
    for (const topic of interests.slice(0, 2)) {
      const url = `https://www.nowcoder.com/discuss?type=2&query=${encodeURIComponent(topic)}`;
      try {
        const page = await fetchPage(url, { maxTextChars: 1500, collectLinks: true });
        for (const l of page.links) {
          if (re.test(l.href) && l.text.length > 8) {
            const clean = l.href.replace(/[?&]searchId=[^&]*/g, "").split("?")[0];
            if (!memory.isSeen(clean)) {
              newPosts.push({ title: l.text.slice(0, 50), url: clean, topic });
            }
          }
        }
      } catch { /* ignore */ }
    }
    if (newPosts.length) {
      const names = newPosts.slice(0, 3).map((p) => p.title.slice(0, 20)).join("、");
      console.log(`[widget] 巡检发现 ${newPosts.length} 条新内容（关注点 ${interests.slice(0, 2).join("、")}）`);
      await sendNotification("🆕 真白发现新面经", `${names}${newPosts.length > 3 ? ` 等 ${newPosts.length} 条` : ""}\n在桌宠对话里说"看看"即可查看`);
    }
  } catch { /* ignore */ }
}

// 启动巡检（首次 5 分钟后，之后每 30 分钟）
setTimeout(() => patrolInterests(), 5 * 60 * 1000);
setInterval(patrolInterests, PATROL_INTERVAL);

// ============ 周期任务 ============

// 初始扫描（不通知）
setTimeout(checkTrends, 3000);
// 每 5 分钟检测新趋势
setInterval(checkTrends, 5 * 60 * 1000);
// 每分钟检查学习提醒
setInterval(checkStudyReminder, 60 * 1000);
