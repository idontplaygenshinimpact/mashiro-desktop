// 学习清单：大类归一化（知识树 + 兜底规则）——依赖 knowledge 知识树（getAllPoints 动态读 settings）
// 纵向拆分第 4 刀第一步：纯函数域先拆（原在 study.mjs）
// 全量 TS 升级工单阶段 1⑩：lib/study-groups.ts → .ts（词表/规则表显式类型；LLM 结果断言收口）
import { getAllPoints } from "./knowledge.mjs";
// 统一匹配层（match-utils）：组合词表/独立成词/特异性门槛一处维护全局生效
import { kwHit, hasSpecificKw } from "./match-utils.ts";
// 分类判定相似度引擎工单任务 1：similarity 规则层（同步——词表补全追不上新题）
import { similarityRule } from "./similarity.ts";
export { kwHit } from "./match-utils.ts"; // 兼容旧导出（测试直测）

// ---------- 大类归一化：复用知识树分类（getAllPoints 动态读 settings，换方向自动跟随） ----------
// 知识树命中 → 知识点所属分类（如"JavaScript 核心"/"浏览器原理"/"React"/"网络"）
// 知识树未覆盖的领域（算法/数据库/RAG/面试）→ 兜底规则；都不中 → 其他

/** 兜底分组规则（组名 + 关键词表） */
interface GroupRule { g: string; kws: string[] }

export const EXTRA_GROUP_RULES: GroupRule[] = [
  // 相似度引擎统一工单任务 5②：算法组 kws 补全（"其他"组 14 条算法题错分——
  // 子串/子序列/回文/岛屿/全排列/括号/股票/递增子序列/三数之和/叶子节点/ASL/mex/差分/前缀/滑动窗口/最长/无重复）
  { g: "算法与手写", kws: ["算法", "手写", "手撕", "lru", "lfu", "排序", "链表", "二叉树", "栈", "队列", "动态规划", "dp", "复杂度", "双指针", "哈希", "递归", "防抖", "节流", "深拷贝", "浅拷贝", "发布订阅", "单例", "观察者", "数组", "字符串", "版本号", "字典序", "未出现", "二进制", "四则", "机器人", "拼接", "比较器", "手写实现", "top101", "oj", "大厂手写", "堆", "大顶堆", "子串", "子序列", "回文", "岛屿", "全排列", "括号", "股票", "递增子序列", "三数之和", "叶子节点", "asl", "mex", "差分", "前缀", "滑动窗口", "最长", "无重复", "最佳时机"] },
  { g: "数据库", kws: ["mysql", "索引", "回表", "事务", "锁", "唯一索引", "存储引擎", "sql", "隔离", "b+树", "b树", "innodb", "主键", "外键", "优化器"] },
  { g: "Agent与LLM", kws: ["rag", "llm", "大模型", "agent", "检索", "embedding", "向量", "prompt", "ai", "gpt", "微调", "langchain", "多模态", "mcp", "幻觉", "上下文", "token"] },
  { g: "面试与求职", kws: ["面试", "简历", "offer", "面经", "求职", "hr", "自我介绍", "薪资", "跳槽", "内推"] },
];

// 手写/算法专属强信号：topic 命中这些词 → 直接归"算法与手写"，**优先于知识树**
// 背景修复：frontend 知识树「浏览器原理·缓存策略」kws 含泛词"缓存"，会把"手撕LRU缓存"
// （手写 LRUCache 算法题）吸进浏览器原理——而"手写/手撕/LRU"是明确的手写题信号，
// 应与兜底规则的算法组竞争（甚至压过知识树的泛词命中），而不是被泛词抢先。
export const ALGO_HANDWRITE_STRONG: string[] = ["手撕", "手写", "大厂手写", "手写实现", "lru", "lfu"];

// LLM/Agent 领域强信号：topic 命中这些词 → 直接归"Agent与LLM"，**优先于知识树**
// 背景修复：LLM 基础与 Transformer 原理 被知识树吸到 CSS/HTML、AI Agent LLM 微调与量化部署
// 被吸到网络——LLM/Agent 是明确领域信号，不该被知识树泛词带偏（与 ALGO_HANDWRITE_STRONG 同理）。
// 注意：不含 "agent"（太泛——项目名 AgentChat 会被误吸；Agent 架构类条目靠兜底规则 agent 词归组）
export const LLM_AGENT_STRONG: string[] = ["llm", "大模型", "transformer", "微调", "量化", "langchain", "langgraph", "mcp", "embedding", "多模态", "function calling", "工具调用", "gpt", "prompt", "token", "rag", "检索增强"];

