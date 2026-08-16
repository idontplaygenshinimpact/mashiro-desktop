// 本地 RAG 知识库：全量资产（面经 md/学习清单/复习卡/薄弱点/岗位/官方文档）→ 切片 → 本地 embedding → 混合检索
// 检索：FTS5 trigram 关键词 + 向量语义余弦 → RRF 融合（embedding 不可用时自动降级纯 FTS5）
// 技术点：@xenova/transformers 本地 WASM 跑 bge-m3（int8 量化，cls pooling）；模型可插拔（RAG_EMBED_MODEL）
// 增量：md 按 mtime 只重嵌变更文件；FTS 与 items 用 id 关联（UNINDEXED 列），增删不依赖 rowid 对齐
import { db } from "./db.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readJsonSafe } from "./atomic-json.mjs";
import { sanitizeExternal, UNTRUSTED_DECLARATION } from "./prompt-guard.mjs";

let embedder = null; // { dim, embed(text)->Float32Array } 懒加载单例
let embedError = null;

// ---------- DB 结构 ----------
// 旧版 fts 表（rowid 关联）结构不兼容时直接重建（数据全量重灌，无迁移成本）
let ftsRebuilt = false;
try { db.exec("SELECT id FROM knowledge_fts LIMIT 1"); } catch {
  db.exec("DROP TABLE IF EXISTS knowledge_fts");
  ftsRebuilt = true;
}
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  source TEXT,            -- 来源标识：md 路径 / study / review / weak / job / doc
  kind TEXT,              -- mianjing=面经讲解 / jiaocheng=教程笔记 / job=岗位 / doc=官方文档 / note=学习产出
  title TEXT,
  content TEXT,
  vector BLOB,            -- Float32Array 序列化（4B/元素）
  confidence REAL NOT NULL DEFAULT 0.5,  -- 可信度：weak 0.3 / 爬虫内容 0.5 / 人工验证可提升
  evidence TEXT NOT NULL DEFAULT '',     -- 溯源证据（复盘弱项 / 来源 URL）
  last_verified_at INTEGER,              -- 人工验证时间戳（毫秒，NULL=未验证）
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_items(kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_items(source);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, title, content, tokenize='trigram');
`);
// 旧 fts 表被重建后从 content 表重灌（否则 knowledge_items 有数据但 FTS 空 → 检索全空）
if (ftsRebuilt) {
  try {
    db.exec("INSERT INTO knowledge_fts(id, title, content) SELECT id, title, content FROM knowledge_items");
  } catch { /* knowledge_items 尚无数据时忽略 */ }
}

// 可配置：测试注入临时目录（RAG_OUTPUT_DIR）
const OUTPUT_DIR = process.env.RAG_OUTPUT_DIR || path.join(import.meta.dirname, "..", "output");

// ---------- 资产采集 ----------
function collectMdAssets() {
  const items = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".md")) continue;
      if (/^00[_-]/.test(name)) continue; // 索引/README 文件不建库（与 scanNewestFiles 同口径，避免空壳条目污染检索）
      const text = readFileSync(p, "utf8");
      // 文件一级标题（题目名）——切片标题要带上，否则每块标题都是"结论/原理"
      const fileTitle = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || path.basename(p, ".md");
      // 按 ## 二级标题切片（每块是一个知识点/题目）
      const sections = text.split(/\n(?=#{2,3}\s)/);
      const seen = new Set();
      for (const sec of sections) {
        const secTitle = (sec.match(/^#{1,3}\s+(.+)$/m) || [])[1]?.trim() || "";
        const title = fileTitle + (secTitle && secTitle !== fileTitle ? " · " + secTitle : "");
        const content = sec.trim();
        if (content.length < 40) continue;
        if (seen.has(content)) continue; // 同文件重复块去重
        seen.add(content);
        const kind = /面经|面试|笔试/.test(fileTitle) || /面经|面试|笔试/.test(p) ? "mianjing" : "jiaocheng";
        // 爬虫产出 md：可信度 0.5，溯源证据 = 来源 URL（md 头部 "> 来源: <url>"）
        const sourceUrl = (content.match(/来源[::]\s*(https?:\/\/[^\s)\]]+)/) || [])[1] || "";
        items.push({ source: p, kind, title, content, confidence: 0.5, evidence: sourceUrl });
      }
    }
  };
  if (existsSyncSafe(OUTPUT_DIR)) walk(OUTPUT_DIR);
  return items;
}

function existsSyncSafe(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function collectDbAssets() {
  const items = [];
  // 学习清单（含验证题）
  try {
    for (const r of db.prepare("SELECT topic, why, verify_question, level FROM study_plan_items").all()) {
      const title = `学习·${r.topic}`;
      items.push({ source: "study", kind: "note", title, content: `${title}\n为什么学：${r.why || ""}\n验证题：${r.verify_question || ""}` });
    }
  } catch { /* 表可能不存在 */ }
  // 复习卡（FSRS）
  try {
    for (const r of db.prepare("SELECT question, answer, topic FROM review_cards").all()) {
      items.push({ source: "review", kind: "note", title: `复习·${r.topic || String(r.question).slice(0, 20)}`, content: `${r.question}\n${r.answer || ""}` });
    }
  } catch { /* ignore */ }
  // 薄弱点（注意：weak_points 无 note 列，只查真实列 topic/fail_count/source，避免查询抛错导致薄弱点从未入库）
  // 可信度 0.3：复盘验证产生的弱项，尚未人工核实，evidence 标注来源
  try {
    for (const r of db.prepare("SELECT topic, fail_count, source FROM weak_points").all()) {
      items.push({ source: "weak", kind: "note", title: `薄弱·${r.topic}`, content: `${r.topic}（错 ${r.fail_count || 0} 次${r.source ? "，来源：" + r.source : ""}）`, confidence: 0.3, evidence: "复盘弱项" });
    }
  } catch { /* ignore */ }
  // 岗位
  try {
    for (const r of db.prepare("SELECT company, title, summary, deadline FROM job_posts WHERE status != 'done'").all()) {
      items.push({ source: "job", kind: "job", title: `岗位·${r.company} ${r.title}`, content: `${r.company} ${r.title}\n${r.summary || ""}\n${r.deadline ? "截止：" + r.deadline : ""}` });
    }
  } catch { /* ignore */ }
  // 官方文档（清单 + 版本检测结果）
  try {
    const sites = readJsonSafe(path.join(import.meta.dirname, "..", "data", "learning-sites.json"), { categories: [] });
    const versions = readJsonSafe(path.join(import.meta.dirname, "..", "data", "doc-versions.json"), {});
    for (const cat of sites.categories || []) {
      for (const s of cat.sites || []) {
        const v = versions[s.name] || {};
        items.push({ source: "doc", kind: "doc", title: `文档·${s.name}`, content: `${s.name}（${cat.category}）\n${s.desc || ""}\n官网：${s.official}\n${v.version ? "最新版本：" + v.version + (v.date ? "（" + v.date + "）" : "") : ""}` });
      }
    }
  } catch { /* ignore */ }
  // 牛客大厂真题/模拟卷（官方试卷，含题型分布）
  try {
    for (const r of db.prepare("SELECT kind, company, title, question_count, single_count, multi_count, program_count, url FROM exam_papers").all()) {
      const counts = r.question_count
        ? `题型：总${r.question_count}（单选${r.single_count || 0}/多选${r.multi_count || 0}/编程${r.program_count || 0}）`
        : "题型：未抓取";
      items.push({ source: "zhenti", kind: "exam", title: `笔试·${r.kind === "simulate" ? "模拟卷" : r.company} ${r.title}`, content: `${r.title}\n${counts}\n练习：${r.url}`, confidence: 0.5, evidence: r.url || "" });
    }
  } catch { /* ignore */ }
  // 牛客真题具体题目（题干/选项/答案——复习选择题出题素材，闭环：爬取 → 知识库 → 选择题）
  try {
    for (const r of db.prepare("SELECT q.paper_test_id, p.company, q.q_index, q.q_type, q.title, q.options, q.answer FROM exam_questions q LEFT JOIN exam_papers p ON p.test_id = q.paper_test_id").all()) {
      const optText = r.options ? `\n选项：${String(r.options)}` : "";
      const ansText = r.answer ? `\n答案：${String(r.answer)}` : "";
      items.push({
        source: "zhenti-q", kind: "exam",
        title: `真题·${r.company || r.paper_test_id}·题${r.q_index}（${r.q_type || ""}）`,
        content: `${r.title}${optText}${ansText}`.slice(0, 800),
        confidence: 0.6, evidence: r.paper_test_id || "",
      });
    }
  } catch { /* ignore */ }
  // 牛客 TOP101 刷题（算法题：标题/难度/通过量——算法知识点出题素材）
  try {
    for (const r of db.prepare("SELECT category, bm_no, title, difficulty, people, url FROM exam_problems").all()) {
      items.push({
        source: "oj", kind: "problem",
        title: `题·${r.category}·${r.title}`,
        content: `${r.title}（${r.category}，${r.bm_no}）\n难度：${r.difficulty || "未知"}${r.people ? "，通过量 " + r.people : ""}\n刷题：${r.url}`,
        confidence: 0.5, evidence: r.url || "",
      });
    }
  } catch { /* ignore */ }
  return items;
}

// ---------- Embedding（懒加载，失败降级） ----------
// 模型可插拔：RAG_EMBED_MODEL 环境变量一行切换（如 Xenova/bge-m3、Xenova/jina-embeddings-v2-base-zh）
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "Xenova/bge-m3";
let embedderPromise = null; // promise 缓存：并发首次调用只加载一次
let embedRetryAt = 0;      // 失败冷却：到该时间戳后才允许重试（避免每次调用都重下模型）
async function getEmbedder() {
  if (embedder) return embedder;
  if (embedError && Date.now() < embedRetryAt) return null;
  if (embedError) embedError = null; // 冷却结束，允许重试
  if (!embedderPromise) {
    embedderPromise = (async () => {
      try {
        const { pipeline, env } = await import("@xenova/transformers");
        env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com/"; // 国内镜像
        const extractor = await pipeline("feature-extraction", EMBED_MODEL);
        embedder = {
          dim: 1024,
          async embed(text) {
            // bge-m3 官方池化是 [CLS] token（mean 会让无关文本分数整体偏高，区分度差）
            const out = await extractor(text, { pooling: "cls", normalize: true });
            return new Float32Array(/** @type {Float32Array} */ (out.data));
          },
        };
        return embedder;
      } catch (e) {
        embedError = e.message;
        embedRetryAt = Date.now() + 5 * 60 * 1000; // 冷却 5 分钟，之后可重试
        embedderPromise = null;
        console.log(`[rag] embedding 加载失败，降级纯 FTS5 检索（5 分钟后重试）：${String(e.message).slice(0, 80)}`);
        return null;
      }
    })();
  }
  return embedderPromise;
}

// 构建互斥：全量重建与增量重建共享同一把锁（防手动触发与定时任务并发覆盖）
let building = false;
async function withBuildLock(fn) {
  if (building) return null; // 正在重建：直接告知 busy（调用方跳过/提示）
  building = true;
  try { return await fn(); } finally { building = false; }
}

/** 向量序列化：Float32Array <-> Buffer */
function pack(v) { return Buffer.from(v.buffer, v.byteOffset, v.byteLength); }
function unpack(b) { return b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null; }

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const genId = (base) => `kb_${base}_${Math.random().toString(36).slice(2, 10)}`;

function insertItem(id, it, vector, now) {
  db.prepare("INSERT INTO knowledge_items (id, source, kind, title, content, vector, confidence, evidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, it.source, it.kind, it.title.slice(0, 200), it.content, vector, it.confidence ?? 0.5, it.evidence ?? "", now, now);
  db.prepare("INSERT INTO knowledge_fts (id, title, content) VALUES (?,?,?)")
    .run(id, it.title.slice(0, 200), it.content);
}

async function embedBatch(ed, items) {
  if (!ed) return items.map(() => null);
  const out = [];
  const CHUNK = 16;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const vecs = await Promise.all(chunk.map((it) => ed.embed(it.title + "\n" + it.content.slice(0, 600))));
    for (const v of vecs) out.push(pack(v));
  }
  return out;
}

// ---------- 构建 ----------
/**
 * 全量重建知识库
 * @returns {Promise<{items:number, seconds:number, embedding:boolean}>}
 */
export async function rebuildKnowledgeBase(onProgress = null) {
  return withBuildLock(async () => {
    const items = [...collectMdAssets(), ...collectDbAssets()];
    const ed = await getEmbedder();
    const now = Date.now();
    const idBase = now.toString(36);
    // embedding 全部在事务外算完（WASM 推理 + 可能的模型下载，不能占用事务）
    const vectors = await embedBatch(ed, items);
    // 清库 + 插入在同一个同步事务里（无 await 间隔，杜绝并发重建的竞态窗口）
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM knowledge_items; DELETE FROM knowledge_fts;");
      items.forEach((it, i) => insertItem(genId(idBase), it, vectors[i], now));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    // 记录 md mtime（供增量用）
    const mtimes = {};
    for (const it of collectMdAssets()) {
      try { mtimes[it.source] = statSync(it.source).mtimeMs; } catch { /* ignore */ }
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(MTIMES_KEY, JSON.stringify(mtimes), now);
    return { items: items.length, seconds: Math.round((Date.now() - now) / 100) / 10, embedding: !!ed };
  });
}

// ---------- 混合检索 ----------
/**
 * 混合检索：FTS5 关键词 + 向量语义 → RRF 融合（按 id 关联）
 */
export async function searchKnowledge(query, topK = 5) {
  const q = String(query || "").trim();
  if (!q) return [];
  const K = 20; // 各通道取前 K 融合

  // 通道 1：FTS5 trigram（中文按 3 字滑动窗口拆词 OR 组合——trigram 索引要求查询串连续匹配）
  const ftsHits = [];
  const terms = [];
  for (const m of q.match(/[\u4e00-\u9fff]+|[A-Za-z0-9]+/g) || []) {
    if (/^[A-Za-z0-9]/.test(m)) {
      if (m.length >= 3) terms.push(m);
    } else if (m.length >= 3) {
      // 中文连续串 → 3 字窗口（"宏任务微任务" → 宏任务/任务微/务微任/微任务），取前 6 个去重
      for (let i = 0; i <= m.length - 3 && terms.length < 8; i++) {
        const w = m.slice(i, i + 3);
        if (!terms.includes(w)) terms.push(w);
      }
    }
  }
  if (terms.length) {
    try {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      const rows = db.prepare(`SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery, K);
      rows.forEach((r, i) => ftsHits.push({ id: String(r.id), score: 1 / (60 + i) }));
    } catch { /* 查询无匹配或语法错误 */ }
  }

  // 通道 2：向量语义（embedding 可用时）
  let vecHits = [];
  const ed = await getEmbedder();
  if (ed) {
    const qv = await ed.embed(q);
    const rows = db.prepare("SELECT id, vector FROM knowledge_items").all();
    const scored = [];
    for (const r of rows) {
      const v = unpack(r.vector);
      if (!v) continue;
      const s = cosine(qv, v);
      if (s > 0.15) scored.push({ id: String(r.id), s }); // 宽松阈值过滤明显噪音（bge-m3 cls 分数整体偏高）
    }
    scored.sort((a, b) => b.s - a.s);
    scored.slice(0, K).forEach((h, i) => vecHits.push({ id: h.id, score: 1 / (60 + i), s: h.s }));
  }

  // RRF 融合（按 id）
  const fused = new Map();
  for (const h of ftsHits) fused.set(h.id, { id: h.id, rrf: h.score, ftsScore: h.score, vecScore: 0 });
  for (const h of vecHits) {
    const cur = fused.get(h.id) || { id: h.id, rrf: 0, ftsScore: 0, vecScore: 0 };
    cur.rrf += h.score;
    cur.vecScore = h.s;
    fused.set(h.id, cur);
  }
  const ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, topK);
  if (!ranked.length) return [];

  const byId = new Map(db.prepare("SELECT id, source, kind, title, content FROM knowledge_items").all().map((r) => [String(r.id), r]));
  return ranked
    .filter((r) => byId.has(r.id))
    .map((r) => {
      const d = byId.get(r.id);
      return {
        id: r.id,
        title: String(d.title),
        content: String(d.content || "").slice(0, 800),
        source: String(d.source),
        kind: String(d.kind),
        score: Math.round(r.rrf * 1000) / 1000,
        vectorScore: Math.round(r.vecScore * 1000) / 1000,
        ftsScore: Math.round(r.ftsScore * 1000) / 1000,
      };
    });
}

