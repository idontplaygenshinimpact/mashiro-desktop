// 轻量语义缓存：讲解追问去重（零 LLM 请求命中已有回答）+ 前缀稳定性支持
// 背景：同一知识点用户可能反复追问相近问题（"再讲讲 X" vs "X 是什么"），每次追问都
//       重新调 LLM 浪费成本。本模块把存档里的历史追问段落建成索引，新追问语义相似
//       （bigram Jaccard）即直接返回已有回答。
// 零依赖：不引入 embedding/向量库——追问通常较短（<100 字），字符 bigram 相似度足够
//         且快（O(n*m)，n/m 为问题长度，全量对比最多几十条历史也毫秒级）。
// 全量 TS 升级工单阶段 3：lib/followup-cache.mjs → .ts（4 处调用方，保 .mjs 一行桶零改动）
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { studyNotesDir, sanitizeFilename } from "./study-files.ts";
import { similarityRule } from "./similarity.ts"; // 相似度引擎统一工单：追问缓存走 semantic 严格度

/** 一条历史追问（问题 + 回答） */
export interface Followup {
  question: string;
  answer: string;
}

/** 语义命中结果（相似度分数由 similarityRule 给出） */
export interface FollowupHit {
  question: string;
  answer: string;
  similarity: number;
}

// ---------- 追问段落解析 ----------
// 存档格式：`## 💬 追问：<问题>\n\n<回答>`，段落间以 `---` 分隔（routes/study.mjs 追加格式）
const FOLLOWUP_RE = /##\s*💬\s*追问[：:]\s*([^\n]+)\n+([\s\S]*?)(?=\n---|\n##\s|$)/g;

/** 从讲解存档文本中提取所有追问段落：[{ question, answer }] */
export function parseFollowups(text: unknown): Followup[] {
  const out: Followup[] = [];
  if (!text) return out;
  for (const m of String(text).matchAll(FOLLOWUP_RE)) {
    const question = String(m[1] || "").trim();
    const answer = String(m[2] || "").trim();
    if (question) out.push({ question, answer });
  }
  return out;
}

/** 读取某 topic 的讲解存档（study_notes/{sanitizeFilename(topic)}.md），返回追问段落列表 */
export function loadFollowupCache(topic: unknown): Followup[] {
  const f = path.join(studyNotesDir(), `${sanitizeFilename(topic)}.md`);
  if (!existsSync(f)) return [];
  try { return parseFollowups(readFileSync(f, "utf8")); } catch { return []; }
}

