// 方向画像配置中心：讲解/面试/考点提炼链路的方向参数（解决"全部预设前端角度"的硬编码）
//
// 设计：
// - 所有"角色/范围/语言/默认岗位"等方向相关文案集中于此，默认 = 前端秋招（现状不变）
// - direction 复用 target_direction（设置中心「求职目标」，单一事实源），不重复存储
// - 开源/转方向（agent/全栈/后端）只需改面板「设置 → 方向画像」或直接调 saveCareerProfile
// - 白名单字段校验：杜绝通过 API 写任意 settings key
import { db } from "./db.mjs";
import { loadTreeTemplate } from "./knowledge.mjs";

const SETTINGS_KEY = "career_profile";

/** 可配置字段白名单（面板只允许改这些） */
export const CAREER_FIELDS = [
  "roleLabel",      // 讲解/面试官角色名：默认"资深前端面试辅导老师"
  "scopeNote",      // 讲解保留范围：默认"前端 / 前端全栈 / AI Agent 前端应用"
  "ignoreNote",     // 忽略/筛选说明：默认"后端/算法/C++/嵌入式等其他方向"
  "codeLang",       // 代码语言：默认"JavaScript/TypeScript"
  "positionDefault",// 默认模拟面试岗位：默认"前端实习生"
  "examNote",       // 求职场景：默认"秋招"
  "techKeywords",   // 岗位 JD 技术栈关键词（逗号分隔；巡检方向过滤也用）：默认前端技术栈
];

/** 默认前端画像（改动默认值即全局改方向——开源友好） */
export function defaultCareerProfile() {
  return {
    direction: null, // 从 target_direction 读（单一事实源）
    roleLabel: "资深前端面试辅导老师",
    scopeNote: "前端 / 前端全栈 / AI Agent 前端应用",
    ignoreNote: "后端/算法/C++/嵌入式等其他方向",
    codeLang: "JavaScript/TypeScript",
    positionDefault: "前端实习生",
    examNote: "秋招",
    techKeywords: "React,Vue,TypeScript,JavaScript,Node.js,Webpack,Vite,浏览器,HTTP,CSS,HTML5,小程序,性能优化,工程化,微前端,SSR,Next.js,WebSocket,Canvas,WebGL,可视化,AI Agent,大模型,Prompt,MCP,Electron,Flutter,RN,安全,XSS,跨域,事件循环,闭包,Promise,虚拟DOM,diff,hooks,状态管理,Redux,Pinia,测试,CI/CD,Docker,K8s,GraphQL,数据库,MySQL,Redis,Nginx",
  };
}

/** 读取方向画像：settings 覆盖默认值 + direction 从 target_direction 读（带缓存，save/reset 失效） */
let profileCache = null;
export function getCareerProfile() {
  if (profileCache) return profileCache;
  const def = defaultCareerProfile();
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY);
    if (row?.value != null) {
      const saved = JSON.parse(String(row.value));
      for (const k of CAREER_FIELDS) {
        if (saved && typeof saved[k] === "string" && saved[k].trim()) def[k] = saved[k].trim();
      }
    }
  } catch { /* ignore */ }
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'target_direction'").get();
    if (row?.value != null) {
      const j = JSON.parse(String(row.value));
      if (j && typeof j.direction === "string" && j.direction) def.direction = j.direction;
    }
  } catch { /* ignore */ }
  profileCache = def;
  return profileCache;
}

/** 失效画像缓存（save/reset 后调用） */
export function invalidateCareerProfile() {
  profileCache = null;
}

/** 方向中文标签（投递招呼语/问候语等文案用；未知方向回退"前端"） */
export function directionLabel() {
  const m = { frontend: "前端", agent: "AI 应用前端", fullstack: "全栈", backend: "后端", algorithm: "算法" };
  return m[getCareerProfile().direction] || "前端";
}

/**
 * 保存方向画像（仅白名单字段，非法字段忽略；direction 不在此保存）
 * @param {{roleLabel?: string, scopeNote?: string, ignoreNote?: string, codeLang?: string, positionDefault?: string, examNote?: string}} partial
 * @returns {{ok: boolean, profile?: object, message?: string, error?: string}}
 */
