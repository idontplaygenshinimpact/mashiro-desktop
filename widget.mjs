// mianshi-agent 桌面小组件
// 功能：
//   1. 本地面板 http://127.0.0.1:8799 —— 展示今日新趋势、学习任务、秋招情报
//   2. 系统通知 —— 爬取到新趋势/新产出时弹通知
//   3. 学习提醒 —— 每天固定时间提醒做面经/笔试学习
// 用法: node widget.mjs [--no-notify]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import notifier from "node-notifier";
import { config } from "./config.mjs";
import * as studyApi from "./lib/study.mjs";
import { chatWithAgent } from "./lib/agent.mjs";
import { startInterview, submitAnswer, endInterview } from "./lib/interview.mjs";
import * as reviewApi from "./lib/review.mjs";
import { pick as pickEmotion, EMOTIONS } from "./lib/emotions.mjs";
import { getLLMStats, getRecentTools } from "./lib/trace.mjs";
import { getPendingApprovals, resolveApproval, getSessionApproved } from "./lib/permission.mjs";
import { submit as laneSubmit } from "./lib/lane.mjs";
import * as jobsApi from "./lib/jobs.mjs";
import * as learningApi from "./lib/learning.mjs";
import * as ragApi from "./lib/rag.mjs";
import * as zhentiApi from "./lib/zhenti.mjs";

const PORT = Number(process.env.MIANSHI_PORT) || 8899;
const NO_NOTIFY = process.argv.includes("--no-notify");
// 测试隔离：集成测试起实例时禁用巡检定时器（生产不设置则正常巡检）
const DISABLE_PATROL = process.env.MIANSHI_DISABLE_PATROL === "1";

// ============ 数据读取 ============

function latestOutputs(limit = 12) {
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: d.name, mtime: statSync(path.join(outDir, d.name)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
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
const normName = (s) => String(s || "").toLowerCase().replace(/[\s_\-（）()【】[].]/g, "");

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
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    notifier.notify(
      {
        title,
        message,
        sound: true,
        wait,
        appID: "MianshiAgent",
        icon: path.join(config.outputDir, "..", "icon.png"),
      },
      (err) => resolve(undefined)
    );
  }));
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

// ============ 复习到期提醒（有到期卡主动提示，每天一次） ============
const reviewReminded = new Set(); // 已提醒日期

