// 知识点树：分类骨架（默认前端，可配置）+ 掌握度（动态）
// 面试/复习的题目打上 kp_id，答题结果写回该知识点掌握度
// 开源/转方向：设置中心「知识树」可整体替换（settings knowledge_tree 存 JSON，结构见 DEFAULT_TREE）
import { db, withTx } from "./db.mjs";

// 默认前端面试知识树（静态骨架：分类 → 知识点 → 难度/关键词）
// kws = 该知识点的匹配关键词（matchKp 动态构建规则；自定义树可不带 kws → 仅精确 title 匹配）
export const KNOWLEDGE_TREE = [
  {
    id: "js", title: "JavaScript 核心", difficulty: 2,
    points: [
      { id: "js-closure", title: "闭包与作用域", difficulty: 2, kws: ["闭包", "作用域", "closure"] },
      { id: "js-prototype", title: "原型链与继承", difficulty: 2, kws: ["原型", "继承", "prototype"] },
      { id: "js-this", title: "this 指向", difficulty: 2, kws: ["this", "指向"] },
      { id: "js-event-loop", title: "事件循环与微任务", difficulty: 3, kws: ["事件循环", "微任务", "宏任务", "event loop", "setTimeout"] },
      { id: "js-promise", title: "Promise 与异步", difficulty: 3, kws: ["promise", "异步", "async", "await"] },
      { id: "js-module", title: "模块化 (ESM/CJS)", difficulty: 2, kws: ["模块", "esm", "cjs", "import", "export"] },
    ],
  },
  {
    id: "browser", title: "浏览器原理", difficulty: 3,
    points: [
      { id: "br-render", title: "渲染管线与回流重绘", difficulty: 3, kws: ["渲染", "回流", "重绘", "dom"] },
      { id: "br-cache", title: "缓存策略", difficulty: 2, kws: ["缓存", "cache", "http"] },
      { id: "br-security", title: "XSS/CSRF/CORS", difficulty: 3, kws: ["xss", "csrf", "cors", "安全", "跨域"] },
      { id: "br-perf", title: "性能指标与优化", difficulty: 3, kws: ["性能", "优化", "首屏"] },
    ],
  },
  {
    id: "react", title: "React", difficulty: 3,
    points: [
      { id: "rc-hooks", title: "Hooks 原理", difficulty: 3, kws: ["hooks", "usestate", "useeffect"] },
      { id: "rc-render", title: "渲染机制与 Fiber", difficulty: 4, kws: ["fiber", "渲染机制", "并发"] },
      { id: "rc-diff", title: "虚拟 DOM 与 diff", difficulty: 3, kws: ["diff", "虚拟dom", "key"] },
      { id: "rc-state", title: "状态管理选型", difficulty: 3, kws: ["状态管理", "redux", "zustand"] },
    ],
  },
  {
    id: "css", title: "CSS/HTML", difficulty: 2,
    points: [
      { id: "css-layout", title: "布局 (Flex/Grid)", difficulty: 2, kws: ["flex", "grid", "布局"] },
      { id: "css-bfc", title: "BFC 与层叠上下文", difficulty: 3, kws: ["bfc", "层叠", "定位"] },
      { id: "css-anim", title: "动画与性能", difficulty: 2, kws: ["动画", "transition", "transform"] },
    ],
  },
  {
    id: "engineer", title: "工程化", difficulty: 3,
    points: [
      { id: "eng-build", title: "Webpack/Vite", difficulty: 3, kws: ["webpack", "vite", "打包"] },
      { id: "eng-babel", title: "Babel 与编译", difficulty: 3, kws: ["babel", "编译", "ast"] },
      { id: "eng-ts", title: "TypeScript", difficulty: 2, kws: ["typescript", "类型", "泛型"] },
    ],
  },
  {
    id: "network", title: "网络", difficulty: 2,
    points: [
      { id: "net-http", title: "HTTP/1.1-3", difficulty: 2, kws: ["http", "http1", "http2", "http3"] },
      { id: "net-ws", title: "WebSocket/SSE", difficulty: 2, kws: ["websocket", "sse", "长连接"] },
      { id: "net-cdn", title: "CDN 与部署", difficulty: 2, kws: ["cdn", "部署", "静态资源"] },
    ],
  },
];

// 扁平索引（默认树）
export const ALL_POINTS = KNOWLEDGE_TREE.flatMap((cat) =>
  cat.points.map((p) => ({ ...p, category: cat.id, categoryTitle: cat.title }))
);

// ---------- 可配置知识树（settings knowledge_tree 覆盖默认；非法 JSON/结构回退默认） ----------
const TREE_KEY = "knowledge_tree";
let treeCache = null; // null=未加载；object=当前树

/** 结构校验：分类数组 → 分类有 id/title/points，点有 id/title */
export function isValidTree(tree) {
  if (!Array.isArray(tree) || !tree.length) return false;
  for (const cat of tree) {
    if (!cat || typeof cat.id !== "string" || typeof cat.title !== "string" || !Array.isArray(cat.points)) return false;
    for (const p of cat.points) {
      if (!p || typeof p.id !== "string" || typeof p.title !== "string") return false;
      if (p.kws !== undefined && !Array.isArray(p.kws)) return false;
    }
  }
  return true;
}

