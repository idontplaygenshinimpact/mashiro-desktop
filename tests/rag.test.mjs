// rag.mjs 测试：混合检索（FTS5 id 关联 + 向量通道）/ RAG 问答降级 / 增量更新
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("rag");
// 隔离真实 output/ 与真实 embedding 模型（必须在 import rag.mjs 之前设置——模块顶层求值 OUTPUT_DIR/EMBED_MODEL）
const outDir = mkdtempSync(path.join(tmpdir(), "rag-test-out-"));
mkdirSync(outDir, { recursive: true });
process.env.RAG_OUTPUT_DIR = outDir;
process.env.RAG_EMBED_MODEL = "Xenova/nonexistent-model-for-test"; // 强制 embedding 降级，避免加载真实模型拖慢测试
const { searchKnowledge, getKnowledgeStats, incrementalRebuild, getIndexedMtimes, markVerified } = await import("../lib/rag.mjs");
const { db } = await import("../lib/db.mjs");

// 假向量：基于文本哈希的确定性 32 维向量（测通道逻辑，不加载真实模型）
const FAKE_DIM = 32;
function fakeVector(text) {
  const v = new Float32Array(FAKE_DIM);
  let h = 0;
  for (const ch of text) { h = (h * 31 + ch.codePointAt(0)) >>> 0; v[h % FAKE_DIM] += 1; }
  let norm = 0;
  for (let i = 0; i < FAKE_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < FAKE_DIM; i++) v[i] /= norm;
  return v;
}