async function checkReviewReminder() {
  const todayKey = new Date().toISOString().slice(0, 10);
  if (reviewReminded.has(todayKey)) return; // 今天已提醒过
  try {
    const due = reviewApi.review.getDueCards();
    if (due.length === 0) return;
    // 首次提醒时间：卡片到期当天 9 点后（避免半夜打扰）；之后每小时检查
    const h = new Date().getHours();
    if (h < 9) return;
    reviewReminded.add(todayKey);
    const topics = due.slice(0, 3).map((c) => String(c.topic).slice(0, 18)).join("、");
    console.log(`[widget] 复习到期提醒：${due.length} 张`);
    await sendNotification(
      "🔁 复习时间到",
      `有 ${due.length} 张复习卡片到期${due.length > 3 ? `（${topics} 等）` : `：${topics}`}\n在面板「🔁 复习」Tab 完成，答对会自动拉长下次间隔`
    );
  } catch { /* ignore */ }
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
    // 桌宠对话：用户消息 → agent 工具循环 → 回复（走串行 lane，防并发竞争 memory 镜像）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { message, history } = JSON.parse(body || "{}");
        if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: "message required" })); return; }
        const result = await laneSubmit(() => chatWithAgent(message, history || []));
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
      // 有文件：一次性返回（快，无需流式）——不截断，讲解可无限追问累积
      try {
        const content = readFileSync(filePath, "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: true, content, filePath }));
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
        position: "前端",
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
        writeFileSync(savePath, header + full.slice(0, 50000), "utf8");
        savedPath = savePath;
      } catch { /* ignore */ }
      // 讲解生成完成 → 自动建复习卡（学过的知识点进间隔复习，不必等勾选）
      try {
        reviewApi.review.addCard({
          topic: item.topic,
          question: item.verify_question || `请简述：${item.topic}`,
          answer: full.slice(0, 500),
          source: "学习清单讲解",
        });
      } catch { /* ignore */ }
      send({ type: "done", saved: !!savedPath, filePath: savedPath });
      res.end();
    }).catch((e) => {
      send({ type: "error", error: e.message });
      res.end();
    });
    return;
  }
  if (url.pathname === "/api/study-append-stream") {
    // 讲解追问补充：基于已有讲解内容 + 用户问题，流式生成补充章节并追加存档
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const question = u.searchParams.get("question") || "";
    if (!question.trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "question required" })); return; }
    const plan = studyApi.getPlan();
    const item = (plan.items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    // 读已有讲解（study_notes 存档优先；没有则用验证题作为上下文）
    let existing = "";
    const filePath = findStudyFile(item);
    if (filePath) {
      try { existing = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: "start", topic: item.topic });
    let full = "";
    import("./lib/ai.mjs").then(async ({ solveAppendStream }) => {
      full = await solveAppendStream({
        topic: item.topic,
        existing: existing || `（暂无已有讲解，围绕知识点直接回答）${item.verify_question || item.topic}`,
        question,
      }, (delta) => {
        full += delta;
        send({ type: "delta", delta });
      });
      // 追加写回讲解文件（持久化：下次打开能看到补充内容）
      try {
        const notesDir = STUDY_NOTES_DIR();
        mkdirSync(notesDir, { recursive: true });
        const savePath = filePath || path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        const appendBlock = `\n\n---\n\n## 💬 追问：${question}\n\n${full.slice(0, 8000)}\n`;
        // 追加（文件存在则 append，否则新建带头部）
        if (filePath) {
          appendFileSync(savePath, appendBlock, "utf8");
        } else {
          const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档 | 生成于 ${new Date().toLocaleString("zh-CN")}\n\n`;
          writeFileSync(savePath, header + full.slice(0, 12000) + appendBlock, "utf8");
        }
        send({ type: "done", saved: true, filePath: savePath });
      } catch (e) {
        send({ type: "done", saved: false, filePath: null });
      }
      res.end();
    }).catch((e) => {
      send({ type: "error", error: e.message });
      res.end();
    });
    return;
  }
  if (url.pathname === "/api/study-consolidate-stream") {
    // 整理讲解全文：把原始讲解 + 多轮追问整合成结构统一的完整讲解，流式生成并写回
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const id = u.searchParams.get("id") || "";
    const plan = studyApi.getPlan();
    const item = (plan.items || []).find((i) => i.id === id);
    if (!item) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "条目不存在" })); return; }
    // 读完整讲解素材
    let content = "";
    const filePath = findStudyFile(item);
    if (filePath) {
      try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ }
    }
    if (!content || content.length < 200) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "还没有讲解内容，先点「💡 讲解」生成" })); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: "start", topic: item.topic });
    let full = "";
    import("./lib/ai.mjs").then(async ({ consolidateStudyStream }) => {
      full = await consolidateStudyStream({ topic: item.topic, content }, (delta) => {
        full += delta;
        send({ type: "delta", delta });
      });
      // 写回：原文件改名 .orig 备份，写整合版
      let savedPath = null;
      try {
        const notesDir = STUDY_NOTES_DIR();
        mkdirSync(notesDir, { recursive: true });
        const savePath = filePath || path.join(notesDir, `${sanitizeFilename(item.topic)}.md`);
        if (filePath) {
          try { writeFileSync(savePath + ".orig", readFileSync(savePath, "utf8"), "utf8"); } catch { /* ignore */ }
        }
        const header = `# ${item.topic}\n\n> 来源：学习清单 · AI 讲解存档（已整理） | 整理于 ${new Date().toLocaleString("zh-CN")}\n\n`;
        writeFileSync(savePath, header + full.slice(0, 50000), "utf8");
        savedPath = savePath;
      } catch (e) { /* ignore */ }
      send({ type: "done", saved: !!savedPath, filePath: savedPath });
      res.end();
    }).catch((e) => {
      send({ type: "error", error: e.message });
      res.end();
    });
    return;
  }
  if (url.pathname === "/api/study-cluster-stream") {
    // 多条目知识归并：把多个相关条目的讲解整合成主题簇综合讲解，流式生成并存到 study_notes/<簇>/ 目录
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { ids } = JSON.parse(body || "{}");
        if (!Array.isArray(ids) || ids.length < 2) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "请至少选择 2 个相关条目归并" })); return; }
        const plan = studyApi.getPlan();
        // 读取每个条目的讲解内容（有文件的读文件；无文件的跳过并提示先生成）
        const topics = [];
        const missing = [];
        for (const id of ids) {
          const item = (plan.items || []).find((i) => i.id === id);
          if (!item) continue;
          const filePath = findStudyFile(item);
          let content = "";
          if (filePath) { try { content = readFileSync(filePath, "utf8"); } catch { /* ignore */ } }
          if (content.length < 200) { missing.push(item.topic); continue; }
          topics.push({ topic: item.topic, content });
        }
        if (topics.length < 2) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `需要至少 2 个有讲解的条目（${missing.length ? "缺讲解：" + missing.join("、") : ""}）。先点「💡 讲解」生成` }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        send({ type: "start", topic: topics.map((t) => t.topic).join(" + ") });
        let full = "";
        import("./lib/ai.mjs").then(async ({ clusterStudyStream }) => {
          full = await clusterStudyStream({
            topics,
            onChunk: (delta) => {
              full += delta;
              send({ type: "delta", delta });
            },
          });
          // 存到 study_notes/主题簇/ 目录（按 AI 给的主题簇名）
          let savedPath = null;
          let clusterName = "综合";
          try {
            const cm = full.match(/【cluster】\s*([^\n]+)/);
            if (cm) clusterName = cm[1].trim().slice(0, 40);
            const notesDir = STUDY_NOTES_DIR();
            const clusterDir = path.join(notesDir, sanitizeFilename(clusterName));
            mkdirSync(clusterDir, { recursive: true });
            const savePath2 = path.join(clusterDir, `${sanitizeFilename(clusterName)}.md`);
            const header = `# ${clusterName}\n\n> 来源：多条目归并（${topics.map((t) => t.topic).join("、")}） | 归并于 ${new Date().toLocaleString("zh-CN")}\n\n`;
            writeFileSync(savePath2, header + full.replace(/【cluster】\s*/, "").slice(0, 50000), "utf8");
            savedPath = savePath2;
          } catch (e) { /* ignore */ }
          send({ type: "done", saved: !!savedPath, filePath: savedPath, clusterName });
          res.end();
        }).catch((e) => {
          send({ type: "error", error: e.message });
          res.end();
        });
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
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
        res.end(JSON.stringify({ ok: true, topic: item.topic, fromFile: true, content, filePath }));
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
        position: "前端",
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
      // 讲解生成完成 → 自动建复习卡
      try {
        reviewApi.review.addCard({
          topic: item.topic,
          question: item.verify_question || `请简述：${item.topic}`,
          answer: content.slice(0, 500),
          source: "学习清单讲解",
        });
      } catch { /* ignore */ }
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
    laneSubmit(() => studyApi.generateStudyPlan())
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
        const r = await laneSubmit(() => startInterview(JSON.parse(body || "{}")));
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
        const r = await laneSubmit(() => submitAnswer(JSON.parse(body || "{}").answer || ""));
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
    laneSubmit(() => endInterview())
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
  if (url.pathname === "/api/observability") {
    // 可观测性：LLM 调用统计 + 最近调用 + 工具链
    try {
      const llm = getLLMStats();
      const tools = getRecentTools(8);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, llm, tools }));
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
  if (url.pathname === "/api/jobs/profile" && req.method === "GET") {
    // 查询简历状态（画像 + 原文是否已保存）
    try {
      const profile = jobsApi.getResumeProfile();
      const raw = jobsApi.getResumeRaw();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        profile,
        rawSaved: !!raw,
        rawText: raw?.text || "",
        rawLength: raw?.text?.length || 0,
        rawUpdatedAt: raw?.updatedAt || 0,
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/jobs/profile") {
    // 简历技能画像（驱动岗位匹配；原文一并保存供后续复用）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { resume } = JSON.parse(body || "{}");
        if (!resume || !String(resume).trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "resume required" })); return; }
        const r = await jobsApi.setResumeProfile(resume);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/jobs/direction") {
    // 设置意向方向 + 返回调整建议
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { direction } = JSON.parse(body || "{}");
        const set = jobsApi.setTargetDirection(direction);
        if (!set.ok) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify(set)); return; }
        const advice = await jobsApi.generateDirectionAdvice();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...advice }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/jobs") {
    // 校招岗位列表（可过滤 status/direction）
    try {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const jobs = jobsApi.getJobs({ status: u.searchParams.get("status") || undefined, direction: u.searchParams.get("direction") || undefined });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, jobs }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/jobs/recommended") {
    // 推荐岗位（匹配度排序）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, recommended: jobsApi.getRecommendedJobs(), stats: jobsApi.getJobStats() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/jobs/status") {
    // 更新投递状态
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { id, status } = JSON.parse(body || "{}");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(jobsApi.setJobStatus(id, status)));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/jobs/daily-collect") {
    // 每日自动搜集（POST 手动触发一次；GET 查询状态）
    if (req.method === "GET") {
      try {
        const last = jobsApi.getJobsLastCollect();
        const due = !last || Date.now() - last >= 24 * 3600 * 1000;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, lastCollect: last || 0, due, nextIn: last ? Math.max(0, 24 * 3600 * 1000 - (Date.now() - last)) : 0 }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const r = await jobsApi.collectJobsDaily();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r.skipped ? { ok: true, skipped: true, message: "距上次搜集不足 24h，跳过（可等定时器或清空时间戳强制）" } : { ok: true, ...r, message: `新增 ${r.totalNew} 条岗位` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/jobs/collect") {
    // 搜集校招岗位：官网优先 → 公司名单 → 中厂兜底（POST 触发；可传 step）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { step } = JSON.parse(body || "{}");
        const result = {};
        if (!step || step === "official") result.official = await jobsApi.collectFromOfficialSites();
        if (!step || step === "companies") result.companies = await jobsApi.collectCompanyList();
        if (!step || step === "fallback") result.fallback = await jobsApi.collectJobsForCompaniesWithoutSite();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/companies") {
    // 公司档案列表
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, companies: jobsApi.getCompanies() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/knowledge/ask") {
    // RAG 问答：检索 → 注入 → LLM 生成（POST { query }）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
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
    return;
  }
  if (url.pathname === "/api/knowledge/search") {
    // 本地知识库混合检索（POST { query, topK }）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { query, topK } = JSON.parse(body || "{}");
        const hits = await ragApi.searchKnowledge(query, Math.min(topK || 5, 10));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, hits }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/knowledge/stats") {
    // 知识库统计（GET）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...ragApi.getKnowledgeStats() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/knowledge/rebuild") {
    // 重建知识库（POST；全量采集 + embedding，约 15-60s）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const r = await ragApi.rebuildKnowledgeBase();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, message: `知识库重建完成：${r.items} 条，耗时 ${r.seconds}s` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/zhenti") {
    // 牛客大厂官方真题清单（GET；?company= 过滤）
    try {
      const { searchParams } = new URL(req.url, "http://x");
      const list = zhentiApi.getZhentiList({ company: searchParams.get("company") || "" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, papers: list, ...zhentiApi.getZhentiStats() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/zhenti/collect") {
    // 搜集真题清单（POST；可传 { details: 20 } 顺带抓题型详情；{ company: "拼多多" } 按公司搜索搜集）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { details, company } = JSON.parse(body || "{}");
        const r = company
          ? await zhentiApi.collectZhentiByCompany(company)
          : await zhentiApi.collectZhentiList();
        const detailsResult = details ? await zhentiApi.collectZhentiDetails(details) : null;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, details: detailsResult, message: `${company ? `「${company}」真题搜集完成` : "真题搜集完成"}：新增 ${r.added} 条` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/zhenti/cookie") {
    // 保存牛客 Cookie（POST { cookie }，本地落盘）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { cookie } = JSON.parse(body || "{}");
        const r = zhentiApi.saveNowcoderCookie(cookie);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/zhenti/questions") {
    // 登录态抓取试卷完整题目（POST { paperTestId }）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { paperTestId } = JSON.parse(body || "{}");
        if (!paperTestId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "paperTestId required" })); return; }
        const r = await zhentiApi.fetchPaperQuestions(paperTestId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/zhenti/wrong") {
    // 错题回流：学习清单 + FSRS 复习卡（POST { paperId, company, paperTitle, question, answer }）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { paperId, company, paperTitle, question, answer } = JSON.parse(body || "{}");
        if (!question || !String(question).trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "question required" })); return; }
        const r = await zhentiApi.addWrongQuestion({ paperId, company, paperTitle, question, answer });
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/zhenti/plan") {
    // 整套真题加入学习清单（POST { paperTestId }）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { paperTestId } = JSON.parse(body || "{}");
        if (!paperTestId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "paperTestId required" })); return; }
        const r = await zhentiApi.addPaperToPlan(paperTestId);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/learning") {
    // 官方学习文档清单（前端/AI/Agent 三类，含最近检测结果）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...learningApi.getLearningDocs() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/learning/check") {
    // 检查各文档最新版本（POST；可传 { only: [名称...] } 只检查指定项）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
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
    return;
  }
  if (url.pathname === "/api/resume-plan") {
    // 简历项目 → 学习清单（简历拷打准备）：提取项目 → 每个项目作为"必会"清单条目
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { resume } = JSON.parse(body || "{}");
        if (!resume || !String(resume).trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "resume required" })); return; }
        const { extractResumeProjects } = await import("./lib/ai.mjs");
        const projects = await extractResumeProjects(resume);
        if (!projects.length) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, added: 0, projects: [], message: "未从简历中识别到项目" })); return; }
        const r = studyApi.addPlanItems(projects.map((p) => ({
          topic: `项目·${p.name}`,
          why: `简历项目拷打准备${p.techStack ? `（${p.techStack}）` : ""}：${p.description}`,
          source: "简历拷打",
          verify_question: `用 30 秒电梯陈述讲清「${p.name}」，然后准备被深挖：技术选型 trade-off / 架构 / 个人贡献 / 难点踩坑 / 量化指标`,
          level: "必会",
        })));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, added: r.added, projects, message: `已将 ${r.added} 个简历项目加入学习清单` }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/approval-pending") {
    // 权限审批：查询当前待审批的工具调用（面板轮询）
    try {
      const pendingList = getPendingApprovals();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, pending: pendingList, sessionApproved: getSessionApproved() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === "/api/approval") {
    // 权限审批：用户决策（allow/session）
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { toolName, allow, session } = JSON.parse(body || "{}");
        if (!toolName) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "toolName required" })); return; }
        const r = resolveApproval(toolName, { allow: !!allow, session: !!session });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: r.ok, ...r }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/interview-notes") {
    // 面试实录：把真实面试被问住的知识点加入学习清单（必会）+ 建复习卡
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
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

