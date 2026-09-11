// 相似度引擎统一工单：分层判定（规则层确定性 + LLM 语义层模糊兜底）
// 背景：相似度判定打补丁史（泛词 3-gram → 结构词 → 变体词 → 否定/角度 → 分组）——
// 规则散落 4 模块、互相冲突、无回归保护。本文件统一收编，调用方传严格度：
//   weak     —— 薄弱点合并（宽松：表述漂移去重）
//   strict   —— 讲解复用/清单去重（严格：防张冠李戴）
//   semantic —— 追问缓存（否定/角度/核心词 + 短问不命中长历史）
// 返回 { similar, score, reason, layer: "rule"|"llm" }（可解释）
// 方案决策：跳过 embedding 层（细粒度区分是向量相似度已知短板 + 800MB 成本）——
// 规则 + LLM 分层是业界标准组合的务实版。
// 全量 TS 升级工单阶段 1①：lib/similarity.mjs → .ts（node 22 type stripping 直接运行；纯函数多、
// 被 memory/rag/study 引用——先迁它下游受益。JSDoc @param 在 .ts 不生效，改显式注解）
import { editSimilarity, bigramJaccard } from "./followup-cache.ts"; // semantic 编辑距离（纯函数，无循环；TS 迁移后直连 .ts 不走桶）

/** 严格度：weak 薄弱点合并 / strict 讲解复用 / semantic 追问缓存 */
export type SimMode = "weak" | "strict" | "semantic";
/** 规则层判定结果（fuzzy 标记 = 落在模糊区间，async 入口可再走 LLM） */
export interface RuleResult { similar: boolean; score: number; reason: string; layer: "rule"; fuzzy?: boolean }
/** 统一判定结果（layer 标明结论来自规则层还是 LLM 语义层） */
export interface SimResult { similar: boolean; score: number; reason: string; layer: "rule" | "llm" }
/** 硬判结果（hit=false 时 reason 无意义） */
interface Mismatch { hit: boolean; reason?: string }

// ---------- 词表集中（不再散落） ----------
// 泛词 3-gram：共享不代表知识点相似（"NSP 与 MLM 的区别" vs "LangChain 和 LangGraph 的区别和应用"）
export const GENERIC_3GRAM = new Set(["的区别", "的原理", "的应用", "是什么", "怎么用", "如何用", "常见问题", "的理解", "有哪些"]);
// 数据结构词：不同结构 → 解法不同（"合并有序链表" vs "合并有序数组"）
export const STRUCT_WORDS = ["二叉树", "链表", "数组", "哈希表", "队列", "栈", "图", "堆", "字符串", "矩阵", "集合", "字典", "树"];
// 变体词：同一题的不同变体（"层序遍历" vs "锯齿形层序遍历"——解法不同）
export const VARIANT_WORDS = ["层序", "前序", "中序", "后序", "锯齿", "螺旋", "之字形", "反转", "原地", "递归", "迭代", "非递归", "有序", "无序", "左视图", "右视图", "循环", "递归实现"];
// 否定词（semantic）：语义相反（"为什么用" vs "为什么不用"）
export const NEGATION_WORDS = ["不用", "不要", "避免", "禁止", "不能", "无法", "失败", "错误"];
// 角度词（semantic）：不同考察角度（"原理" vs "边界"）
export const ANGLE_WORDS = ["原理", "边界", "场景", "区别", "优缺点", "对比", "实现", "应用", "流程", "性能"];
// 语气词（semantic）：归一化时剔除（"再讲讲" vs "讲讲"）
export const TONE_WORDS = ["再讲讲", "讲讲", "详细", "具体", "一下", "请", "帮我", "能不能", "可以"];

