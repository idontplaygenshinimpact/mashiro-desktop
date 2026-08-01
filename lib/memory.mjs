// 记忆模块 v2：用户画像 + 关注点 + 学习进度 + 薄弱点 + 跨会话对话历史
// 持久化到 data/agent-memory.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const MEM_DIR = path.join(import.meta.dirname, "..", "data");
const MEM_FILE = path.join(MEM_DIR, "agent-memory.json");

function defaults() {
  return {
    profile: { name: "", target: "前端秋招", level: "unknown" },
    interests: [],           // 关注点 [topic]
    seenUrls: [],            // 已看帖子
    chatHistory: [],         // 跨会话对话历史 [{role, content, ts}]
    weakPoints: [],          // 薄弱点 [{topic, failCount, lastFailedAt, source}]
    masteredPoints: [],      // 已掌握 [{topic, verifiedAt}]
    studyProgress: {},       // { topic: {done, reviewed, times} }
    stats: { chats: 0, questionsSolved: 0, reviewsDone: 0, lastActive: "" },
  };
}

function load() {
  try {
    if (existsSync(MEM_FILE)) {
      const d = JSON.parse(readFileSync(MEM_FILE, "utf8"));
      return { ...defaults(), ...d };
    }
  } catch { /* ignore */ }
  return defaults();
}

let mem = load();

function save() {
  try {
    mkdirSync(MEM_DIR, { recursive: true });
    writeFileSync(MEM_FILE, JSON.stringify(mem, null, 2), "utf8");
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
  // 记录薄弱点：failCount 累加，source 记来源
  addWeakPoint(topic, source) {
    const list = mem.weakPoints || [];
    const found = list.find((w) => w.topic === topic);
    if (found) {
      found.failCount = (found.failCount || 0) + 1;
      found.lastFailedAt = new Date().toISOString();
      if (source) found.source = source;
    } else {
      list.push({ topic, failCount: 1, lastFailedAt: new Date().toISOString(), source });
    }
    mem.weakPoints = list.sort((a, b) => (b.failCount || 0) - (a.failCount || 0)).slice(0, 20);
    save();
  },
  // 从复盘判分结果回流：错/部分对 → 薄弱点
  applyReviewResults(results) {
    if (!results) return;
    for (const r of results) {
      if (!r.topic) continue;
      if (r.verdict === "错") {
        this.addWeakPoint(r.topic, "复盘验证");
        this.recordProgress(r.topic, "failed");
      } else if (r.verdict === "部分对") {
        this.addWeakPoint(r.topic, "复盘验证");
        this.recordProgress(r.topic, "partial");
      } else {
        this.addMastered(r.topic);
        this.recordProgress(r.topic, "passed");
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
};