/** 当前知识树：settings 覆盖默认（带缓存，save/reset 失效） */
export function getKnowledgeTree() {
  if (treeCache) return treeCache;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(TREE_KEY);
    if (row?.value != null) {
      const parsed = JSON.parse(String(row.value));
      if (isValidTree(parsed)) {
        treeCache = parsed;
        return treeCache;
      }
      console.log(`[knowledge] 自定义知识树结构非法，回退默认树`);
    }
  } catch { /* ignore */ }
  treeCache = KNOWLEDGE_TREE;
  return treeCache;
}

/** 保存自定义知识树（校验 + 持久化 + 失效缓存）；重置传 {reset:true} */
export function saveKnowledgeTree(tree) {
  if (!isValidTree(tree)) return { ok: false, error: "知识树结构非法（需 [{id,title,points:[{id,title,kws?}]}]）" };
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(TREE_KEY, JSON.stringify(tree), Date.now());
    treeCache = null;
    return { ok: true, total: tree.reduce((n, c) => n + c.points.length, 0), message: `✅ 知识树已更新（${tree.length} 类 / ${tree.reduce((n, c) => n + c.points.length, 0)} 个知识点）` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 重置为默认前端知识树 */
export function resetKnowledgeTree() {
  try {
    db.prepare("DELETE FROM settings WHERE key = ?").run(TREE_KEY);
    treeCache = null;
    return { ok: true, message: "已重置为默认知识树" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 当前树扁平索引（动态） */
export function getAllPoints() {
  return getKnowledgeTree().flatMap((cat) =>
    cat.points.map((p) => ({ ...p, category: cat.id, categoryTitle: cat.title }))
  );
}

function loadMastery() {
  const m = {};
  for (const r of db.prepare("SELECT topic, score, attempts, last_at FROM kp_mastery").all()) {
    m[r.topic] = { score: r.score, attempts: r.attempts, lastAt: r.last_at };
  }
  return m;
}
function saveMastery(m) {
  // 全量重写（掌握度表小）；包事务，防崩溃于 DELETE 与 INSERT 之间清空全部掌握度
  try {
    withTx(() => {
      db.exec("DELETE FROM kp_mastery");
      const ins = db.prepare("INSERT OR REPLACE INTO kp_mastery (topic, score, attempts, last_at) VALUES (?, ?, ?, ?)");
      for (const [topic, v] of Object.entries(m)) {
        ins.run(String(topic), Number(v.score) || 0, Number(v.attempts) || 0, v.lastAt || null);
      }
    });
  } catch { /* ignore */ }
}

/** 自由主题归一化：trim/小写/截断，作为动态知识点掌握度的 key（兜底去重） */
function normalizeKpTopic(topic) {
  return String(topic || "").trim().toLowerCase().slice(0, 60);
}

/** 关键词 → 知识点 id 匹配（模糊）：规则从当前知识树动态构建（点.kws；无 kws 的点用 title 匹配） */
export function matchKp(text) {
  const t = String(text || "");
  const rules = [];
  for (const cat of getKnowledgeTree()) {
    for (const p of cat.points) {
      const kws = Array.isArray(p.kws) && p.kws.length ? p.kws : [p.title];
      rules.push([p.id, kws]);
    }
  }
  for (const [id, kws] of rules) {
    const kw = /** @type {string[]} */ (kws);
    if (kw.some((k) => t.toLowerCase().includes(String(k).toLowerCase()))) return id;
  }
  // 兜底：无静态知识点命中 → 返回归一化后的主题自身（动态知识点，recordKp 会注册进 kp_mastery）
  return normalizeKpTopic(text) || null;
}

/** 记录一次作答：答对加分，答错/薄弱扣分 */
export function recordKp(kpId, { correct = true, strong = false } = {}) {
  if (!kpId) return;
  const m = loadMastery();
  if (!m[kpId]) m[kpId] = { score: 50, attempts: 0, lastAt: "" };
  const kp = m[kpId];
  kp.attempts++;
  kp.lastAt = new Date().toISOString();
  if (correct) {
    kp.score = Math.min(100, kp.score + (strong ? 15 : 8));
  } else {
    kp.score = Math.max(0, kp.score - 12);
  }
  saveMastery(m);
}

/** 掌握度视图：每个知识点的 score + 排序（基于当前知识树，动态） */
export function getMastery() {
  const m = loadMastery();
  return getAllPoints().map((p) => ({
    ...p,
    score: m[p.id]?.score ?? 50, // 默认 50（未学）
    attempts: m[p.id]?.attempts ?? 0,
  })).sort((a, b) => a.score - b.score); // 最弱的在前
}

/** 薄弱知识点（score < 50 或尝试多仍低） */
export function getWeakKps(limit = 5) {
  return getMastery().filter((k) => k.score < 50).slice(0, limit);
}
