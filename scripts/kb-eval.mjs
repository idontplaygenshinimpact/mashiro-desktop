// 个人学习知识库工单任务 1：评测对比（BM25-only vs 混合检索 top5 命中率）
// 用法：node scripts/kb-eval.mjs（需先有 study_notes 文档 + 已索引）
// 输出：两组 top5 命中率对比——混合显著高于 BM25-only → 保留向量；差不多 → 向量降级
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalFile = path.join(root, "data", "kb-eval.json");
if (!existsSync(evalFile)) { console.log("评测集不存在（data/kb-eval.json）"); process.exit(0); }
const evalSet = JSON.parse(readFileSync(evalFile, "utf8"));

const { indexStudyNotes, searchParagraphs } = await import("../lib/knowledge-base.mjs");
const { db } = await import("../lib/db.mjs");

// 索引（幂等）
const idx = indexStudyNotes();
console.log(`段落索引：新增 ${idx.added} 段 / 清理 ${idx.removed} 段`);

// BM25-only（FTS5 直接检索）
function bm25Only(query, topK = 5) {
  try {
    const rows = db.prepare(
      `SELECT id, bm25(knowledge_paragraphs_fts) AS score
       FROM knowledge_paragraphs_fts
       WHERE knowledge_paragraphs_fts MATCH ?
       ORDER BY score LIMIT ?`
    ).all(`"${String(query || "").replace(/"/g, "").slice(0, 50)}"`, topK);
    return rows.map((r) => String(r.id));
  } catch { return []; }
}

function hitRate(ids, expectDocs) {
  if (!ids.length) return 0;
  // 命中判定：结果段落属于期望文档（doc_id 含 expect 关键词）
  const rows = db.prepare(`SELECT id, doc_id FROM knowledge_paragraphs WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  const docs = rows.map((r) => String(r.doc_id));
  const hit = expectDocs.some((k) => docs.some((d) => d.includes(k)));
  return hit ? 1 : 0;
}

let bm25Hits = 0, hybridHits = 0;
const detail = [];
for (const e of evalSet) {
  const bm25Ids = bm25Only(e.query);
  const hybrid = await searchParagraphs(e.query, 5);
  const hybridIds = hybrid.map((h) => h.id);
  const b = hitRate(bm25Ids, e.expectDocs);
  const h = hitRate(hybridIds, e.expectDocs);
  bm25Hits += b; hybridHits += h;
  detail.push({ id: e.id, query: e.query, bm25: b ? "✓" : "✗", hybrid: h ? "✓" : "✗", note: e.note });
}

const n = evalSet.length;
console.log(`\n评测集 ${n} 题：`);
for (const d of detail) console.log(`  ${d.id} ${d.query}  BM25:${d.bm25}  混合:${d.hybrid}  （${d.note}）`);
console.log(`\nBM25-only top5 命中率：${bm25Hits}/${n}（${Math.round((bm25Hits / n) * 100)}%）`);
console.log(`混合检索 top5 命中率：${hybridHits}/${n}（${Math.round((hybridHits / n) * 100)}%）`);
const verdict = hybridHits > bm25Hits ? "✅ 混合显著高于 BM25-only → 保留向量" : (hybridHits === bm25Hits ? "⚠️ 差不多 → 向量可降级（BM25 够用）" : "❌ 更低 → 排查（模型/切分/融合）");
console.log(`结论：${verdict}`);