/** 知识库统计 */
export function getKnowledgeStats() {
  const total = db.prepare("SELECT COUNT(*) n FROM knowledge_items").get().n;
  const byKind = db.prepare("SELECT kind, COUNT(*) n FROM knowledge_items GROUP BY kind").all();
  const last = db.prepare("SELECT MAX(updated_at) t FROM knowledge_items").get().t || 0;
  return { total, byKind, lastBuild: last, embedding: !!embedder, embedError };
}

/** 人工验证知识条目：更新可信度 + 验证时间戳（claim layer：可把 0.3 弱项提升到 0.9） */
export function markVerified(id, confidence) {
  const n = Number(confidence);
  const c = Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.9;
  const now = Date.now();
  const r = db.prepare("UPDATE knowledge_items SET confidence = ?, last_verified_at = ?, updated_at = ? WHERE id = ?")
    .run(c, now, now, String(id));
  return { ok: r.changes > 0, changes: r.changes, confidence: c, lastVerifiedAt: now };
}

// ---------- RAG 问答闭环（检索 → 注入 → LLM 生成） ----------
/**
 * 基于知识库回答：混合检索 topK → 拼上下文 → LLM 生成答案
 */
export async function askKnowledge(query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, hits: [], answer: null, message: "问题不能为空" };
  const hits = await searchKnowledge(q, 5);
  if (!hits.length) return { ok: false, hits: [], answer: null, message: "本地知识库无命中，可换关键词或先重建索引" };
  // 知识库内容来自爬虫/外部，逐条包裹为不可信数据（防提示注入）
  const context = hits
    .map((h, i) => `【资料${i + 1}】${sanitizeExternal(`${h.title}\n${h.content}`).wrapped}`)
    .join("\n\n");
  const { llmChat, getReplyText } = await import("./llm.mjs");
  const data = await llmChat(
    [
      { role: "system", content: `你是前端秋招面试助手。基于「本地知识库资料」回答用户问题：1) 优先用资料内容组织答案，注明资料出处 2) 资料不足时诚实说明并补充自己的知识 3) 有代码示例就给出 4) 答案 300 字内、结构化（结论/要点/代码/边界）\n${UNTRUSTED_DECLARATION}` },
      { role: "user", content: `问题：${q}\n\n本地知识库资料：\n${context}` },
    ],
    { maxTokens: 800, temperature: 0.3, role: "rag-ask" }
  );
  return { ok: true, hits, answer: getReplyText(data) };
}