// ---------- 归一化 ----------
/** 中文连续段提取（去标点/英文/数字/空格——相似度基于中文内容） */
export function zhText(s: unknown): string {
  return String(s || "").replace(/[^\u4e00-\u9fff]+/g, "");
}
/** 追问归一化（semantic：去空白/标点/语气词，小写） */
export function normalizeQuestion(q: unknown): string {
  return String(q || "")
    .toLowerCase()
    .replace(/[\s，。？！、：；,.?!:;'"“”‘’（）()【】[\]<>《》\-_/\\|·~～+*=]/g, "")
    .replace(new RegExp(`(${TONE_WORDS.join("|")})`, "g"), "")
    .slice(0, 80);
}

// ---------- L1：归一化相等 ----------
function normEqual(a: unknown, b: unknown): boolean {
  const za = zhText(a), zb = zhText(b);
  // 空中文串（全英文/数字）不判相等；<4 字不判（与现有 short<4 门槛一致——"点0" vs "点1" 归一化都是"点"）
  return za.length >= 4 && za === zb;
}

// ---------- L2：结构词/变体词硬判 ----------
function structOf(s: string): string | null {
  for (const w of STRUCT_WORDS) if (s.includes(w)) return w; // 最长优先（二叉树 在 树 前）
  return null;
}
function variantOf(s: string): string[] | null {
  const hits = VARIANT_WORDS.filter((w) => s.includes(w));
  return hits.length ? hits : null;
}
/** 结构词/变体词不同 → 硬不相似（层序 vs 前序/锯齿——解法不同） */
function hardMismatch(a: string, b: string): Mismatch {
  const sa = structOf(a), sb = structOf(b);
  if (sa && sb && sa !== sb) return { hit: true, reason: `结构词不同（${sa} vs ${sb}）` };
  const va = variantOf(a), vb = variantOf(b);
  if (va && vb) {
    // 双向检查：任一方有对方没有的变体词 → 硬不相似（"层序遍历" vs "锯齿形层序遍历"——锯齿是变体）
    const diffAB = va.filter((w) => !vb.includes(w));
    const diffBA = vb.filter((w) => !va.includes(w));
    if (diffAB.length || diffBA.length) return { hit: true, reason: `变体词不同（${[...diffAB, ...diffBA].join("/")}）` };
  }
  if (va && !vb) return { hit: true, reason: `变体词差异（${va.join("/")}）` };
  if (vb && !va) return { hit: true, reason: `变体词差异（${vb.join("/")}）` };
  return { hit: false };
}

// ---------- L3：内容重叠（3-gram 强相似 + 2-gram 重叠率） ----------
function grams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}
/** 2-gram 重叠率：短者 2-gram 在长者中的比例（0-1）；短者 <4 字 → 0（与现有 short<4 门槛一致——
 * "可信点" vs "不可信点" 3 字内不判——防 untrusted 误并） */
export function gramOverlap(a: unknown, b: unknown): number {
  const za = zhText(a), zb = zhText(b);
  if (!za || !zb) return 0;
  const [short, long] = za.length <= zb.length ? [za, zb] : [zb, za];
  if (short.length < 4) return 0;
  const g2s = grams(short, 2), g2l = grams(long, 2);
  let overlap = 0;
  for (const x of g2s) if (g2l.has(x)) overlap++;
  return overlap / g2s.size;
}
/** 3-gram 强相似：共享有意义 3-gram（排除泛词） */
export function strongGram3(a: unknown, b: unknown): boolean {
  const za = zhText(a), zb = zhText(b);
  if (!za || !zb) return false;
  const [short, long] = za.length <= zb.length ? [za, zb] : [zb, za];
  if (short.length < 4) return false;
  const g3s = grams(short, 3), g3l = grams(long, 3);
  return [...g3s].some((x) => g3l.has(x) && !GENERIC_3GRAM.has(x));
}
/** 共享 3-gram 但全是泛词 → 不相似（"NSP 与 MLM 的区别" vs "LangChain 和 LangGraph 的区别和应用"——
 * 共享"的区别"不代表知识点相似；现有 isSimilarWeakTopic 同规则：泛词共享直接判否） */
export function genericGram3Shared(a: unknown, b: unknown): boolean {
  const za = zhText(a), zb = zhText(b);
  if (!za || !zb) return false;
  const [short, long] = za.length <= zb.length ? [za, zb] : [zb, za];
  if (short.length < 4) return false;
  const g3s = grams(short, 3), g3l = grams(long, 3);
  const shared = [...g3s].filter((x) => g3l.has(x));
  return shared.length > 0 && shared.every((x) => GENERIC_3GRAM.has(x));
}

// ---------- semantic：否定/角度/短问长历史 ----------
/** semantic 硬判：否定词/角度词差异 → 不相似（追问缓存防误命中） */
function semanticMismatch(a: string, b: string): Mismatch {
  const na = NEGATION_WORDS.filter((w) => a.includes(w));
  const nb = NEGATION_WORDS.filter((w) => b.includes(w));
  if (na.length && !nb.length) return { hit: true, reason: `否定词差异（${na.join("/")}）` };
  if (nb.length && !na.length) return { hit: true, reason: `否定词差异（${nb.join("/")}）` };
  const aa = ANGLE_WORDS.filter((w) => a.includes(w));
  const ab = ANGLE_WORDS.filter((w) => b.includes(w));
  if (aa.length && ab.length) {
    const diff = aa.filter((w) => !ab.includes(w));
    if (diff.length) return { hit: true, reason: `角度词不同（${diff.join("/")}）` };
  }
  return { hit: false };
}

// ---------- LLM 语义层（模糊地带兜底） ----------
// 缓存：同 topic 对判定结果（幂等，防重复调 LLM）
const llmCache = new Map<string, { similar: boolean; reason: string }>();
/** 清空 LLM 判定缓存（测试隔离用） */
export function clearSimilarityLlmCache(): void { llmCache.clear(); }
/**
 * 模糊地带 LLM 判定："这两个是同一知识点吗"（是/否 + 理由）
 * 失败降级：LLM 不可用 → 不相似（保守——防误命中优先）
 * @param a 知识点 A
 * @param b 知识点 B
 * @param ctx 上下文（来源/类型）
 */
export async function llmSimilarity(a: string, b: string, ctx = ""): Promise<{ similar: boolean; reason: string }> {
  const key = `${a}\u0000${b}`;
  const cached = llmCache.get(key);
  if (cached) return cached;
  try {
    const { llmChat, getReplyText, extractJson } = await import("./llm.mjs");
    const data = await llmChat(
      [
        { role: "system", content: "你是知识点判定助手。只输出合法 JSON。" },
        { role: "user", content: `判断下面两个知识点/追问是否指向同一知识点（同一道题/同一个概念）。
规则：变体不同（层序 vs 锯齿层序）、语义相反（为什么用 vs 为什么不用）、角度不同（原理 vs 边界）→ 不是同一知识点。
${ctx ? `上下文：${ctx}\n` : ""}
A：${a}
B：${b}
只输出 JSON：{"similar":true|false,"reason":"一句话理由"}` },
      ],
      { maxTokens: 200, temperature: 0, role: "similarity" }
    );
    const parsed = extractJson(getReplyText(data)) as { similar?: unknown; reason?: unknown } | null;
    const similar = parsed?.similar === true;
    const result = { similar, reason: String(parsed?.reason || "").slice(0, 80) };
    llmCache.set(key, result);
    return result;
  } catch {
    // 降级：LLM 不可用 → 不相似（保守——防误命中优先）
    return { similar: false, reason: "LLM 不可用，保守判不相似" };
  }
}

// ---------- 统一入口 ----------
/**
 * 同步规则层（weak/strict/semantic 不走 LLM——同步调用方用；模糊区间返回 similar:false + fuzzy 标记）
 * @param a 知识点/追问 A
 * @param b 知识点/追问 B
 * @param mode 严格度
 */
export function similarityRule(a: unknown, b: unknown, mode: SimMode = "strict"): RuleResult {
  const A = String(a || "").trim(), B = String(b || "").trim();
  if (!A || !B) return { similar: false, score: 0, reason: "空输入", layer: "rule" };
  if (A === B) return { similar: true, score: 1, reason: "完全相等", layer: "rule" };
  // L1 归一化相等
  if (normEqual(A, B)) return { similar: true, score: 1, reason: "归一化相等", layer: "rule" };
  // semantic：否定/角度硬判（追问缓存）
  if (mode === "semantic") {
    const sm = semanticMismatch(A, B);
    if (sm.hit) return { similar: false, score: 0, reason: sm.reason || "", layer: "rule" };
  }
  // L2 结构词/变体词硬判
  const hm = hardMismatch(A, B);
  if (hm.hit) return { similar: false, score: 0, reason: hm.reason || "", layer: "rule" };
  // L2b 泛词 3-gram 共享 → 不相似（"的区别"共享不代表知识点相似）
  if (genericGram3Shared(A, B)) return { similar: false, score: 0, reason: "仅泛词 3-gram 共享", layer: "rule" };
  // L3 内容重叠
  const strong = strongGram3(A, B);
  const overlap = gramOverlap(A, B);
  if (mode === "weak") {
    // 薄弱点合并（宽松）：3-gram 强相似 或 2-gram ≥0.5 → 相似
    if (strong) return { similar: true, score: Math.max(0.6, overlap), reason: "3-gram 强相似（weak）", layer: "rule" };
    if (overlap >= 0.5) return { similar: true, score: overlap, reason: `2-gram 重叠 ${overlap.toFixed(2)}（weak 宽松）`, layer: "rule" };
    return { similar: false, score: overlap, reason: `2-gram 重叠 ${overlap.toFixed(2)} 不足（weak）`, layer: "rule" };
  }
  if (mode === "strict") {
    // 讲解复用（严格）：2-gram ≥0.6 相似（现有验证值）；0.5-0.6 模糊（同步降级 false，async 走 LLM）；<0.5 不相似
    if (overlap >= 0.6) return { similar: true, score: overlap, reason: `2-gram 重叠 ${overlap.toFixed(2)}（strict）`, layer: "rule" };
    if (overlap < 0.5) return { similar: false, score: overlap, reason: `2-gram 重叠 ${overlap.toFixed(2)} 不足（strict）`, layer: "rule" };
    return { similar: false, score: overlap, reason: "模糊区间（0.5-0.6）——同步降级保守不相似", layer: "rule", fuzzy: true };
  }
  // semantic：编辑距离 + bigram（追问缓存——短问不命中长历史）
  const qa = normalizeQuestion(A), qb = normalizeQuestion(B);
  if (qa.length < 4 || qb.length < 4) return { similar: false, score: 0, reason: "短问无信息量", layer: "rule" };
  if (qa === qb) return { similar: true, score: 1, reason: "归一化相等（semantic）", layer: "rule" };
  if (qa.includes(qb) || qb.includes(qa)) return { similar: true, score: 0.95, reason: "互为子串（semantic）", layer: "rule" };
  // 短问不命中长历史：长度差大 → 不相似（activeEffect vs 副作用函数长句）
  if (Math.abs(qa.length - qb.length) > 12) return { similar: false, score: 0, reason: "长度差过大（短问不命中长历史）", layer: "rule" };
  const sim = Math.max(editSimilarity(qa, qb), bigramJaccard(qa, qb) * 0.8);
  return { similar: sim >= 0.72, score: sim, reason: `编辑距离相似 ${sim.toFixed(2)}（semantic）`, layer: "rule" };
}

/**
 * 相似度判定（统一引擎，async——模糊区间走 LLM 语义层）
 * @param a 知识点/追问 A
 * @param b 知识点/追问 B
 * @param mode 严格度
 * @param opts ctx 上下文（来源/类型）；useLlm=false 时模糊区间直接降级为不相似
 */
export async function similarity(
  a: unknown,
  b: unknown,
  mode: SimMode = "strict",
  { ctx = "", useLlm = true }: { ctx?: string; useLlm?: boolean } = {}
): Promise<SimResult> {
  const r = similarityRule(a, b, mode);
  if (!r.fuzzy) return r;
  // 模糊区间（strict 0.5-0.6）→ LLM 语义层
  if (mode === "strict" && useLlm) {
    const llm = await llmSimilarity(String(a || "").trim(), String(b || "").trim(), ctx);
    return { similar: llm.similar, score: r.score, reason: llm.reason || "LLM 判定", layer: "llm" };
  }
  return r;
}
