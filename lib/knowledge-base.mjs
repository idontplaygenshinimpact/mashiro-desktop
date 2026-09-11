// 个人学习知识库工单任务 1：段落级索引 + 混合检索（BM25 + 向量 + RRF）
// 定位变化：agent 检索工具（被抛弃）→ 用户学习知识库（用户主动检索 + 复习消费，默认开）
// 段落级：讲解文档（study_notes/{topic}.md）主文按标题切段 + 追问按 💬 标记切段——
// 追问 = 用户亲手标注的知识缺口 = 检索/复习的高价值信号（followup 段落加权）
// 混合检索：FTS5 trigram BM25 + bge-small-zh 向量余弦 → RRF 融合（只看排名，分数不可直接比较）
// 向量存储：SQLite 列存 + 内存数组暴力扫描（2000+ 段落 <10ms——ANN 是 10 万+ 规模才需要，P2）
import { db } from "./db.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { studyNotesDir } from "./study-files.ts";

const DATA_DIR = process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "data");

// ---------- transformers.js 运行环境（向量腿 + 精排腿共用） ----------
// 坑（2026-09-11 实测定位）：@xenova/transformers 默认远端是 huggingface.co，国内直连 `fetch failed`
// → pipeline() 抛错被下面的 catch 吞掉 → **向量腿/精排静默失效**，混合检索悄悄退化成纯关键词
// （kb-eval 实测：1478 段索引全部 vector = NULL，而检索仍"正常返回"）。两处修正：
//   1) 远端支持镜像：MIANSHI_HF_ENDPOINT，或标准 HF_ENDPOINT（https://hf-mirror.com/ 实测 6.2s 可用）；
//   2) 缓存目录显式落到 <data>/models/transformers —— 默认是 cwd 相对的 `.cache`，会在仓库根留垃圾。
/**
 * 把远端/缓存配置写进 transformers.js 的 env（纯函数，便于测试；未配置镜像时不覆盖默认远端）
 * @param {Record<string, any>} env transformers 的 env 对象
 * @param {Record<string, string | undefined>} [envVars] 环境变量（默认 process.env）
 * @returns {{ cacheDir: string, remoteHost: string }} 生效后的配置
 */
export function applyTransformersEnv(env, envVars = process.env) {
  env.cacheDir = path.join(DATA_DIR, "models", "transformers");
  const endpoint = String(envVars.MIANSHI_HF_ENDPOINT || envVars.HF_ENDPOINT || "").trim();
  if (endpoint) env.remoteHost = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return { cacheDir: env.cacheDir, remoteHost: env.remoteHost || "https://huggingface.co/" };
}

/** 加载 transformers 模型（先应用 env 配置——向量与精排共用） */
async function loadModel(task, model, opts) {
  const { pipeline, env } = await import("@xenova/transformers");
  applyTransformersEnv(env);
  return pipeline(task, model, opts);
}

