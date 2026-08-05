// 本地 RAG 知识库：全量资产（面经 md/学习清单/复习卡/薄弱点/岗位/官方文档）→ 切片 → 本地 embedding → 混合检索
// 检索：FTS5 trigram 关键词 + 向量语义余弦 → RRF 融合（embedding 不可用时自动降级纯 FTS5）
// 技术点：@xenova/transformers 本地 WASM 跑 bge-small-zh-v1.5（零 Python/零 API 成本；模型可插拔，换 bge-large-zh 只改一行）
import { db } from "./db.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readJsonSafe } from "./atomic-json.mjs";

let embedder = null; // { dim, embed(text)->Float32Array } 懒加载单例
let embedError = null;

// ---------- DB 结构 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  source TEXT,            -- 来源标识：md 路径 / study / review / weak / job / doc
  kind TEXT,              -- mianjing=面经讲解 / jiaocheng=教程笔记 / job=岗位 / doc=官方文档 / note=学习产出
  title TEXT,
  content TEXT,
  vector BLOB,            -- Float32Array 序列化（4B/元素）
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_items(kind);
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title, content, tokenize='trigram');
`);

const OUTPUT_DIR = path.join(import.meta.dirname, "..", "output");

// ---------- 资产采集 ----------
function collectMdAssets() {
  const items = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".md")) continue;
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
        items.push({ source: p, kind, title, content });
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
  // 薄弱点
  try {
    for (const r of db.prepare("SELECT topic, note FROM weak_points").all()) {
      items.push({ source: "weak", kind: "note", title: `薄弱·${r.topic}`, content: `${r.topic}：${r.note || ""}` });
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
  return items;
}

// ---------- Embedding（懒加载，失败降级） ----------
// 模型可插拔：RAG_EMBED_MODEL 环境变量一行切换（如 Xenova/bge-m3、Xenova/jina-embeddings-v2-base-zh）
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "Xenova/bge-m3";
async function getEmbedder() {
  if (embedder) return embedder;
  if (embedError) return null;
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
    console.log(`[rag] embedding 不可用，降级纯 FTS5 检索：${String(e.message).slice(0, 80)}`);
    return null;
  }
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

// ---------- 构建 ----------
/**
 * 重建知识库：采集全部资产 → 切片 → embedding → 入库
 * @returns {Promise<{items:number, seconds:number, embedding:boolean}>}
 */
export async function rebuildKnowledgeBase(onProgress = null) {
  const items = [...collectMdAssets(), ...collectDbAssets()];
  const ed = await getEmbedder();
  const now = Date.now();
  const idBase = now.toString(36);

  // 清旧库
  db.exec("DELETE FROM knowledge_items; DELETE FROM knowledge_fts;");

  let done = 0;
  const batch = ed
    ? await (async () => {
        const out = [];
        // 分批 embedding（避免一次占满内存；WASM 批处理）
        const CHUNK = 16;
        for (let i = 0; i < items.length; i += CHUNK) {
          const chunk = items.slice(i, i + CHUNK);
          const vecs = await Promise.all(chunk.map((it) => ed.embed(it.title + "\n" + it.content.slice(0, 600))));
          for (let j = 0; j < chunk.length; j++) out.push({ ...chunk[j], vector: pack(vecs[j]) });
          done += chunk.length;
          if (onProgress && i % 64 === 0) onProgress(done, items.length);
        }
        return out;
      })()
    : items.map((it) => ({ ...it, vector: null }));

  const insert = db.prepare("INSERT INTO knowledge_items (id, source, kind, title, content, vector, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  const insertFts = db.prepare("INSERT INTO knowledge_fts (rowid, title, content) VALUES (?,?,?)");
  db.exec("BEGIN");
  try {
    batch.forEach((it, i) => {
      const id = `kb_${idBase}_${i.toString(36)}`;
      insert.run(id, it.source, it.kind, it.title.slice(0, 200), it.content, it.vector, now, now);
      insertFts.run(i + 1, it.title.slice(0, 200), it.content);
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { items: batch.length, seconds: Math.round((Date.now() - now) / 100) / 10, embedding: !!ed };
}

// ---------- 混合检索 ----------
/**
 * 混合检索：FTS5 关键词 + 向量语义 → RRF 融合
 * @param {string} query
 * @param {number} [topK]
 * @returns {Promise<Array<{id:string,title:string,content:string,source:string,kind:string,score:number,vectorScore:number,ftsScore:number}>>}
 */
export async function searchKnowledge(query, topK = 5) {
  const q = String(query || "").trim();
  if (!q) return [];
  const K = 20; // 各通道取前 K 融合

  // 通道 1：FTS5 trigram（中文子串匹配；按 ≥3 字符词 OR 组合，trigram 对 2 字词无效）
  const ftsHits = [];
  const terms = q.replace(/\s+/g, " ").match(/[\u4e00-\u9fff]{3,}|[A-Za-z0-9]{3,}/g) || [];
  if (terms.length) {
    try {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      const rows = db.prepare(`SELECT rowid, title, content FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?`).all(ftsQuery, K);
      rows.forEach((r, i) => ftsHits.push({ rowid: r.rowid, score: 1 / (60 + i) }));
    } catch { /* 查询无匹配或语法错误 */ }
  }

  // 通道 2：向量语义（embedding 可用时）
  let vecHits = [];
  const ed = await getEmbedder();
  if (ed) {
    const qv = await ed.embed(q);
    const rows = db.prepare("SELECT rowid, vector FROM knowledge_items ORDER BY rowid").all();
    const scored = [];
    for (const r of rows) {
      const v = unpack(r.vector);
      if (!v) continue;
      const s = cosine(qv, v);
      if (s > 0.15) scored.push({ rowid: r.rowid, s }); // 宽松阈值过滤明显噪音（bge-m3 cls 分数整体偏高）
    }
    scored.sort((a, b) => b.s - a.s);
    scored.slice(0, K).forEach((h, i) => vecHits.push({ rowid: h.rowid, score: 1 / (60 + i), s: h.s }));
  }

  // RRF 融合
  const fused = new Map();
  for (const h of ftsHits) {
    fused.set(h.rowid, { rowid: h.rowid, rrf: h.score, ftsScore: h.score, vecScore: 0 });
  }
  for (const h of vecHits) {
    const cur = fused.get(h.rowid) || { rowid: h.rowid, rrf: 0, ftsScore: 0, vecScore: 0 };
    cur.rrf += h.score;
    cur.vecScore = h.s;
    fused.set(h.rowid, cur);
  }
  const ranked = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, topK);
  if (!ranked.length) return [];

  // 取详情（注意查 rowid 用于对齐两个通道的命中）
  const byId = new Map(db.prepare("SELECT rowid, id, source, kind, title, content FROM knowledge_items").all().map((r) => [r.rowid, r]));
  return ranked
    .filter((r) => byId.has(r.rowid))
    .map((r) => {
      const d = byId.get(r.rowid);
      return {
        id: String(d.id),
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