// ---------- 语义相似度（字符 bigram Jaccard + 编辑距离归一化，中文友好、零依赖） ----------
function bigrams(s: unknown): Set<string> {
  const set = new Set<string>();
  const t = String(s || "").toLowerCase();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** Jaccard 相似度：两字符串字符 bigram 集合交集/并集（0-1） */
export function bigramJaccard(a: unknown, b: unknown): number {
  const sa = bigrams(a), sb = bigrams(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 编辑距离（DP，限制最大距离防长文本 O(n*m) 爆表） */
export function levenshtein(a: unknown, b: unknown, cap = 10): number {
  const s = String(a || ""), t = String(b || "");
  if (Math.abs(s.length - t.length) > cap) return cap + 1;
  const m = s.length, n = t.length;
  if (!m) return n; if (!n) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 归一化编辑距离相似度：1 - dist/maxLen（0-1，短中文文本比 bigram Jaccard 稳健）
 * 长度差超过 cap 时编辑距离不可信：levenshtein 提前返回 cap+1=13，1-13/maxLen 是
 * 与内容无关的假高分（1-13/65=0.8 恒成立，任何长度差>12 的无关文本对都 ≥0.72 命中）。
 * → 长度差 > cap 时退化为 bigram Jaccard（纯内容重叠度量）。
 * （上一版用"长度比 <0.4"判定有盲区：40 字 vs 65 字长度比 61% 仍触发假 0.8——本次回归教训） */
export function editSimilarity(a: unknown, b: unknown): number {
  const sa = normalizeQuestion(a), sb = normalizeQuestion(b);
  const maxLen = Math.max(sa.length, sb.length);
  if (!maxLen) return 1;
  if (Math.abs(sa.length - sb.length) > 12) return bigramJaccard(sa, sb);
  return 1 - levenshtein(sa, sb, 12) / maxLen;
}

// ---------- 追问去重匹配 ----------
/** 归一化：去空白/标点/语气词，用于相似度前清洗 */
export function normalizeQuestion(q: unknown): string {
  return String(q || "")
    .toLowerCase()
    .replace(/[\s，。？！、：；,.?!:;'"“”‘’（）()【】[\]<>《》\-_/\\|·~～+*=]/g, "")
    .slice(0, 80);
}

/**
 * 找语义相似的历史追问：命中返回 { question, answer, similarity }，否则 null
 * 相似度引擎统一工单：委托 similarityRule(semantic)——否定/角度/短问长历史拦截集中
 * （"为什么用 vs 为什么不用"、"原理 vs 边界"、"activeEffect vs 副作用函数长句"不再误命中）
 */
export function findSimilarFollowup(question: unknown, followups: Followup[], threshold = 0.72): FollowupHit | null {
  const q = normalizeQuestion(question);
  if (!q) return null;
  // 短句门槛（2026-08 排查）：归一化后 <4 字的问题无信息量（"是/好/嗯/再讲讲"），
  // bigram/编辑距离对短句天然高分——"是"与"是不是"相似度 0.8+ 会误命中历史回答
  if (q.length < 4) return null;
  let best: FollowupHit | null = null;
  for (const f of followups) {
    const fq = normalizeQuestion(f.question);
    if (!fq || fq.length < 4) continue; // 历史短句同样不参与匹配
    const r = similarityRule(question as string, f.question, "semantic");
    if (!r.similar) continue;
    if (r.score >= threshold && (!best || r.score > best.similarity)) {
      best = { question: f.question, answer: f.answer, similarity: r.score };
    }
  }
  return best;
}

/**
 * 一站式查询：给定 topic + 新追问 → 若历史存档有语义相似追问，返回命中（含答案）；
 * 未命中返回 null（调用方走正常 LLM 追问）
 * 讲解追问交互增强工单第二步 B2②：ref 参数（引用段落）——缓存键含引用——
 * 同一问题引用不同段落是不同语义，防命中错误缓存；无引用追问保持原键（兼容）
 * @param topic 知识点名
 * @param question 用户新追问
 * @param threshold 相似度阈值（0-1）
 * @param ref 引用段落（有引用时要求历史追问同引用才命中）
 */
export function queryFollowupCache(
  topic: unknown,
  question: unknown,
  threshold = 0.72,
  ref: { text: string; source: string } | null = null,
): (FollowupHit & { fromCache: true }) | null {
  const followups = loadFollowupCache(topic);
  if (!followups.length) return null;
  // 引用段落参与匹配：历史追问的 ref 标注（存档追问段头部 <!-- ref:... -->）与当前引用一致才命中
  if (ref?.text) {
    const refKey = normalizeQuestion(ref.text).slice(0, 40);
    const sameRef = followups.filter((f) => {
      const fRef = String(f.answer || "").match(/<!--\s*ref:([^\n]+?)\s*-->/);
      return Boolean(fRef) && normalizeQuestion(fRef![1]).slice(0, 40) === refKey;
    });
    if (sameRef.length) {
      const hit = findSimilarFollowup(question, sameRef, threshold);
      if (hit) return { ...hit, fromCache: true };
    }
    return null; // 有引用但历史无同引用追问 → 不命中（防错误缓存）
  }
  const hit = findSimilarFollowup(question, followups, threshold);
  if (!hit) return null;
  return { ...hit, fromCache: true };
}