// ---------- DB 结构 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_paragraphs (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,       -- 来源文档（study_notes/{topic}.md 的 topic）
  section TEXT,               -- 段落标题（主文：## 标题；追问：💬 追问：<问题>）
  kind TEXT NOT NULL,         -- main=主文段 / followup=追问段（用户亲手问的 = 高价值）
  content TEXT NOT NULL,
  seq INTEGER NOT NULL,       -- 文档内段落序号
  vector BLOB,                -- Float32Array 序列化（4B/元素）
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kp_doc ON knowledge_paragraphs(doc_id);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_paragraphs_fts USING fts5(id UNINDEXED, content, tokenize='trigram');
`);

const MTIMES_KEY = "kb_paragraph_mtimes";

// ---------- 段落切分 ----------
// 主文按 markdown 标题（## / ###）切段；追问段按 "## 💬 追问" 标记切（splitExplain 先例）
const FOLLOWUP_RE = /##\s*💬\s*追问[：:]\s*([^\n]+)\n+([\s\S]*?)(?=\n---|\n##\s|$)/g;

/** 讲解文档 → 段落列表 [{ section, kind, content }]（主文按标题 + 追问按 💬 标记） */
export function splitStudyNote(text) {
  const out = [];
  const t = String(text || "");
  // 1) 追问段（先切——主文切分时排除）
  const followups = [];
  const mainParts = [];
  let last = 0;
  for (const m of t.matchAll(FOLLOWUP_RE)) {
    mainParts.push(t.slice(last, m.index));
    followups.push({ section: `💬 追问：${String(m[1] || "").trim()}`, kind: "followup", content: String(m[2] || "").trim() });
    last = m.index + m[0].length;
  }
  mainParts.push(t.slice(last));
  // 2) 主文按标题切段
  for (const part of mainParts) {
    const sections = part.split(/\n(?=#{2,3}\s)/);
    for (const sec of sections) {
      const secTitle = (sec.match(/^#{1,3}\s+(.+)$/m) || [])[1]?.trim() || "";
      const content = sec.trim();
      if (content.length < 40) continue; // 过短段落跳过（标题行/空壳）
      out.push({ section: secTitle, kind: "main", content });
    }
  }
  // 3) 追问段追加（保持文档顺序）
  for (const f of followups) {
    if (f.content.length >= 20) out.push(f);
  }
  return out;
}

// ---------- 增量索引（mtime + 段落数变化判断——复用 rag.mjs 增量模式） ----------
function getIndexedMtimes() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(MTIMES_KEY);
    return row ? JSON.parse(String(row.value)) : {};
  } catch { return {}; }
}

/** 增量索引 study_notes 文档（mtime + 段落数变化才重刷） */
export function indexStudyNotes() {
  const dir = studyNotesDir();
  const mtimes = getIndexedMtimes();
  const newMtimes = {};
  let added = 0, removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const p = path.join(dir, name);
      let mtime = 0, size = 0;
      try { const st = statSync(p); mtime = st.mtimeMs; size = st.size; } catch { continue; }
      const docId = name.replace(/\.md$/, "");
      newMtimes[docId] = { m: mtime, s: size };
      const rec = mtimes[docId];
      const unchanged = rec && rec.m === mtime && rec.s === size;
      if (unchanged) continue;
      // 重刷该文档段落（删旧插新）
      try {
        db.prepare("DELETE FROM knowledge_paragraphs WHERE doc_id=?").run(docId);
        db.prepare("DELETE FROM knowledge_paragraphs_fts WHERE id IN (SELECT id FROM knowledge_paragraphs WHERE doc_id=?)").run(docId);
      } catch { /* ignore */ }
      const text = readFileSync(p, "utf8");
      const paras = splitStudyNote(text);
      const now = Date.now();
      const ins = db.prepare("INSERT OR REPLACE INTO knowledge_paragraphs (id, doc_id, section, kind, content, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const insFts = db.prepare("INSERT OR REPLACE INTO knowledge_paragraphs_fts (id, content) VALUES (?, ?)");
      paras.forEach((pa, i) => {
        const id = `kp_${docId}_${i}`;
        ins.run(id, docId, pa.section, pa.kind, pa.content, i, now);
        insFts.run(id, pa.content);
      });
      added += paras.length;
    }
    // 已删除文档：清理残留
    for (const docId of Object.keys(mtimes)) {
      if (newMtimes[docId]) continue;
      try {
        db.prepare("DELETE FROM knowledge_paragraphs WHERE doc_id=?").run(docId);
        db.prepare("DELETE FROM knowledge_paragraphs_fts WHERE id IN (SELECT id FROM knowledge_paragraphs WHERE doc_id=?)").run(docId);
        removed++;
      } catch { /* ignore */ }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(MTIMES_KEY, JSON.stringify(newMtimes), Date.now());
  } catch { /* 目录不可用忽略 */ }
  return { added, removed };
}

// ---------- 向量化（bge-small-zh-v1.5，transformers.js——惰性加载，首次检索才加载） ----------
let embedder = null; // 缓存常驻（用户主动用知识库，反复检索是预期行为）
let embedderLoading = null;
async function getEmbedder() {
  if (embedder) return embedder;
  if (!embedderLoading) {
    embedderLoading = (async () => {
      // 量化版（~100MB 可控——bge-m3 800MB 教训）；失败降级 null（BM25 兜底）
      embedder = await loadModel("feature-extraction", "Xenova/bge-small-zh-v1.5", { quantized: true });
      return embedder;
    })().catch(() => { embedder = null; return null; });
  }
  return embedderLoading;
}

/** 文本 → 向量（Float32Array；失败返回 null——BM25 兜底） */
async function embedText(text) {
  try {
    const model = await getEmbedder();
    if (!model) return null;
    const out = await model(String(text || "").slice(0, 500), { pooling: "mean", normalize: true });
    return Float32Array.from(out.data);
  } catch { return null; }
}

// ---------- 向量回填（2026-09-11 补：此前向量列只读不写 → 混合检索实际退化成纯关键词） ----------
// 背景：indexStudyNotes 只写段落 + FTS，从不写 vector 列，而 vectorSearch 查的是
// `WHERE vector IS NOT NULL` → 永远空集，RRF 融合只剩 BM25 一路（kb-eval 实测 1478 段全 NULL，
// 但检索照常返回结果、不报错，所以这个洞藏了很久）。补上"索引期向量化"：有界分批 + 失败即停。
let vectorBackfillRunning = /** @type {Promise<{embedded: number, remaining: number}> | null} */ (null);

/** 还没向量化的段数（KB 检索质量的可观测量） */
export function countMissingVectors() {
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM knowledge_paragraphs WHERE vector IS NULL").get();
    return Number(row?.n || 0);
  } catch { return 0; }
}

/**
 * 向量回填（有界：单次最多 limit 段；模型不可用 → 立即返回且不写空向量）
 * @param {{limit?: number, embed?: (text: string) => Promise<Float32Array | null>}} [opts]
 * @returns {Promise<{embedded: number, remaining: number, modelAvailable: boolean}>}
 */
export async function backfillVectors({ limit = 64, embed = embedText } = {}) {
  let rows;
  try {
    rows = db.prepare("SELECT id, content FROM knowledge_paragraphs WHERE vector IS NULL ORDER BY doc_id, seq LIMIT ?").all(limit);
  } catch { return { embedded: 0, remaining: 0, modelAvailable: false }; }
  if (!rows.length) return { embedded: 0, remaining: 0, modelAvailable: true };
  const upd = db.prepare("UPDATE knowledge_paragraphs SET vector=? WHERE id=?");
  let embedded = 0;
  for (const r of rows) {
    const vec = await embed(String(r.content || ""));
    if (!vec) return { embedded, remaining: countMissingVectors(), modelAvailable: false };
    // 读侧按 Float32Array(buf.buffer, byteOffset, byteLength/4) 还原 → 写入必须带 byteOffset/byteLength
    upd.run(Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), String(r.id));
    embedded += 1;
  }
  return { embedded, remaining: countMissingVectors(), modelAvailable: true };
}

/**
 * 后台补齐向量（fire-and-forget）：检索先用关键词结果立刻返回，向量逐批补齐，下一次检索即生效
 * @returns {Promise<{embedded: number, remaining: number}> | null} 已有任务在跑 → null
 */
export function scheduleVectorBackfill() {
  if (vectorBackfillRunning) return null;
  vectorBackfillRunning = (async () => {
    let embedded = 0;
    try {
      for (let i = 0; i < 200; i++) { // 上限 200 批 × 64 段，防异常情况下无限占用
        const r = await backfillVectors({ limit: 64 });
        embedded += r.embedded;
        if (!r.modelAvailable || r.embedded === 0) break;
      }
    } catch { /* 回填失败不影响检索 */ }
    vectorBackfillRunning = null;
    return { embedded, remaining: countMissingVectors() };
  })();
  return vectorBackfillRunning;
}

// ---------- 混合检索（BM25 + 向量余弦 → RRF 融合） ----------
/** BM25 检索（FTS5 trigram）——返回 [{ id, score }]；查询按空格拆词 OR（trigram 短语不命中中文连续串）
 * 2 字词（如"闭包"）trigram 3 字窗口不匹配 → LIKE 兜底（召回优先，RRF 融合修正） */
function bm25Search(query, topK) {
  try {
    const words = String(query || "").split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return [];
    const out = [];
    // 每词 trigram 匹配（裸词——FTS5 trigram 自动子串匹配）；多词 OR 融合
    const match = words.map((w) => `"${w.replace(/"/g, "").slice(0, 20)}"`).join(" OR ");
    const rows = db.prepare(
      `SELECT id, bm25(knowledge_paragraphs_fts) AS score
       FROM knowledge_paragraphs_fts
       WHERE knowledge_paragraphs_fts MATCH ?
       ORDER BY score LIMIT ?`
    ).all(match, topK * 3);
    for (const r of rows) out.push({ id: String(r.id), score: -Number(r.score) }); // bm25 负分，取反
    // 2 字词 LIKE 兜底（trigram 3 字窗口不匹配 2 字词）
    for (const w of words) {
      if (w.length > 2) continue;
      const likeRows = db.prepare("SELECT id FROM knowledge_paragraphs WHERE content LIKE ? LIMIT ?").all(`%${w}%`, topK * 2);
      for (const r of likeRows) {
        if (!out.some((o) => o.id === String(r.id))) out.push({ id: String(r.id), score: 0.1 });
      }
    }
    return out;
  } catch { return []; }
}