// ---------- 独立成词检测（统一层 match-utils：组合词表一处维护全局生效） ----------
// 背景：子串匹配无法区分词义——"技术栈"含"栈"、"消息队列"含"队列"、"知识树"含"树"。
// 组合词表/独立成词/特异性门槛已沉淀到 lib/match-utils.ts（7 个独立实现的公共层）。

// 分组归一（相似度引擎统一工单任务 5③ + 2026-09 扩展）：知识树分类名 vs 手动/兜底组名统一——
// RAG/Agent 相关组 + 浏览器/CSS/JS/手写碎片组全部映射到规范名
// （"JS 基础"是面经导入手动 group 的碎片名，知识树规范名是"JavaScript 核心"；"手写题"→"算法与手写"等）
const GROUP_ALIAS: Record<string, string> = {
  "RAG": "Agent与LLM", "Agent": "Agent与LLM", "Agent/LLM": "Agent与LLM", "LLM": "Agent与LLM", "AI Agent": "Agent与LLM", "RAG与LLM": "Agent与LLM",
  "JS 基础": "JavaScript 核心", "浏览器与网络": "浏览器原理", "CSS": "CSS/HTML", "手写题": "算法与手写",
};
const normGroup = (g: string): string => GROUP_ALIAS[g] || g;
/** 分组名归一（导出——addPlanItems 写入前归一，防碎片组进清单） */
export const normalizeGroupName: (g: string) => string = normGroup;

/** 归一化主题簇：手写/算法强信号（topic）→ 知识树分类（topic，按命中关键词数最多选点，避免泛词抢先）→ 知识树匹配 why（项目条目按技术栈归类）→ 兜底规则 → similarity 规则层 → 其他
 * grp/why 放宽为 unknown：调用方（LLM JSON / DB 行 / 调用入参）本就会传非字符串，函数体统一 String() 收口 */