// 巡检间隔：60 分钟一次（无新帖时触发全量爬取，2 小时限频，不宜太频繁）
const PATROL_INTERVAL = 60 * 60 * 1000;

async function patrolInterests() {
  const interests = memory.getInterests();
  if (!interests.length) return;
  try {
    const { chatWithAgent } = { chatWithAgent: null }; // 避免循环依赖，直接调 search
    const { fetchPage } = await import("./lib/fetch-page.mjs");
    const re = /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+)/;
    // 标题级方向过滤：嵌入式/硬件/算法/后端 + 简历/求职咨询/闲聊类（避免通知混入无关内容）
    const EXCLUDE_TITLE = /嵌入式|单片机|硬件|驱动|PCB|STM32|ESP32|ARM|芯片|FPGA|物联网|上位机|爬虫开发/;
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
      const result = await processPatrolPosts(newPosts.slice(0, 4));
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
        console.log("[widget] 巡检无新帖，触发全量爬取");
        try {
          const { exec } = await import("node:child_process");
          exec('start cmd /c "cd /d D:\\mianshi-agent && node discover.mjs > widget-run.log 2>&1"', { windowsHide: true });
        } catch { /* ignore */ }
      } else {
        console.log("[widget] 巡检无新帖，全量爬取冷却中（2 小时限频）");
      }
    }
  } catch { /* ignore */ }
}
let lastFullCrawl = null; // 全量爬取限频标记