// ---------- 增量更新（md 按 mtime；DB 资产全量重刷） ----------
const MTIMES_KEY = "rag_indexed_mtimes";

/** 已索引 md 文件的 mtime 记录（settings 表持久化） */
export function getIndexedMtimes() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(MTIMES_KEY);
    return row ? JSON.parse(String(row.value)) : {};
  } catch { return {}; }
}

/**
 * 增量重建：只重嵌 新增/修改 的 md 文件切片 + 全量重刷 DB 资产（量小）
 * @returns {Promise<{changed:boolean, added:number, removed:number, seconds:number, embedding:boolean}>}
 */
export async function incrementalRebuild() {
  return withBuildLock(async () => {
    const t0 = Date.now();
    const mtimes = getIndexedMtimes();
    const now = Date.now();
    const idBase = now.toString(36);
    const ed = await getEmbedder();
    let added = 0, removed = 0;
    const newMtimes = {};

    // md 资产：按文件聚合，mtime 变化才重嵌
    const mdItems = collectMdAssets();
    const bySource = new Map();
    for (const it of mdItems) {
      if (!bySource.has(it.source)) bySource.set(it.source, []);
      bySource.get(it.source).push(it);
    }
    // 阶段 1（事务外）：收集所有变更——待删旧 id + 待插入 items（含向量，await 都在这里）
    const delIds = [];
    const insItems = [];
    for (const [src, items] of bySource) {
      let mtime = 0;
      try { mtime = statSync(src).mtimeMs; } catch { /* 文件被删 */ }
      newMtimes[src] = mtime;
      if (mtimes[src] === mtime) continue; // 未变化跳过
      const old = db.prepare("SELECT id FROM knowledge_items WHERE source=?").all(src);
      for (const d of old) delIds.push(String(d.id));
      const vectors = await embedBatch(ed, items);
      items.forEach((it, i) => insItems.push({ ...it, vector: vectors[i] }));
    }
    // 已从磁盘删除的文件：清理残留条目
    for (const src of Object.keys(mtimes)) {
      if (bySource.has(src)) continue;
      const old = db.prepare("SELECT id FROM knowledge_items WHERE source=?").all(src);
      for (const d of old) delIds.push(String(d.id));
    }
    // DB 资产（学习清单/复习卡/岗位/文档/真题/刷题）：全量重刷
    const dbItems = collectDbAssets();
    const oldDb = db.prepare("SELECT id FROM knowledge_items WHERE source IN ('study','review','weak','job','doc','zhenti','zhenti-q','oj')").all();
    for (const d of oldDb) delIds.push(String(d.id));
    const dbVectors = await embedBatch(ed, dbItems);
    dbItems.forEach((it, i) => insItems.push({ ...it, vector: dbVectors[i] }));

    // 阶段 2（同步事务，无 await）：统一删除 + 插入
    if (delIds.length || insItems.length) {
      db.exec("BEGIN");
      try {
        for (const id of delIds) {
          db.prepare("DELETE FROM knowledge_fts WHERE id=?").run(id);
          db.prepare("DELETE FROM knowledge_items WHERE id=?").run(id);
          removed++;
        }
        for (const it of insItems) {
          insertItem(genId(idBase), it, it.vector, now);
          added++;
        }
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }

    // 持久化 mtime（清除已删除文件的记录）
    const cleaned = {};
    for (const [src, m] of Object.entries(newMtimes)) if (m) cleaned[src] = m;
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(MTIMES_KEY, JSON.stringify(cleaned), now);

    const changed = added > 0 || removed > 0;
    return { changed, added, removed, seconds: Math.round((Date.now() - t0) / 100) / 10, embedding: !!ed };
  });
}
