// 记忆模块 v2：用户画像 + 关注点 + 学习进度 + 薄弱点 + 跨会话对话历史
// 持久化到 data/agent-memory.json（原子写入，防崩溃损坏）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJsonSafe } from "./atomic-json.mjs";

const MEM_DIR = path.join(import.meta.dirname, "..", "data");
const MEM_FILE = path.join(MEM_DIR, "agent-memory.json");

function defaults() {
  return {
    profile: { name: "", target: "前端秋招", level: "unknown" },
    interests: [],           // 关注点 [topic]
    seenUrls: [],            // 已看帖子
    chatHistory: [],         // 跨会话对话历史 [{role, content, ts}]
    weakPoints: [],          // 薄弱点 [{topic, failCount, lastFailedAt, source, origin}]
    masteredPoints: [],      // 已掌握 [{topic, verifiedAt}]
    studyProgress: {},       // { topic: {done, reviewed, times} }
    interview: null,         // 进行中的模拟面试会话
    interviewHistory: [],    // 历史面试记录 [{date, role, position, rounds, avgScore, dims, weakPoints}]
    stats: { chats: 0, questionsSolved: 0, reviewsDone: 0, interviewsDone: 0, lastActive: "" },
  };
}

function load() {
  const d = readJsonSafe(MEM_FILE, null);
  if (d) return { ...defaults(), ...d };
  return defaults();
}

let mem = load();

function save() {
  try {
    mkdirSync(MEM_DIR, { recursive: true });
    writeJsonAtomic(MEM_FILE, mem);
  } catch { /* ignore */ }
}

export const memory = {
  // ---------- 基础 ----------
  get() { return mem; },

  // ---------- 关注点 ----------
  getInterests() { return mem.interests || []; },
  addInterests(topics) {
    const list = mem.interests || [];
    const added = [];
    for (const t of (topics || [])) {
      const clean = String(t).trim().slice(0, 30);
      if (clean && !list.includes(clean)) { list.push(clean); added.push(clean); }
    }
    mem.interests = list.slice(-20);
    save();
    return added;
  },

  // ---------- 已看帖子 ----------
  isSeen(url) { return (mem.seenUrls || []).includes(url); },
  markSeen(url) {
    if (!url) return;
    mem.seenUrls = [...(mem.seenUrls || []), url].slice(-500);
    save();
  },

  // ---------- 对话历史（跨会话） ----------
  getChatHistory() { return mem.chatHistory || []; },
  appendChat(role, content) {
    mem.chatHistory = [...(mem.chatHistory || []), { role, content, ts: Date.now() }].slice(-40);
    mem.stats.chats = (mem.stats.chats || 0) + 1;
    mem.stats.lastActive = new Date().toISOString();
    save();
  },

  // ---------- 薄弱点 ----------
  getWeakPoints() { return mem.weakPoints || []; },
  // 可信薄弱点：只返回 owner/agent 来源（untrusted 如爬虫页面提炼的伪知识点不注入 prompt）
  getTrustedWeakPoints(limit = 20) {
    return (mem.weakPoints || [])
      .filter((w) => w.origin !== "untrusted")
      .slice(0, limit);
  },
  // 过滤伪知识点：考察维度名/泛化标签/空值 → 不记录（只保留具体知识点名）
  _cleanTopic(topic) {
    if (!topic) return null;
    const t = String(topic).trim().slice(0, 40);
    if (!t || t.length > 30) return null;
    if (/考察维度|综合能力|表达能力|^维度|^综合|^沟通|^态度|^思维|^逻辑|面试表现|整体表现|^无$|^暂无|^none$/i.test(t)) return null;
    return t;
  },
  // 记录薄弱点：failCount 累加，source 记来源，origin 记可信级别（owner/agent/untrusted）
  addWeakPoint(topic, source, origin = "agent") {
    const clean = this._cleanTopic(topic);
    if (!clean) return; // 伪知识点不记录
    const list = mem.weakPoints || [];
    const found = list.find((w) => w.topic === clean);
    if (found) {
      found.failCount = (found.failCount || 0) + 1;
      found.lastFailedAt = new Date().toISOString();
      if (source) found.source = source;
      found.origin = origin; // 溯源：保留最新来源可信级别
    } else {
      list.push({ topic: clean, failCount: 1, lastFailedAt: new Date().toISOString(), source, origin });
    }
    mem.weakPoints = list.sort((a, b) => (b.failCount || 0) - (a.failCount || 0)).slice(0, 20);
    save();
  },
  // 从复盘判分结果回流：错/部分对 → 薄弱点
  applyReviewResults(results) {
    if (!results) return;
    for (const r of results) {
      if (!r.topic) continue;
      const clean = this._cleanTopic(r.topic);
      if (!clean) continue; // 伪知识点跳过
      if (r.verdict === "错") {
        this.addWeakPoint(clean, "复盘验证");
        this.recordProgress(clean, "failed");
      } else if (r.verdict === "部分对") {
        this.addWeakPoint(clean, "复盘验证");
        this.recordProgress(clean, "partial");
      } else {
        this.addMastered(clean);
        this.recordProgress(clean, "passed");
      }
    }
    mem.stats.reviewsDone = (mem.stats.reviewsDone || 0) + 1;
    save();
  },
  clearWeakPoint(topic) {
    mem.weakPoints = (mem.weakPoints || []).filter((w) => w.topic !== topic);
    save();
  },

  // ---------- 已掌握 ----------
  getMastered() { return mem.masteredPoints || []; },
  addMastered(topic) {
    const list = mem.masteredPoints || [];
    if (!list.find((m) => m.topic === topic)) {
      list.push({ topic, verifiedAt: new Date().toISOString() });
    }
    mem.masteredPoints = list.slice(-30);
    // 掌握后清掉对应薄弱点
    mem.weakPoints = (mem.weakPoints || []).filter((w) => w.topic !== topic);
    save();
  },

  // ---------- 学习进度 ----------
  recordProgress(topic, status) {
    const p = mem.studyProgress || {};
    if (!p[topic]) p[topic] = { times: 0, done: false, reviewed: false };
    p[topic].times = (p[topic].times || 0) + 1;
    if (status === "done") p[topic].done = true;
    if (status === "reviewed") p[topic].reviewed = true;
    mem.studyProgress = p;
    save();
  },

  // ---------- 对话摘要（给 system prompt 的画像） ----------
  getProfileSummary() {
    const parts = [];
    const interests = mem.interests || [];
    const weak = mem.weakPoints || [];
    if (interests.length) parts.push(`关注点：${interests.join("、")}`);
    if (weak.length) parts.push(`薄弱点：${weak.slice(0, 5).map((w) => `${w.topic}(${w.failCount}次)`).join("、")}`);
    if (mem.profile.target) parts.push(`目标：${mem.profile.target}`);
    if (parts.length === 0) return "新用户";
    return parts.join("；");
  },

  // ---------- 模拟面试会话 ----------
  getInterview() { return mem.interview; },
  setInterview(session) { mem.interview = session; save(); },
  clearInterview() { mem.interview = null; save(); },
  saveInterviewHistory(record) {
    mem.interviewHistory = [...(mem.interviewHistory || []), record].slice(-20);
    mem.stats.interviewsDone = (mem.stats.interviewsDone || 0) + 1;
    save();
  },
  getInterviewHistory() { return mem.interviewHistory || []; },
};