// 巡检帖 → 抓正文 → 分类/方向过滤 → 具体题目检测 → 完整讲解 → 存档
// 返回 { saved: [文件名], skipped: { 原因: 篇数 } }
async function processPatrolPosts(posts) {
  const saved = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  try {
    const { fetchPage } = await import("./lib/fetch-page.mjs");
    const { classifyPage, detectQuestions, solveQuestion } = await import("./lib/ai.mjs");
    const GOOD_DIRS = ["frontend", "agent"];
    for (const p of posts) {
      try {
        // 标记已看（避免下次重复通知）
        memory.markSeen(p.url);
        const page = await fetchPage(p.url, { maxTextChars: 6000 });
        if (!page.ok || page.invalid || !page.text || page.text.length < 200) { skip("页面无效/404"); continue; }
        // 方向过滤：只留前端/Agent
        const cls = await classifyPage({ title: page.title, text: page.text });
        if (!GOOD_DIRS.includes(cls.direction)) { skip("非前端/Agent方向"); continue; }
        if (cls.worth < 40) { skip("内容价值低"); continue; }
        // 具体题目检测：攻略文跳过
        const dq = await detectQuestions({ title: page.title, text: page.text });
        if (!dq.hasQuestion || !dq.questions?.length) { skip("攻略文/无具体题"); continue; }
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
        skip("讲解失败");
      }
    }
  } catch (e) {
    console.log(`[widget] processPatrolPosts 异常: ${e.message}`);
  }
  return { saved, skipped };
}