// ---------- 闭环：牛客真题/刷题 → 知识库（collectDbAssets 题目级资产） ----------
test("collectDbAssets：真题题目 + TOP101 刷题进知识库（选择题出题素材闭环）", async () => {
  // 建表 + 插数据（zhenti/oj 模块的表）
  db.exec(`CREATE TABLE IF NOT EXISTS exam_papers (
    id TEXT PRIMARY KEY, kind TEXT, company TEXT, title TEXT, test_id TEXT, url TEXT,
    question_count INTEGER, single_count INTEGER, multi_count INTEGER, program_count INTEGER,
    job_tags TEXT, found_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS exam_questions (
    id TEXT PRIMARY KEY, paper_test_id TEXT, q_index INTEGER, q_type TEXT, title TEXT, options TEXT, answer TEXT, created_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS exam_problems (
    id TEXT PRIMARY KEY, category TEXT, bm_no TEXT, title TEXT, difficulty TEXT, people TEXT, url TEXT, created_at INTEGER, updated_at INTEGER)`);
  db.prepare("INSERT INTO exam_papers (id, kind, company, title, test_id, url, found_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("p1", "real", "字节跳动", "2024校招前端笔试", "t1001", "https://nowcoder.com/test/1001", Date.now(), Date.now());
  db.prepare("INSERT INTO exam_questions (id, paper_test_id, q_index, q_type, title, options, answer, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("q1", "t1001", 1, "single", "事件循环中微任务何时执行？", JSON.stringify(["A", "B"]), "B", Date.now());
  db.prepare("INSERT INTO exam_problems (id, category, bm_no, title, difficulty, people, url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("oj1", "链表", "BM1", "反转链表", "简单", "41.2w", "https://nowcoder.com/practice/oj1", Date.now(), Date.now());

  const r = await incrementalRebuild();
  assert.ok(r.ok !== false, "增量重建不崩");
  const q = db.prepare("SELECT * FROM knowledge_items WHERE source='zhenti-q'").all();
  assert.ok(q.length >= 1, "真题题目进知识库");
  assert.ok(q[0].content.includes("事件循环"), "真题题干入库");
  const o = db.prepare("SELECT * FROM knowledge_items WHERE source='oj'").all();
  assert.ok(o.length >= 1, "TOP101 刷题进知识库");
  assert.ok(o[0].content.includes("反转链表"), "刷题标题入库");
});

const seed = (items) => {
  const now = Date.now();
  const ins = db.prepare("INSERT INTO knowledge_items (id, source, kind, title, content, vector, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  const insF = db.prepare("INSERT INTO knowledge_fts (id, title, content) VALUES (?,?,?)");
  items.forEach((it) => {
    ins.run(it.id, it.source, it.kind, it.title, it.content, Buffer.from(fakeVector(it.text).buffer), now, now);
    insF.run(it.id, it.title, it.content);
  });
};

beforeEach(async () => {
  await clearAllTables();
  // RAG 默认关闭（设置中心可配）——测试显式开启
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('rag_enabled','1',?)").run(Date.now());
  seed([
    { id: "kb_s1", source: "study", kind: "note", title: "学习·事件循环", content: "事件循环：宏任务与微任务执行顺序详解", text: "事件循环 宏任务" },
    { id: "kb_s2", source: "job", kind: "job", title: "岗位·美团 Agent 算法实习生", content: "美团招聘 Agent 算法实习生", text: "Agent LLM 算法" },
    { id: "kb_s3", source: "doc", kind: "doc", title: "文档·React", content: "React 官方文档", text: "React 前端" },
  ]);
});
after(() => { cleanupTempDb(dbDir); rmSync(outDir, { recursive: true, force: true }); });

test("searchKnowledge 命中相关条目（FTS 通道按 id 关联）", async () => {
  const hits = await searchKnowledge("事件循环", 3);
  assert.ok(hits.length >= 1, "有命中");
  assert.ok(hits.some((h) => h.title.includes("事件循环")), "命中事件循环条目");
  for (const h of hits) {
    assert.ok(h.id && h.title && h.kind, "返回字段完整");
  }
});

test("searchKnowledge 空查询返回空 + 2 字词不崩", async () => {
  assert.deepEqual(await searchKnowledge(""), []);
  assert.deepEqual(await searchKnowledge("  "), []);
  const r = await searchKnowledge("防抖", 2); // trigram 对 2 字词无效，走向量通道或空
  assert.ok(Array.isArray(r), "2 字词查询不崩");
});

test("getKnowledgeStats 统计按 kind 分组", () => {
  const s = getKnowledgeStats();
  assert.equal(s.total, 3);
  assert.deepEqual(s.byKind.map((k) => k.kind).sort(), ["doc", "job", "note"]);
});

test("incrementalRebuild md 未变化时只重刷 DB 资产（不崩）", async () => {
  const r = await incrementalRebuild();
  assert.equal(typeof r.changed, "boolean");
  assert.ok(r.added >= 0 && r.removed >= 0);
  assert.ok(getIndexedMtimes() instanceof Object, "mtime 索引可读");
});

test("weak_points 索引入库（regression: note 列不存在导致薄弱点从未入库）", async () => {
  db.prepare("INSERT INTO weak_points (id, topic, fail_count, last_failed_at, source, origin, updated_at) VALUES ('wp_ev','事件循环',3,NULL,'复盘','agent',1)").run();
  const r = await incrementalRebuild();
  assert.equal(typeof r.changed, "boolean");
  const weakRows = db.prepare("SELECT title, content FROM knowledge_items WHERE source='weak'").all();
  assert.ok(weakRows.length >= 1, "薄弱点已索引进知识库");
  assert.ok(weakRows.some((w) => w.title.includes("事件循环")), "薄弱点主题存在");
});

// ---------- claim layer：可信度 / 溯源证据 / 人工验证 ----------
test("新知识条目默认 confidence 0.5（claim layer 默认可信度）", () => {
  const row = db.prepare("SELECT confidence, evidence, last_verified_at FROM knowledge_items WHERE id='kb_s1'").get();
  assert.equal(row.confidence, 0.5);
  assert.equal(row.evidence, "");
  assert.equal(row.last_verified_at, null);
});

test("weak 薄弱点入库 confidence 0.3 + evidence 复盘弱项", async () => {
  db.prepare("INSERT INTO weak_points (id, topic, fail_count, last_failed_at, source, origin, updated_at) VALUES ('wp_c','闭包',2,NULL,'复盘','agent',1)").run();
  await incrementalRebuild();
  const row = db.prepare("SELECT confidence, evidence FROM knowledge_items WHERE source='weak' AND title LIKE '%闭包%'").get();
  assert.ok(row, "薄弱点已入库");
  assert.equal(row.confidence, 0.3);
  assert.equal(row.evidence, "复盘弱项");
});

test("markVerified 更新 confidence + last_verified_at；非法 id → ok:false", () => {
  const r = markVerified("kb_s1", 0.9);
  assert.equal(r.ok, true);
  assert.ok(r.lastVerifiedAt > 0);
  const row = db.prepare("SELECT confidence, last_verified_at FROM knowledge_items WHERE id='kb_s1'").get();
  assert.equal(row.confidence, 0.9);
  assert.ok(row.last_verified_at > 0, "验证时间戳写入");
  // 越界 confidence 收敛到 0.9
  assert.equal(markVerified("kb_s2", 99).confidence, 0.9);
  // 不存在的 id
  assert.equal(markVerified("kb_nope", 0.8).ok, false);
});
