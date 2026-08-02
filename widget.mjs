// mianshi-agent 桌面小组件
// 功能：
//   1. 本地面板 http://127.0.0.1:8799 —— 展示今日新趋势、学习任务、秋招情报
//   2. 系统通知 —— 爬取到新趋势/新产出时弹通知
//   3. 学习提醒 —— 每天固定时间提醒做面经/笔试学习
// 用法: node widget.mjs [--no-notify]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import notifier from "node-notifier";
import { config } from "./config.mjs";
import * as studyApi from "./lib/study.mjs";
import { chatWithAgent } from "./lib/agent.mjs";
import { startInterview, submitAnswer, endInterview } from "./lib/interview.mjs";
import * as reviewApi from "./lib/review.mjs";
import { pick as pickEmotion, EMOTIONS } from "./lib/emotions.mjs";

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
  // 排除 00_ 开头的索引/README + study_notes（学习讲解存档，不算产出）——chat_solutions（对话解答）保留展示
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return [];
  const files = [];
  const SKIP_DIRS = new Set(["study_notes"]);
  for (const d of readdirSync(outDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (SKIP_DIRS.has(d.name)) continue; // 学习讲解存档不展示
    const dirPath = path.join(outDir, d.name);
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".md")) continue;
      if (/^00[_-]/.test(f)) continue; // 索引文件跳过
      const fp = path.join(dirPath, f);
      files.push({ file: f, dir: d.name, mtime: statSync(fp).mtime, path: fp });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// 文件名规范化：忽略空格/下划线/括号差异，用于模糊匹配
const normName = (s) => String(s || "").toLowerCase().replace(/[\s_\-（）()【】\[\]．.]/g, "");

// 学习讲解文件专用目录（AI 生成的讲解存档）
const STUDY_NOTES_DIR = () => path.join(config.outputDir, "study_notes");

// 查找学习条目的讲解文件：
// 1. study_notes/ 下按 topic 精确匹配（最优先——AI 生成的讲解存档）
// 2. 产出目录里按 source 文件名模糊匹配
function findStudyFile(item) {
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return null;
  // 1. study_notes 按 topic 匹配
  const notesDir = STUDY_NOTES_DIR();
  if (existsSync(notesDir)) {
    const topicNorm = normName(item.topic);
    for (const f of readdirSync(notesDir)) {
      if (!f.endsWith(".md")) continue;
      if (normName(f.replace(/\.md$/, "")) === topicNorm) {
        return path.join(notesDir, f);
      }
    }
  }
  // 2. 产出目录按 source 模糊匹配
  const src = (item.source || "").replace(/\.md$/, "");
  const sn = normName(src);
  for (const d of readdirSync(outDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "study_notes") continue;
    const dirPath = path.join(outDir, d.name);
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".md") || /^00[_-]/.test(f)) continue;
      const key = normName(f.replace(/\.md$/, ""));
      if (key === sn || key.includes(sn) || sn.includes(key)) return path.join(dirPath, f);
    }
  }
  return null;
}