// 启动巡检（首次 5 分钟后，之后每 PATROL_INTERVAL；测试设 MIANSHI_DISABLE_PATROL=1 可关）
if (!DISABLE_PATROL) {
  setTimeout(() => patrolInterests(), 5 * 60 * 1000);
  setInterval(patrolInterests, PATROL_INTERVAL);
}

// ============ 后台任务管理（门控 + 互斥 + 优雅关闭） ============
// 测试/无后台场景：MIANSHI_DISABLE_BACKGROUND=1 关闭所有后台定时任务（RAG 构建/每日搜集）
const DISABLE_BACKGROUND = process.env.MIANSHI_DISABLE_BACKGROUND === "1";
const timers = [];
const registerTimer = (fn, ms, ...args) => { timers.push(setTimeout(fn, ms, ...args)); };
const registerInterval = (fn, ms, ...args) => { timers.push(setInterval(fn, ms, ...args)); };

// 本地知识库：启动后若为空则后台构建（首次 ~15-60s；增量可手动点面板重建）；互斥防重叠
let ragBuilding = false;
const ragBuildTick = async () => {
  if (ragBuilding) return;
  ragBuilding = true;
  try {
    const stats = ragApi.getKnowledgeStats();
    if (!stats.total) {
      console.log("[rag] 知识库为空，后台构建中…");
      const r = await ragApi.rebuildKnowledgeBase();
      console.log(`[rag] 知识库构建完成：${r.items} 条（${r.seconds}s，embedding=${r.embedding}）`);
    } else {
      // 非空：增量更新（新面经 md 自动进库）
      const r = await ragApi.incrementalRebuild();
      if (r.changed) console.log(`[rag] 知识库增量更新：+${r.added} -${r.removed}（${r.seconds}s）`);
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

// 优雅关闭：server close / 进程信号时清理所有定时器
const cleanupTimers = () => { for (const t of timers) clearTimeout(t); };
server.on("close", cleanupTimers);
process.on("SIGINT", () => { cleanupTimers(); process.exit(0); });
process.on("SIGTERM", () => { cleanupTimers(); process.exit(0); });
