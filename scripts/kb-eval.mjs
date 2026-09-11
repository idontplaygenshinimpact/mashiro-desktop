// 个人学习知识库：检索评测（三条基线 top5 命中率对比）
// 用法：node scripts/kb-eval.mjs（需先有 output/study_notes 讲解文档；评测集 data/kb-eval.json 是手写 JSONC）
//
// 对比的三条基线（都取 top5，命中判定：结果段落所属文档 doc_id 含 expectDocs 关键词之一）：
//   A 短语匹配：FTS5 MATCH '"整句"'      —— 严格短语，只有原句字面出现才命中（最弱基线）
//   B 词项匹配：FTS5 MATCH '词1 OR 词2'  —— ≈产品关键词腿的召回语义，但**没有** LIKE 兜底、没有追问加权
//   C 混合检索：lib/knowledge-base.mjs searchParagraphs —— FTS5 trigram BM25 + bge 向量余弦 → RRF 融合 + 追问段加权
//
// 结论口径（重要，2026-09-11 修）：只有索引里确实存在向量时，C 与 B 的差距才能归因于"向量 + RRF"。
//   旧版脚本在向量腿完全没生效（0 段有向量）时也照样打印「✅ 混合显著高于 BM25-only → 保留向量」——
//   那是把"产品关键词腿（词项 OR + LIKE 兜底 + 追问加权）优于整句短语匹配"错读成"向量有用"，属误导。
//   现在先打印向量覆盖率，覆盖率 0 时不下向量去留的结论。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalFile = path.join(root, "data", "kb-eval.json");
if (!existsSync(evalFile)) { console.log("评测集不存在（data/kb-eval.json）"); process.exit(0); }
const evalSet = parseEvalSet(readFileSync(evalFile, "utf8"));

// 评测集是**手写的 JSONC**（文件头几行是 // 说明注释）——直接 JSON.parse 会 SyntaxError，
// 本脚本曾因此完全跑不起来（2026-09-11 修）。只剥「行首 //」整行注释，不动内容里的字符串。
function parseEvalSet(text) {
  const body = String(text)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(body);
}

const { indexStudyNotes, searchParagraphs } = await import("../lib/knowledge-base.mjs");
const { db } = await import("../lib/db.mjs");

// 索引（幂等）
const idx = indexStudyNotes();
console.log(`段落索引：新增 ${idx.added} 段 / 清理 ${idx.removed} 段`);

// 向量覆盖率：决定"混合检索"这次到底混了什么（向量腿没生效 = 只有关键词腿）
const cov = db.prepare("SELECT COUNT(*) AS total, COUNT(vector) AS withVec FROM knowledge_paragraphs").get();
const total = Number(cov?.total || 0);
const withVec = Number(cov?.withVec || 0);
console.log(`向量覆盖：${withVec}/${total} 段有向量${withVec === 0 ? "（向量腿未生效：bge 模型未加载或索引时未向量化 → 本次 C 实际≈关键词腿）" : ""}`);

/** A 短语匹配基线 */
function phraseOnly(query, topK = 5) {
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

/** B 词项匹配基线（OR 语义；无 LIKE 兜底、无追问加权——用于隔离"融合/加权"的贡献） */
function termOnly(query, topK = 5) {
  try {
    const terms = String(query || "")
      .split(/[\s，,。？！?、/]+/)
      .map((w) => w.replace(/"/g, "").trim())
      .filter((w) => w.length >= 2);
    if (!terms.length) return [];
    const match = terms.map((w) => `"${w}"`).join(" OR ");
    const rows = db.prepare(
      `SELECT id, bm25(knowledge_paragraphs_fts) AS score
       FROM knowledge_paragraphs_fts
       WHERE knowledge_paragraphs_fts MATCH ?
       ORDER BY score LIMIT ?`
    ).all(match, topK);
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

let phraseHits = 0, termHits = 0, hybridHits = 0;
const detail = [];
for (const e of evalSet) {
  const p = hitRate(phraseOnly(e.query), e.expectDocs);
  const t = hitRate(termOnly(e.query), e.expectDocs);
  const hybrid = await searchParagraphs(e.query, 5);
  const h = hitRate(hybrid.map((x) => x.id), e.expectDocs);
  phraseHits += p; termHits += t; hybridHits += h;
  detail.push({ id: e.id, query: e.query, phrase: p ? "✓" : "✗", term: t ? "✓" : "✗", hybrid: h ? "✓" : "✗", note: e.note });
}

const n = evalSet.length;
console.log(`\n评测集 ${n} 题：`);
for (const d of detail) console.log(`  ${d.id} ${d.query}  A短语:${d.phrase}  B词项:${d.term}  C混合:${d.hybrid}  （${d.note}）`);
const pct = (x) => `${x}/${n}（${Math.round((x / n) * 100)}%）`;
console.log(`\nA 短语匹配 top5 命中率：${pct(phraseHits)}`);
console.log(`B 词项匹配 top5 命中率：${pct(termHits)}`);
console.log(`C 混合检索 top5 命中率：${pct(hybridHits)}`);

let verdict;
if (withVec === 0) {
  verdict = hybridHits > termHits
    ? "⚠️ 向量腿未生效（0 段有向量）——C 与 B 的差距来自 LIKE 兜底 + 追问加权 + RRF 结构，**不能**据此判断向量去留；先让 bge 模型可用并重新索引后重跑"
    : "⚠️ 向量腿未生效（0 段有向量）——本次对比只反映关键词腿差异，向量去留无法判定";
} else if (hybridHits > termHits) {
  verdict = "✅ 混合高于词项基线 → 向量 + RRF 有正贡献，保留向量";
} else if (hybridHits === termHits) {
  verdict = "⚠️ 与词项基线持平 → 向量可降级（关键词腿已够用）";
} else {
  verdict = "❌ 低于词项基线 → 排查（模型/切分/融合权重）";
}
console.log(`结论：${verdict}`);