export function normalizeGroup(topic: unknown, grp: unknown = "", why: unknown = ""): string {
  const t = String(topic || "").toLowerCase();
  const g = String(grp || "").toLowerCase();
  const w = String(why || "").toLowerCase();
  // 0) 手写/算法强信号优先：手撕/手写/LRU 等明确算法题信号不被知识树泛词误吸
  if (ALGO_HANDWRITE_STRONG.some((k) => t.includes(k))) return "算法与手写";
  // 0b) LLM/Agent 领域强信号优先：LLM/大模型/微调/量化 等明确领域信号不被知识树泛词带偏
  if (LLM_AGENT_STRONG.some((k) => t.includes(k))) return "Agent与LLM";
  // 1) 知识树：统计 topic 命中各知识点的关键词数，取命中最多且 ≥1 的（平局取遍历序）
  //    特异性门槛：该点"被命中的关键词"里必须至少有一个长词（中文长度≥3，如 http/事件循环/模板语法）
  //    背景修复：只靠"缓存/模板/锁"这类短泛词命中的点不可信——曾把"手撕LRU缓存"吸到
  //    浏览器（命中医术的"缓存"）、"面试自我介绍模板"吸到 Vue（命中"模板"）。短词命中
  //    时宁可落回兜底规则，也不被无关大类带偏。
  const treeHit = (text: string): string | null => {
    let best: { cat: string; hits: number } | null = null;
    for (const p of getAllPoints()) {
      // 知识树点来自 settings（运行时数据）：kws 未声明类型 → 显式 unknown[] 收口
      const kws: unknown[] = Array.isArray(p.kws) && p.kws.length ? p.kws : [p.title];
      const hitKws = kws.filter((k) => kwHit(text, String(k).toLowerCase()));
      if (!hitKws.length) continue;
      const specific = hasSpecificKw(hitKws); // 统一特异性门槛（中文 ≥3 字/英文 ≥4 字符）
      if (!specific) continue; // 只有短泛词命中 → 点不可信，跳过（避免误吸）
      if (!best || hitKws.length > best.hits) best = { cat: normGroup(p.categoryTitle), hits: hitKws.length };
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
    // 保留原分组但过 normGroup（碎片组名归一——"JS 基础"等手动 group → 规范名）
    return g ? normGroup(String(grp)) : "其他";
  }
  const catT = treeHit(t);
  if (catT) return catT;
  // 1b) 知识树匹配 why（项目类条目技术栈在 why）
  const catW = treeHit(w);
  if (catW) return catW;
  // 2) 兜底规则：topic + grp（独立成词检测：技术栈/消息队列/知识树 不触发"栈/队列/树"）
  for (const { g: name, kws } of EXTRA_GROUP_RULES) {
    if (kws.some((k) => kwHit(t, k) || kwHit(g, k))) return name;
  }
  // 3) why 辅助（跳过"面试与求职"与"算法与手写"——why 是技术栈/来源描述，
  //    "技术栈"含"栈"会被算法组误吸；算法题靠 topic 本身判定，不从 why 归类）
  for (const { g: name, kws } of EXTRA_GROUP_RULES) {
    if (name === "面试与求职" || name === "算法与手写") continue;
    if (kws.some((k) => kwHit(w, k))) return name;
  }
  // 4) 分类判定相似度引擎工单任务 1：similarity 规则层兜底（词表补全追不上新题——
  //    爬楼梯/两数相加/二分查找/LCR/螺旋矩阵 词表未覆盖 → 错分"其他"；similarity 对
  //    各组代表词做 weak 宽松判定（召回优先），命中即归组；结果缓存（幂等）
  const simG = similarityGroupRule(t);
  if (simG) return simG;
  return "其他";
}

// ---------- 分类判定相似度引擎工单任务 1：similarity 规则层兜底 ----------
// 各组代表词（组名 + 高频题词——覆盖词表外的新题形态）
const SIM_GROUP_REPS: Record<string, string[]> = {
  "算法与手写": ["算法", "手写", "排序", "链表", "二叉树", "动态规划", "双指针", "哈希", "递归", "数组", "字符串", "二分查找", "滑动窗口", "回溯", "贪心", "栈", "队列", "堆", "爬楼梯", "两数相加", "螺旋矩阵", "岛屿", "回文", "子序列", "全排列", "括号", "股票", "前缀和", "拓扑", "并查集", "单调栈", "kmp", "lru", "lfu", "topk", "中位数", "反转", "旋转", "去重", "背包", "组合", "路径", "矩阵", "二分", "dfs", "bfs", "最长", "无重复", "最佳时机", "三数之和", "递增子序列", "叶子节点", "差分", "mex", "asl"],
  "数据库": ["数据库", "索引", "事务", "SQL", "MySQL", "锁", "隔离", "B+树", "回表", "存储引擎", "主键", "外键", "优化器"],
  "Agent与LLM": ["大模型", "LLM", "Agent", "RAG", "Prompt", "微调", "向量", "Embedding", "MCP", "幻觉", "上下文", "Token", "LangChain", "多模态", "工具调用"],
  "面试与求职": ["面试", "简历", "求职", "面经", "Offer", "HR", "自我介绍", "薪资", "跳槽", "内推"],
};
const simGroupCache = new Map<string, string | null>(); // topic → group（幂等缓存——同 topic 不重复判定）
/** similarity 规则层判定（同步）：topic 与各组代表词 weak 宽松匹配，≥0.5 归组（取最高分） */
export function similarityGroupRule(topic: unknown): string | null {
  const t = String(topic || "").trim().toLowerCase();
  if (!t) return null;
  const cached = simGroupCache.get(t);
  if (cached !== undefined) return cached;
  let best: { g: string; score: number } | null = null;
  for (const [g, reps] of Object.entries(SIM_GROUP_REPS)) {
    for (const rep of reps) {
      const s = similarityRule(t, rep, "weak");
      if (s.score >= 0.5 && (!best || s.score > best.score)) best = { g, score: s.score };
    }
  }
  const result = best ? best.g : null;
  simGroupCache.set(t, result);
  return result;
}

/** 分类判定相似度引擎工单任务 1：async 版本（规则层 + LLM 模糊地带）——供异步调用方（addPlanItems 等）
 * 规则层未命中（"其他"）→ LLM 语义层判定"这个 topic 属于哪个组"（低频——模糊地带才触发） */
export async function normalizeGroupAsync(topic: unknown, grp: unknown = "", why: unknown = ""): Promise<string> {
  const sync = normalizeGroup(topic, grp, why);
  if (sync !== "其他") return sync;
  try {
    const { llmChat, getReplyText, extractJson } = await import("./llm.mjs");
    const data = await llmChat(
      [
        { role: "system", content: "你是学习清单分类助手。判断知识点属于哪个组，只输出 JSON。" },
        { role: "user", content: `知识点：${String(topic || "").slice(0, 100)}\n候选组：${Object.keys(SIM_GROUP_REPS).join("、")}\n输出：{"group":"组名"}` },
      ],
      { maxTokens: 200, temperature: 0, role: "classify" }
    );
    const parsed = extractJson(getReplyText(data)) as { group?: string } | null;
    if (parsed?.group && SIM_GROUP_REPS[parsed.group]) {
      simGroupCache.set(String(topic || "").trim().toLowerCase(), parsed.group);
      return parsed.group;
    }
  } catch { /* LLM 失败按其他 */ }
  return "其他";
}