export function saveCareerProfile(partial = {}) {
  const cur = getCareerProfile();
  const next = { ...cur };
  let changed = false;
  for (const k of CAREER_FIELDS) {
    if (partial && typeof partial[k] === "string" && partial[k].trim()) {
      const v = partial[k].trim().slice(0, 60);
      if (next[k] !== v) { next[k] = v; changed = true; }
    }
  }
  if (!changed) return { ok: true, profile: next, message: "无变化（与当前一致）" };
  try {
    const store = {};
    for (const k of CAREER_FIELDS) store[k] = next[k];
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(SETTINGS_KEY, JSON.stringify(store), Date.now());
    invalidateCareerProfile();
    return { ok: true, profile: next, message: "✅ 方向画像已保存——讲解/面试/考点提炼将按新画像出题" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 重置为前端默认画像 */
export function resetCareerProfile() {
  try {
    db.prepare("DELETE FROM settings WHERE key = ?").run(SETTINGS_KEY);
    invalidateCareerProfile();
    return { ok: true, profile: defaultCareerProfile(), message: "已重置为默认（前端）画像" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 简历驱动闭环：方向自动应用（简历存档 → 求职目标/知识树模板/方向画像 一键同步） ----------
/** 方向 → 知识树模板映射（agent/全栈复用前端模板，后端/算法有专属模板） */
const DIRECTION_TREE = { frontend: "frontend", agent: "frontend", fullstack: "frontend", backend: "backend", algorithm: "algorithm" };

/** 按方向生成默认画像（用户手动改过则不覆盖） */
function profileForDirection(direction) {
  const m = {
    backend: {
      roleLabel: "资深后端面试辅导老师", scopeNote: "后端 / 微服务 / 分布式 / 高并发",
      ignoreNote: "前端/算法/嵌入式等其他方向", codeLang: "Java/Go",
      positionDefault: "后端开发工程师", examNote: "秋招",
      techKeywords: "Java,Go,MySQL,Redis,Kafka,RocketMQ,Spring,SpringBoot,MyBatis,分布式,微服务,高并发,消息队列,缓存,数据库,JVM,并发编程,线程池,Docker,K8s,Linux,网络,TCP,HTTP,RPC,一致性,事务",
    },
    algorithm: {
      roleLabel: "资深算法面试辅导老师", scopeNote: "算法 / 机器学习 / 深度学习 / 数据结构",
      ignoreNote: "前端/后端/嵌入式等其他方向", codeLang: "Python/C++",
      positionDefault: "算法工程师", examNote: "秋招",
      techKeywords: "算法,数据结构,排序,二叉树,动态规划,双指针,回溯,图,机器学习,深度学习,PyTorch,TensorFlow,Python,C++,NLP,CV,推荐系统,大模型",
    },
  };
  return m[direction] || null;
}

/**
 * 简历驱动的方向自动应用（setResumeProfile 成功后调用）：
 * 1) 求职目标 target_direction ← 简历识别方向（**仅首次自动设置**：用户手动改过
 *    （手动标记 manual=true）或已有值则不再覆盖——修复：原实现无条件覆盖，
 *    用户手动设 backend 后上传 agent 简历被静默改回 agent）
 * 2) 知识树模板：仅当用户没有自定义知识树时自动加载对应模板（自定义优先）
 * 3) 方向画像：仅当用户没有手动改过画像时按方向填充默认值（手动优先）
 * @returns {{ok: boolean, applied: string[], direction: string}}
 */
export function applyDirectionAuto(direction) {
  const dir = ["frontend", "agent", "fullstack", "backend", "algorithm"].includes(direction) ? direction : "frontend";
  const applied = [];
  const now = Date.now();
  // 1) 求职目标（手动优先：已有 target_direction 或手动标记 → 不覆盖）
  try {
    const existing = db.prepare("SELECT value FROM settings WHERE key='target_direction'").get();
    const manual = existing?.value ? JSON.parse(String(existing.value))?.manual : false;
    if (!existing?.value) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
        .run("target_direction", JSON.stringify({ direction: dir, manual: false, updatedAt: now }), now);
      applied.push("求职目标");
    } else if (!manual) {
      // 已有值但非手动（可能此前简历自动设置过）→ 简历方向变化时跟随更新（仍不覆盖手动）
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
        .run("target_direction", JSON.stringify({ direction: dir, manual: false, updatedAt: now }), now);
      applied.push("求职目标");
    }
  } catch { /* ignore */ }
  // 2) 知识树模板（无自定义树时）
  try {
    const custom = db.prepare("SELECT value FROM settings WHERE key='knowledge_tree'").get();
    if (!custom?.value) {
      const treeName = DIRECTION_TREE[dir] || "frontend";
      const r = loadTreeTemplate(treeName);
      if (r?.ok) applied.push(`知识树（${treeName}）`);
    }
  } catch { /* ignore */ }
  // 3) 方向画像（无手动画像时）
  try {
    const saved = db.prepare("SELECT value FROM settings WHERE key=?").get(SETTINGS_KEY);
    if (!saved?.value) {
      const preset = profileForDirection(dir);
      if (preset) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
          .run(SETTINGS_KEY, JSON.stringify(preset), now);
        applied.push("方向画像");
      }
    }
  } catch { /* ignore */ }
  invalidateCareerProfile();
  return { ok: true, applied, direction: dir };
}