// 知识点名 → 安全文件名（去掉 Windows 非法字符）
function sanitizeFilename(name) {
  return String(name || "note")
    .replace(/[\\/:*?"<>|\r\n]/g, "")
    .trim()
    .slice(0, 60) || "note";
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

// ============ HTTP 服务 ============

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // CORS：允许面板渲染层（file:// 页面）直接 fetch 流式接口
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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
    // 学习清单（读取）——study.mjs 已在顶部导入；为每条附加讲解文件路径
    try {
      const plan = studyApi.getPlan();
      const items = (plan.items || []).map((it) => {
        const filePath = findStudyFile(it);
        return { ...it, filePath, hasFile: !!filePath };
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, plan: { ...plan, items } }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/study-detail-stream") {
    // 学习详情（流式）：SSE 逐段推送讲解；有文件直接返回；无文件边生成边推 + 存档
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const plan = studyApi.getPlan();
    const item = (plan.items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    const filePath = findStudyFile(item);
    if (filePath) {
      // 有文件：一次性返回（快，无需流式）
      try {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: true, content: content.slice(0, 12000), filePath }));
        return;
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "读取讲解失败: " + e.message }));
        return;
      }
    }
    // 无文件：SSE 流式生成
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: "start", topic: item.topic });
    let full = "";
    import("./lib/ai.mjs").then(async ({ solveQuestionStream }) => {
      full = await solveQuestionStream({
        title: item.verify_question || `请完整讲解：${item.topic}`,
        text: `这是一道前端面试题，请完整讲解：${item.topic}\n（若题干信息不足，围绕知识点本身展开：核心概念、原理、代码示例、边界情况）`,
        company: "真白讲解",
        sourceUrl: "学习清单",
      }, (delta) => {
        full += delta;
        send({ type: "delta", delta });
      });
      // 存档
      let savedPath = null;
      try {
        const notesDir = STUDY_NOTES_DIR();
        mkdirSync(notesDir, { recursive: true });
        const savePath = path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档 | 生成于 ${new Date().toLocaleString("zh-CN")}\n\n`;
        writeFileSync(savePath, header + full.slice(0, 12000), "utf8");
        savedPath = savePath;
      } catch { /* ignore */ }
      send({ type: "done", saved: !!savedPath, filePath: savedPath });
      res.end();
    }).catch((e) => {
      send({ type: "error", error: e.message });
      res.end();
    });
    return;
  }
  if (url.pathname === "/api/study-detail") {
    // 学习详情：返回条目讲解内容（有文件读文件；无文件现场生成并写入 study_notes 存档）
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const plan = studyApi.getPlan();
    const item = (plan.items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    const filePath = findStudyFile(item);
    if (filePath) {
      try {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: true, content: content.slice(0, 12000), filePath }));
        return;
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "读取讲解失败: " + e.message }));
        return;
      }
    }
    // 无文件：现场生成讲解（前端格式：结论/原理/实现/边界），并写入 study_notes 存档
    import("./lib/ai.mjs").then(async ({ solveQuestion }) => {
      const content = String(await solveQuestion({
        title: item.verify_question || `请完整讲解：${item.topic}`,
        text: `这是一道前端面试题，请完整讲解：${item.topic}\n（若题干信息不足，围绕知识点本身展开：核心概念、原理、代码示例、边界情况）`,
        company: "真白讲解",
        sourceUrl: "学习清单",
      })).slice(0, 12000);
      // 写入存档（下次直接读文件，不再生成）
      let savedPath = null;
      try {
        const notesDir = STUDY_NOTES_DIR();
        mkdirSync(notesDir, { recursive: true });
        const savePath = path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档 | 生成于 ${new Date().toLocaleString("zh-CN")}\n\n`;
        writeFileSync(savePath, header + content, "utf8");
        savedPath = savePath;
      } catch (e) { /* 存档失败不影响返回 */ }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: false, content, filePath: savedPath, saved: !!savedPath }));
    }).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "生成讲解失败: " + e.message }));
    });
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
    // 勾选完成 → 返回真白情感反馈（庆祝/取消）
    try {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const done = u.searchParams.get("done") === "1";
      const r = studyApi.checkItem(u.searchParams.get("id"), done);
      let emotion = null;
      try {
        emotion = done ? pickEmotion(EMOTIONS.celebrate) : "……嗯，那先放着。";
      } catch { /* ignore */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...r, emotion }));
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
  if (url.pathname === "/api/interview/history") {
    // 面试历史（复盘报告）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, history: memory.getInterviewHistory() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/stats") {
    // 使用统计（对话/复习/面试/答题）
    try {
      const m = memory.get();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stats: m.stats || {} }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/review/due") {
    // 今日到期复习卡片
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, due: reviewApi.review.getDailySession(), stats: reviewApi.review.getStats() }));
    return;
  }
  if (url.pathname === "/api/review/add") {
    // 添加复习卡（学习清单/薄弱点回流用）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
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
    // 最小状态页（健康检查/浏览器访问）：真实 UI 在 Electron 面板
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>mianshi-agent 服务</title></head>
<body style="font-family:sans-serif;background:#121218;color:#e8e8ef;padding:20px">
<h3>📌 mianshi-agent 数据服务运行中</h3>
<p>完整面板在桌宠（双击真白打开）。此页面仅供健康检查。</p>
<p>状态: <span style="color:#5fd85f">OK</span> · ${new Date().toLocaleString("zh-CN")}</p>
</body></html>`);
    return;
  }
  res.writeHead(404); res.end("Not Found");
});

// 启动自检：key 缺失/格式异常时明确报错退出（避免静默运行全部 LLM 调用失败）
try {
  const { assertConfig } = await import("./config.mjs");
  assertConfig();
} catch (e) { /* config.mjs 无此导出时忽略 */ }

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
    // 标题级方向过滤：嵌入式/硬件/算法/后端/C++ 等非前端方向直接排除（避免通知混入无关内容）
    const EXCLUDE_TITLE = /嵌入式|单片机|硬件|驱动|PCB|STM32|ESP32|ARM|C\+\+|Java|Go语言|后端|算法岗|机器学习|深度学习|大数据|测试开发|测开|运维|产品|运营|数据分析|爬虫开发|上位机|物联网|芯片|FPGA/;
    const newPosts = [];
    // 取前 2 个关注点，各搜一个站
    for (const topic of interests.slice(0, 2)) {
      const url = `https://www.nowcoder.com/discuss?type=2&query=${encodeURIComponent(topic)}`;
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
    if (newPosts.length) {
      const names = newPosts.slice(0, 3).map((p) => p.title.slice(0, 20)).join("、");
      console.log(`[widget] 巡检发现 ${newPosts.length} 条新内容（关注点 ${interests.slice(0, 2).join("、")}）`);
      // 真正处理：抓正文 → 分类过滤 → 讲解 → 存档（通知不再"空口说白话"）
      const saved = await processPatrolPosts(newPosts.slice(0, 2));
      await sendNotification(
        "🆕 真白发现新面经",
        `${names}${newPosts.length > 3 ? ` 等 ${newPosts.length} 条` : ""}\n${saved.length ? `已生成讲解：\n${saved.map((s) => `  📄 ${s}`).join("\n")}\n在面板「🔍 爬取产出」查看` : "都是旧内容，未生成新讲解"}`
      );
    }
  } catch { /* ignore */ }
}