/** 向量检索（内存暴力扫描——2000+ 段落 <10ms；ANN 是 10 万+ 规模才需要） */
async function vectorSearch(query, topK) {
  const qv = await embedText(query);
  if (!qv) return [];
  try {
    const rows = db.prepare("SELECT id, vector FROM knowledge_paragraphs WHERE vector IS NOT NULL").all();
    const scored = [];
    for (const r of rows) {
      // SQLite BLOB → Uint8Array → Float32Array（typecheck：SQLOutputValue 断言）
      const buf = /** @type {Uint8Array} */ (r.vector);
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      if (v.length !== qv.length) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
      scored.push({ id: String(r.id), score: dot }); // 已 normalize → 余弦
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK * 3);
  } catch { return []; }
}

/** RRF 融合（倒数排名融合——BM25 与向量分数不可直接比较，只看排名） */
function rrfMerge(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const cur = scores.get(item.id) || 0;
      scores.set(item.id, cur + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/**
 * 段落级混合检索：BM25 + 向量 → RRF 融合 → 段落级结果（含来源文档 + 段落上下文）
 * followup 段落加权（+2 排名——用户亲手问的优先）
 * @param {string} query 检索词
 * @param {number} [topK] 返回条数
 * @returns {Promise<Array<{id: string, docId: string, section: string, kind: string, content: string, score: number}>>}
 */
export async function searchParagraphs(query, topK = 8) {
  const q = String(query || "").trim();
  if (!q) return [];
  const bm25 = bm25Search(q, topK);
  const vec = await vectorSearch(q, topK);
  let merged = rrfMerge([bm25, vec]);
  // followup 段落加权：排名 +2（用户亲手问的 = 知识缺口 = 高价值）
  const followupIds = new Set(
    (db.prepare("SELECT id FROM knowledge_paragraphs WHERE kind='followup'").all() || []).map((r) => String(r.id))
  );
  merged = merged.map((m, i) => ({ ...m, score: m.score + (followupIds.has(m.id) ? 2 / (i + 1) : 0) }))
    .sort((a, b) => b.score - a.score);
  const top = merged.slice(0, topK);
  if (!top.length) return [];
  const rows = db.prepare(
    `SELECT id, doc_id, section, kind, content FROM knowledge_paragraphs WHERE id IN (${top.map(() => "?").join(",")})`
  ).all(...top.map((t) => t.id));
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return top
    .map((t) => {
      const r = byId.get(t.id);
      if (!r) return null;
      return { id: t.id, docId: String(r.doc_id), section: String(r.section || ""), kind: String(r.kind), content: String(r.content), score: t.score };
    })
    .filter(Boolean);
}

/** 段落统计（知识库 Tab 展示） */
export function getParagraphStats() {
  try {
    // node:sqlite 的 .get().n 类型是 SQLOutputValue（string|number|bigint|null|Uint8Array）——
    // 必须显式 Number() 才能参与算术/比较（checkJs 下 total - withVectors 会报 TS2362/2365）
    const n = (sql) => Number(db.prepare(sql).get()?.n || 0);
    const total = n("SELECT COUNT(*) n FROM knowledge_paragraphs");
    const followups = n("SELECT COUNT(*) n FROM knowledge_paragraphs WHERE kind='followup'");
    const docs = n("SELECT COUNT(DISTINCT doc_id) n FROM knowledge_paragraphs");
    const withVectors = n("SELECT COUNT(*) n FROM knowledge_paragraphs WHERE vector IS NOT NULL");
    return { total, followups, docs, withVectors, missingVectors: total - withVectors };
  } catch { return { total: 0, followups: 0, docs: 0, withVectors: 0, missingVectors: 0 }; }
}

// ---------- 个人学习知识库工单任务 2：rerank 精排（bge-reranker 交叉编码器） ----------
// 第一级（零成本）：RRF 融合 + followup 段落加权（+2）——粗排 top10（searchParagraphs 已实现）
// 第二级（交叉编码器）：bge-reranker-base 量化版——query × top10 候选拼接编码 → top5
// 内存策略：惰性加载（首次精排才加载，与向量模型分开加载，不常驻——800MB 教训）；量化版 ~300MB 可控
// 降级：模型加载失败 → 返回 RRF 粗排结果（不炸）
let reranker = null;
let rerankerLoading = null;
async function getReranker() {
  if (reranker) return reranker;
  if (!rerankerLoading) {
    rerankerLoading = (async () => {
      reranker = await loadModel("text-classification", "Xenova/bge-reranker-base", { quantized: true });
      return reranker;
    })().catch(() => { reranker = null; return null; });
  }
  return rerankerLoading;
}

/**
 * 交叉编码器精排：query × 候选段落拼接编码 → 相关性分数 → 重排
 * 降级：模型加载失败/推理失败 → 原序返回（RRF 粗排结果兜底）
 * @param {string} query 检索词
 * @param {Array<{id: string, content: string}>} candidates 粗排候选（top10）
 * @param {number} [topK] 精排后返回条数
 * @returns {Promise<Array<{id: string, score: number}>>} 精排结果（id + 相关性分数）
 */
export async function rerankParagraphs(query, candidates, topK = 5) {
  if (!candidates?.length) return [];
  try {
    const model = await getReranker();
    if (!model) return candidates.slice(0, topK).map((c) => ({ id: c.id, score: 0 })); // 降级：RRF 原序
    const pairs = candidates.map((c) => [String(query || "").slice(0, 200), String(c.content || "").slice(0, 400)]);
    const out = await model(pairs, { topk: 1 });
    const scored = candidates.map((c, i) => ({
      id: c.id,
      score: Number(out?.[i]?.[0]?.score) || 0,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch {
    return candidates.slice(0, topK).map((c) => ({ id: c.id, score: 0 })); // 降级：RRF 原序
  }
}

/** 混合检索 + 精排（任务 2：RRF 粗排 top10 → 交叉编码器精排 top5）——知识库 Tab 检索入口 */
export async function searchParagraphsReranked(query, topK = 5) {
  const rough = await searchParagraphs(query, 10); // 粗排 top10（RRF + followup 加权）
  if (!rough.length) return [];
  const reranked = await rerankParagraphs(query, rough.map((h) => ({ id: h.id, content: h.content })), topK);
  const byId = new Map(rough.map((h) => [h.id, h]));
  return reranked
    .map((r) => byId.get(r.id))
    .filter(Boolean)
    .map((h) => ({ ...h, rerankScore: reranked.find((r) => r.id === h.id)?.score || 0 }));
}

// ---------- 个人学习知识库工单任务 3：追问段落 → 复习卡 ----------
// 追问 = 用户亲手标注的知识缺口——"useState 为什么用模块级数组"变成一张卡，进 FSRS 调度
// 提炼：规则取追问文本（追问段标题就是问题——用户真实疑问，无需 LLM 提炼）
// 去重：同 topic 卡已存在 → 更新不重复建（review.addCard 同 topic 更新语义——幂等）
export async function followupsToReviewCards() {
  const dir = studyNotesDir();
  const added = [];
  try {
    const { parseFollowups } = await import("./followup-cache.mjs");
    const { review } = await import("./review.mjs");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const text = readFileSync(path.join(dir, name), "utf8");
      const followups = parseFollowups(text);
      for (const f of followups) {
        const q = String(f.question || "").trim();
        if (!q) continue;
        const topic = `追问：${q.slice(0, 30)}`;
        try {
          const r = review.addCard({ topic, question: q, answer: String(f.answer || "").slice(0, 2000), source: "追问" });
          if (r) added.push(topic); // addCard 返回卡对象即成功（同 topic 更新语义——幂等）
        } catch { /* 单条失败跳过 */ }
      }
    }
  } catch { /* 扫描失败忽略 */ }
  return { added };
}
