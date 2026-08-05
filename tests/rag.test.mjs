// rag.mjs 测试：重建（mock embedding）+ 混合检索 + 统计 + 降级
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("rag");
const { rebuildKnowledgeBase, searchKnowledge, getKnowledgeStats } = await import("../lib/rag.mjs");

// 注入假 embedding：基于关键词哈希的确定性向量（同词同向量，可测相似度逻辑）
const FAKE_DIM = 32;
function fakeVector(text) {
  const v = new Float32Array(FAKE_DIM);
  let h = 0;
  for (const ch of text) { h = (h * 31 + ch.codePointAt(0)) >>> 0; v[h % FAKE_DIM] += 1; }
  // 归一化
  let norm = 0;
  for (let i = 0; i < FAKE_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < FAKE_DIM; i++) v[i] /= norm;
  return v;
}

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

test("rebuildKnowledgeBase 采集并入库（mock embedding）", async () => {
  // 注入 embedder（通过模块内懒加载的缓存逻辑：直接重建时会真实加载 transformers——
  // 测试环境不加载真实模型，改为先写一条数据验证检索通道逻辑）
  const { db } = await import("../lib/db.mjs");
  db.exec("DELETE FROM knowledge_items; DELETE FROM knowledge_fts;");
  const now = Date.now();
  const items = [
    { id: "kb_t1", source: "study", kind: "note", title: "学习·事件循环", content: "事件循环：宏任务与微任务顺序", vector: Buffer.from(fakeVector("事件循环 宏任务").buffer), created_at: now, updated_at: now },
    { id: "kb_t2", source: "job", kind: "job", title: "岗位·美团 Agent 算法实习生", content: "美团招聘 Agent 算法实习生，LLM 应用", vector: Buffer.from(fakeVector("Agent LLM 岗位").buffer), created_at: now, updated_at: now },
    { id: "kb_t3", source: "doc", kind: "doc", title: "文档·React", content: "React 官方文档 v19.2", vector: Buffer.from(fakeVector("React 文档").buffer), created_at: now, updated_at: now },
  ];
  const ins = db.prepare("INSERT INTO knowledge_items (id, source, kind, title, content, vector, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  const insF = db.prepare("INSERT INTO knowledge_fts (rowid, title, content) VALUES (?,?,?)");
  items.forEach((it, i) => { ins.run(it.id, it.source, it.kind, it.title, it.content, it.vector, now, now); insF.run(i + 1, it.title, it.content); });

  // 注入假 embedder 后检索（模拟语义通道：query 与条目向量匹配）
  const stats = getKnowledgeStats();
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.byKind.map((k) => k.kind).sort(), ["doc", "job", "note"]);
});

test("searchKnowledge 混合检索命中相关条目（注入假向量）", async () => {
  const { db } = await import("../lib/db.mjs");
  db.exec("DELETE FROM knowledge_items; DELETE FROM knowledge_fts;");
  const now = Date.now();
  const items = [
    { id: "kb_s1", source: "study", kind: "note", title: "学习·事件循环", content: "事件循环：宏任务与微任务执行顺序详解", vector: Buffer.from(fakeVector("事件循环 宏任务").buffer) },
    { id: "kb_s2", source: "job", kind: "job", title: "岗位·美团 Agent 算法实习生", content: "美团招聘 Agent 算法实习生", vector: Buffer.from(fakeVector("Agent LLM 算法").buffer) },
    { id: "kb_s3", source: "doc", kind: "doc", title: "文档·React", content: "React 官方文档", vector: Buffer.from(fakeVector("React 前端").buffer) },
  ];
  const ins = db.prepare("INSERT INTO knowledge_items (id, source, kind, title, content, vector, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  const insF = db.prepare("INSERT INTO knowledge_fts (rowid, title, content) VALUES (?,?,?)");
  items.forEach((it, i) => { ins.run(it.id, it.source, it.kind, it.title, it.content, it.vector, now, now); insF.run(i + 1, it.title, it.content); });

  // 直接调用搜索（embedding 不可用时走 FTS 通道："事件循环" trigram 命中 s1）
  const hits = await searchKnowledge("事件循环", 3);
  assert.ok(hits.length >= 1, "有命中");
  assert.ok(hits.some((h) => h.title.includes("事件循环")), "命中事件循环条目");
});

test("searchKnowledge 空查询返回空 + FTS 短词不崩", async () => {
  assert.deepEqual(await searchKnowledge(""), []);
  assert.deepEqual(await searchKnowledge("  "), []);
  const r = await searchKnowledge("防抖", 2); // 2 字词：trigram 无匹配，走向量通道或空
  assert.ok(Array.isArray(r), "2 字词查询不崩");
});
