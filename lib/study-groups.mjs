// 学习清单：大类归一化（知识树 + 兜底规则）——依赖 knowledge 知识树（getAllPoints 动态读 settings）
// 纵向拆分第 4 刀第一步：纯函数域先拆（原在 study.mjs）
import { getAllPoints } from "./knowledge.mjs";

// ---------- 大类归一化：复用知识树分类（getAllPoints 动态读 settings，换方向自动跟随） ----------
// 知识树命中 → 知识点所属分类（如"JavaScript 核心"/"浏览器原理"/"React"/"网络"）
// 知识树未覆盖的领域（算法/数据库/RAG/面试）→ 兜底规则；都不中 → 其他

export const EXTRA_GROUP_RULES = [
  { g: "算法与手写", kws: ["算法", "手写", "手撕", "lru", "lfu", "排序", "链表", "二叉树", "栈", "队列", "动态规划", "dp", "复杂度", "双指针", "哈希", "递归", "防抖", "节流", "深拷贝", "浅拷贝", "发布订阅", "单例", "观察者", "数组", "字符串", "版本号", "字典序", "未出现", "二进制", "四则", "机器人", "拼接", "比较器", "手写实现", "top101", "oj", "大厂手写", "堆", "大顶堆"] },
  { g: "数据库", kws: ["mysql", "索引", "回表", "事务", "锁", "唯一索引", "存储引擎", "sql", "隔离", "b+树", "b树", "innodb", "主键", "外键", "优化器"] },
  { g: "RAG与LLM", kws: ["rag", "llm", "大模型", "agent", "检索", "embedding", "向量", "prompt", "ai", "gpt", "微调", "langchain", "多模态", "mcp", "幻觉", "上下文", "token"] },
  { g: "面试与求职", kws: ["面试", "简历", "offer", "面经", "求职", "hr", "自我介绍", "薪资", "跳槽", "内推"] },
];

// 手写/算法专属强信号：topic 命中这些词 → 直接归"算法与手写"，**优先于知识树**
// 背景修复：frontend 知识树「浏览器原理·缓存策略」kws 含泛词"缓存"，会把"手撕LRU缓存"
// （手写 LRUCache 算法题）吸进浏览器原理——而"手写/手撕/LRU"是明确的手写题信号，
// 应与兜底规则的算法组竞争（甚至压过知识树的泛词命中），而不是被泛词抢先。
export const ALGO_HANDWRITE_STRONG = ["手撕", "手写", "大厂手写", "手写实现", "lru", "lfu"];

// LLM/Agent 领域强信号：topic 命中这些词 → 直接归"RAG与LLM"，**优先于知识树**
// 背景修复：LLM 基础与 Transformer 原理 被知识树吸到 CSS/HTML、AI Agent LLM 微调与量化部署
// 被吸到网络——LLM/Agent 是明确领域信号，不该被知识树泛词带偏（与 ALGO_HANDWRITE_STRONG 同理）。
// 注意：不含 "agent"（太泛——项目名 AgentChat 会被误吸；Agent 架构类条目靠兜底规则 agent 词归组）
export const LLM_AGENT_STRONG = ["llm", "大模型", "transformer", "微调", "量化", "langchain", "langgraph", "mcp", "embedding", "多模态", "function calling", "工具调用", "gpt", "prompt", "token", "rag", "检索增强"];

/** 归一化主题簇：手写/算法强信号（topic）→ 知识树分类（topic，按命中关键词数最多选点，避免泛词抢先）→ 知识树匹配 why（项目条目按技术栈归类）→ 兜底规则 → 其他 */
export function normalizeGroup(topic, grp = "", why = "") {
  const t = String(topic || "").toLowerCase();
  const g = String(grp || "").toLowerCase();
  const w = String(why || "").toLowerCase();
  // 0) 手写/算法强信号优先：手撕/手写/LRU 等明确算法题信号不被知识树泛词误吸
  if (ALGO_HANDWRITE_STRONG.some((k) => t.includes(k))) return "算法与手写";
  // 0b) LLM/Agent 领域强信号优先：LLM/大模型/微调/量化 等明确领域信号不被知识树泛词带偏
  if (LLM_AGENT_STRONG.some((k) => t.includes(k))) return "RAG与LLM";
  // 1) 知识树：统计 topic 命中各知识点的关键词数，取命中最多且 ≥1 的（平局取遍历序）
  //    特异性门槛：该点"被命中的关键词"里必须至少有一个长词（中文长度≥3，如 http/事件循环/模板语法）
  //    背景修复：只靠"缓存/模板/锁"这类短泛词命中的点不可信——曾把"手撕LRU缓存"吸到
  //    浏览器（命中医术的"缓存"）、"面试自我介绍模板"吸到 Vue（命中"模板"）。短词命中
  //    时宁可落回兜底规则，也不被无关大类带偏。
  const treeHit = (text) => {
    let best = null;
    for (const p of getAllPoints()) {
      const kws = Array.isArray(p.kws) && p.kws.length ? p.kws : [p.title];
      const hitKws = kws.filter((k) => text.includes(String(k).toLowerCase()));
      if (!hitKws.length) continue;
      const specific = hitKws.some((k) => String(k).toLowerCase().length >= 3);
      if (!specific) continue; // 只有短泛词命中 → 点不可信，跳过（避免误吸）
      if (!best || hitKws.length > best.hits) best = { cat: p.categoryTitle, hits: hitKws.length };
    }
    return best ? best.cat : null;
  };
  // 项目条目（"项目·"前缀）：项目名含领域词是正常的（如"AgentChat"）——不按 topic 归知识树，
  // 优先按 why 技术栈归类（treeHit(w)）；未命中 → 保留原分组（历史值，避免回填把 React 项目
  // 重算成"其他"）；无原分组 → 其他
  const isProject = t.startsWith("项目·") || t.startsWith("项目：");
  if (isProject) {
    const catW = treeHit(w);
    if (catW) return catW;
    return g ? grp : "其他";
  }
  const catT = treeHit(t);
  if (catT) return catT;
  // 1b) 知识树匹配 why（项目类条目技术栈在 why）
  const catW = treeHit(w);
  if (catW) return catW;
  // 2) 兜底规则：topic + grp
  for (const { g: name, kws } of EXTRA_GROUP_RULES) {
    if (kws.some((k) => t.includes(k) || g.includes(k))) return name;
  }
  // 3) why 辅助（跳过"面试与求职"与"算法与手写"——why 是技术栈/来源描述，
  //    "技术栈"含"栈"会被算法组误吸；算法题靠 topic 本身判定，不从 why 归类）
  for (const { g: name, kws } of EXTRA_GROUP_RULES) {
    if (name === "面试与求职" || name === "算法与手写") continue;
    if (kws.some((k) => w.includes(k))) return name;
  }
  return "其他";
}
