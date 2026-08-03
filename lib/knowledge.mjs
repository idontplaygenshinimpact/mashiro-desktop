// 知识点树：前端八股分类骨架（静态）+ 掌握度（动态）
// 面试/复习的题目打上 kp_id，答题结果写回该知识点掌握度
import { db } from "./db.mjs";

// 前端面试知识树（静态骨架：分类 → 知识点 → 难度/前置）
export const KNOWLEDGE_TREE = [
  {
    id: "js", title: "JavaScript 核心", difficulty: 2,
    points: [
      { id: "js-closure", title: "闭包与作用域", difficulty: 2 },
      { id: "js-prototype", title: "原型链与继承", difficulty: 2 },
      { id: "js-this", title: "this 指向", difficulty: 2 },
      { id: "js-event-loop", title: "事件循环与微任务", difficulty: 3 },
      { id: "js-promise", title: "Promise 与异步", difficulty: 3 },
      { id: "js-module", title: "模块化 (ESM/CJS)", difficulty: 2 },
    ],
  },
  {
    id: "browser", title: "浏览器原理", difficulty: 3,
    points: [
      { id: "br-render", title: "渲染管线与回流重绘", difficulty: 3 },
      { id: "br-cache", title: "缓存策略", difficulty: 2 },
      { id: "br-security", title: "XSS/CSRF/CORS", difficulty: 3 },
      { id: "br-perf", title: "性能指标与优化", difficulty: 3 },
    ],
  },
  {
    id: "react", title: "React", difficulty: 3,
    points: [
      { id: "rc-hooks", title: "Hooks 原理", difficulty: 3 },
      { id: "rc-render", title: "渲染机制与 Fiber", difficulty: 4 },
      { id: "rc-diff", title: "虚拟 DOM 与 diff", difficulty: 3 },
      { id: "rc-state", title: "状态管理选型", difficulty: 3 },
    ],
  },
  {
    id: "css", title: "CSS/HTML", difficulty: 2,
    points: [
      { id: "css-layout", title: "布局 (Flex/Grid)", difficulty: 2 },
      { id: "css-bfc", title: "BFC 与层叠上下文", difficulty: 3 },
      { id: "css-anim", title: "动画与性能", difficulty: 2 },
    ],
  },
  {
    id: "engineer", title: "工程化", difficulty: 3,
    points: [
      { id: "eng-build", title: "Webpack/Vite", difficulty: 3 },
      { id: "eng-babel", title: "Babel 与编译", difficulty: 3 },
      { id: "eng-ts", title: "TypeScript", difficulty: 2 },
    ],
  },
  {
    id: "network", title: "网络", difficulty: 2,
    points: [
      { id: "net-http", title: "HTTP/1.1-3", difficulty: 2 },
      { id: "net-ws", title: "WebSocket/SSE", difficulty: 2 },
      { id: "net-cdn", title: "CDN 与部署", difficulty: 2 },
    ],
  },
];

// 扁平索引
export const ALL_POINTS = KNOWLEDGE_TREE.flatMap((cat) =>
  cat.points.map((p) => ({ ...p, category: cat.id, categoryTitle: cat.title }))
);

function loadMastery() {
  const m = {};
  for (const r of db.prepare("SELECT topic, score, attempts, last_at FROM kp_mastery").all()) {
    m[r.topic] = { score: r.score, attempts: r.attempts, lastAt: r.last_at };
  }
  return m;
}
function saveMastery(m) {
  // 全量重写（掌握度表小）
  try {
    db.exec("DELETE FROM kp_mastery");
    const ins = db.prepare("INSERT OR REPLACE INTO kp_mastery (topic, score, attempts, last_at) VALUES (?, ?, ?, ?)");
    for (const [topic, v] of Object.entries(m)) {
      ins.run(String(topic), Number(v.score) || 0, Number(v.attempts) || 0, v.lastAt || null);
    }
  } catch { /* ignore */ }
}

/** 关键词 → 知识点 id 匹配（模糊） */
export function matchKp(text) {
  const t = String(text || "");
  const rules = [
    ["js-closure", ["闭包", "作用域", "closure"]],
    ["js-prototype", ["原型", "继承", "prototype"]],
    ["js-this", ["this", "指向"]],
    ["js-event-loop", ["事件循环", "微任务", "宏任务", "event loop", "setTimeout"]],
    ["js-promise", ["promise", "异步", "async", "await"]],
    ["js-module", ["模块", "esm", "cjs", "import", "export"]],
    ["br-render", ["渲染", "回流", "重绘", "dom"]],
    ["br-cache", ["缓存", "cache", "http"]],
    ["br-security", ["xss", "csrf", "cors", "安全", "跨域"]],
    ["br-perf", ["性能", "优化", "首屏"]],
    ["rc-hooks", ["hooks", "usestate", "useeffect"]],
    ["rc-render", ["fiber", "渲染机制", "并发"]],
    ["rc-diff", ["diff", "虚拟dom", "key"]],
    ["rc-state", ["状态管理", "redux", "zustand"]],
    ["css-layout", ["flex", "grid", "布局"]],
    ["css-bfc", ["bfc", "层叠", "定位"]],
    ["css-anim", ["动画", "transition", "transform"]],
    ["eng-build", ["webpack", "vite", "打包"]],
    ["eng-babel", ["babel", "编译", "ast"]],
    ["eng-ts", ["typescript", "类型", "泛型"]],
    ["net-http", ["http", "http1", "http2", "http3"]],
    ["net-ws", ["websocket", "sse", "长连接"]],
    ["net-cdn", ["cdn", "部署", "静态资源"]],
  ];
  for (const [id, kws] of rules) {
    if (kws.some((k) => t.toLowerCase().includes(k))) return id;
  }
  return null;
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

/** 掌握度视图：每个知识点的 score + 排序 */
export function getMastery() {
  const m = loadMastery();
  return ALL_POINTS.map((p) => ({
    ...p,
    score: m[p.id]?.score ?? 50, // 默认 50（未学）
    attempts: m[p.id]?.attempts ?? 0,
  })).sort((a, b) => a.score - b.score); // 最弱的在前
}

/** 薄弱知识点（score < 50 或尝试多仍低） */
export function getWeakKps(limit = 5) {
  return getMastery().filter((k) => k.score < 50).slice(0, limit);
}
