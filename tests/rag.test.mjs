// rag.mjs 测试：混合检索（FTS5 id 关联 + 向量通道）/ RAG 问答降级 / 增量更新
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("rag");
const { searchKnowledge, getKnowledgeStats, incrementalRebuild, getIndexedMtimes } = await import("../lib/rag.mjs");
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
  seed([
    { id: "kb_s1", source: "study", kind: "note", title: "学习·事件循环", content: "事件循环：宏任务与微任务执行顺序详解", text: "事件循环 宏任务" },
    { id: "kb_s2", source: "job", kind: "job", title: "岗位·美团 Agent 算法实习生", content: "美团招聘 Agent 算法实习生", text: "Agent LLM 算法" },
    { id: "kb_s3", source: "doc", kind: "doc", title: "文档·React", content: "React 官方文档", text: "React 前端" },
  ]);
});
after(() => { cleanupTempDb(dbDir); });

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
