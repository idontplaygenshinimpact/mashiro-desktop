// 轻量语义缓存：讲解追问去重（零 LLM 请求命中已有回答）+ 前缀稳定性支持
// 背景：同一知识点用户可能反复追问相近问题（"再讲讲 X" vs "X 是什么"），每次追问都
//       重新调 LLM 浪费成本。本模块把存档里的历史追问段落建成索引，新追问语义相似
//       （bigram Jaccard）即直接返回已有回答。
// 零依赖：不引入 embedding/向量库——追问通常较短（<100 字），字符 bigram 相似度足够
//         且快（O(n*m)，n/m 为问题长度，全量对比最多几十条历史也毫秒级）。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { studyNotesDir, sanitizeFilename } from "./study-files.mjs";

// ---------- 追问段落解析 ----------
// 存档格式：`## 💬 追问：<问题>\n\n<回答>`，段落间以 `---` 分隔（routes/study.mjs 追加格式）
const FOLLOWUP_RE = /##\s*💬\s*追问[：:]\s*([^\n]+)\n+([\s\S]*?)(?=\n---|\n##\s|$)/g;

/** 从讲解存档文本中提取所有追问段落：[{ question, answer }] */
export function parseFollowups(text) {
  const out = [];
  if (!text) return out;
  for (const m of String(text).matchAll(FOLLOWUP_RE)) {
    const question = String(m[1] || "").trim();
    const answer = String(m[2] || "").trim();
    if (question) out.push({ question, answer });
  }
  return out;
}

/** 读取某 topic 的讲解存档（study_notes/{sanitizeFilename(topic)}.md），返回追问段落列表 */
export function loadFollowupCache(topic) {
  const f = path.join(studyNotesDir(), `${sanitizeFilename(topic)}.md`);
  if (!existsSync(f)) return [];
  try { return parseFollowups(readFileSync(f, "utf8")); } catch { return []; }
}

// ---------- 语义相似度（字符 bigram Jaccard + 编辑距离归一化，中文友好、零依赖） ----------
function bigrams(s) {
  const set = new Set();
  const t = String(s || "").toLowerCase();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** Jaccard 相似度：两字符串字符 bigram 集合交集/并集（0-1） */
export function bigramJaccard(a, b) {
  const sa = bigrams(a), sb = bigrams(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 编辑距离（DP，限制最大距离防长文本 O(n*m) 爆表） */
export function levenshtein(a, b, cap = 10) {
  const s = String(a || ""), t = String(b || "");
  if (Math.abs(s.length - t.length) > cap) return cap + 1;
  const m = s.length, n = t.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
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
 * 长度悬殊时编辑距离被 cap 扭曲成假高分：levenshtein 提前返回 cap+1=13，
 * 1-13/65=0.8 对任意无关短问题恒成立（"今天天气怎么样" 也能命中历史长问题）。
 * → 短文本 < 长文本 40% 时退化为 bigram Jaccard（纯内容重叠度量）。 */
export function editSimilarity(a, b) {
  const sa = normalizeQuestion(a), sb = normalizeQuestion(b);
  const maxLen = Math.max(sa.length, sb.length);
  if (!maxLen) return 1;
  if (Math.min(sa.length, sb.length) / maxLen < 0.4) return bigramJaccard(sa, sb);
  return 1 - levenshtein(sa, sb, 12) / maxLen;
}

// ---------- 追问去重匹配 ----------
/** 归一化：去空白/标点/语气词，用于相似度前清洗 */
export function normalizeQuestion(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[\s，。？！、：；,.?!:;'"“”‘’（）()【】[\]<>《》\-_/\\|·~～+*=]/g, "")
    .slice(0, 80);
}

/**
 * 找语义相似的历史追问：命中返回 { question, answer, similarity }，否则 null
 * 判定（短中文追问用编辑距离归一化更稳，bigram 只作辅助）：
 *   - 归一化后完全相等 → 1.0
 *   - 互为子串 → 0.95
 *   - 编辑距离相似度 ≥ 阈值（默认 0.72）→ 该值
 */
export function findSimilarFollowup(question, followups, threshold = 0.72) {
  const q = normalizeQuestion(question);
  if (!q) return null;
  let best = null;
  for (const f of followups) {
    const fq = normalizeQuestion(f.question);
    if (!fq) continue;
    let sim;
    if (fq === q) sim = 1;
    else if (fq.includes(q) || q.includes(fq)) sim = 0.95;
    else sim = Math.max(editSimilarity(fq, q), bigramJaccard(fq, q) * 0.8);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { question: f.question, answer: f.answer, similarity: sim };
    }
  }
  return best;
}

/**
 * 一站式查询：给定 topic + 新追问 → 若历史存档有语义相似追问，返回命中（含答案）；
 * 未命中返回 null（调用方走正常 LLM 追问）
 * @param {string} topic 知识点名
 * @param {string} question 用户新追问
 * @param {number} [threshold] 相似度阈值（0-1）
 * @returns {{question: string, answer: string, similarity: number, fromCache: true} | null}
 */
export function queryFollowupCache(topic, question, threshold = 0.72) {
  const followups = loadFollowupCache(topic);
  if (!followups.length) return null;
  const hit = findSimilarFollowup(question, followups, threshold);
  if (!hit) return null;
  return { ...hit, fromCache: true };
}