// 巡检帖 → 抓正文 → 分类/方向过滤 → 具体题目检测 → 完整讲解 → 存档
// 返回存档文件名列表（[] = 无有效内容）
async function processPatrolPosts(posts) {
  const saved = [];
  try {
    const { fetchPage } = await import("./lib/fetch-page.mjs");
    const { classifyPage, detectQuestions, solveQuestion } = await import("./lib/ai.mjs");
    const GOOD_DIRS = ["frontend", "agent"];
    for (const p of posts) {
      try {
        // 标记已看（避免下次重复通知）
        memory.markSeen(p.url);
        const page = await fetchPage(p.url, { maxTextChars: 6000 });
        if (!page.ok || page.invalid || !page.text || page.text.length < 200) continue;
        // 方向过滤：只留前端/Agent
        const cls = await classifyPage({ title: page.title, text: page.text });
        if (!GOOD_DIRS.includes(cls.direction) || cls.worth < 40) continue;
        // 具体题目检测：攻略文跳过
        const dq = await detectQuestions({ title: page.title, text: page.text });
        if (!dq.hasQuestion || !dq.questions?.length) continue;
        // 完整讲解
        const md = await solveQuestion({
          title: page.title,
          text: dq.questions.slice(0, 3).map((q, i) => `【题${i + 1}】${q.question}`).join("\n"),
          company: cls.company,
          position: cls.position,
          sourceUrl: p.url,
        });
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
      }
    }
  } catch (e) {
    console.log(`[widget] processPatrolPosts 异常: ${e.message}`);
  }
  return saved;
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
