// 个人学习知识库工单任务 1：段落级索引 + 混合检索测试
// 覆盖：段落切分（主文按标题/追问按 💬 标记）/ 混合检索（BM25 + followup 加权）/ 增量索引
// 注意：向量检索依赖 transformers 模型（测试环境不加载——embedText 失败返回 null → BM25 兜底）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("kb-base");
// 临时 study_notes 目录
const notesDir = path.join(dbDir, "out", "study_notes");
mkdirSync(notesDir, { recursive: true });
process.env.MIANSHI_OUTPUT_DIR = path.join(dbDir, "out");

const { splitStudyNote, indexStudyNotes, searchParagraphs, getParagraphStats, applyTransformersEnv } = await import("../lib/knowledge-base.mjs");

const DOC = `# 事件循环

## 结论
宏任务先执行完再清微任务队列，这是事件循环的核心调度顺序，理解这个顺序是理解异步的基础。

## 原理
事件循环是 JS 运行时的调度机制，宏任务与微任务分队列管理，每轮循环先清空微任务队列。

## 实现JS
\`\`\`js
console.log(1)
Promise.resolve().then(() => console.log(2))
\`\`\`

## 边界
异常/性能/兼容性——嵌套微任务可能饿死宏任务，需要注意这个边界情况。

## 💬 追问：宏任务和微任务谁先执行

微任务先执行，Promise.then 是微任务，setTimeout 回调是宏任务。

---
## 💬 追问：setTimeout 为什么不准时

因为宏任务队列要等微任务清完，定时器回调排在宏任务队列尾部。
`;

beforeEach(async () => {
  await clearAllTables();
  rmSync(notesDir, { recursive: true, force: true });
  mkdirSync(notesDir, { recursive: true });
});

test("段落切分：主文按标题 + 追问按 💬 标记（kind 区分）", () => {
  const paras = splitStudyNote(DOC);
  const mains = paras.filter((p) => p.kind === "main");
  const followups = paras.filter((p) => p.kind === "followup");
  assert.ok(mains.length >= 4, `主文段 ≥4（结论/原理/实现/边界——实际 ${mains.length}）`);
  assert.equal(followups.length, 2, "追问段 2 条");
  assert.ok(followups[0].section.includes("宏任务和微任务谁先执行"), "追问段标题含问题");
  assert.ok(followups[0].content.includes("微任务先执行"), "追问段内容完整");
});

test("增量索引：文档写入 → 段落入库；追加追问 → 段落数更新", () => {
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC, "utf8");
  const r1 = indexStudyNotes();
  assert.ok(r1.added >= 6, `首次索引 ${r1.added} 段`);
  const stats1 = getParagraphStats();
  assert.equal(stats1.docs, 1, "1 篇文档");
  assert.equal(stats1.followups, 2, "2 段追问");
  // 追加追问 → mtime 变化 → 重刷
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC + "\n---\n## 💬 追问：第三问\n\n第三问回答内容足够长，用于验证增量索引的追问段落更新逻辑。\n", "utf8");
  const r2 = indexStudyNotes();
  assert.ok(r2.added >= 1, "增量重刷");
  const stats2 = getParagraphStats();
  assert.equal(stats2.followups, 3, "追问段更新为 3");
  // 幂等：未变化不重刷
  const r3 = indexStudyNotes();
  assert.equal(r3.added, 0, "未变化不重刷");
});

test("混合检索：BM25 命中主文段 + followup 加权优先", async () => {
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC, "utf8");
  indexStudyNotes();
  // 精确词命中主文（空格拆词 OR——trigram 短语不命中中文连续串）
  const hits = await searchParagraphs("宏任务 微任务", 5);
  assert.ok(hits.length >= 1, "有命中");
  // followup 加权：检索"微任务"→ 追问段应优先（用户亲手问的）
  const fuHits = await searchParagraphs("微任务", 5);
  const top = fuHits[0];
  assert.ok(top, "有结果");
  // 追问段加权后应出现在结果中（不强制第一——加权 +2 排名）
  assert.ok(fuHits.some((h) => h.kind === "followup"), "追问段进入结果（加权）");
});

test("混合检索：无命中返回空数组（不崩）", async () => {
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC, "utf8");
  indexStudyNotes();
  const hits = await searchParagraphs("完全不存在的词xyzabc", 5);
  assert.deepEqual(hits, [], "无命中空数组");
  const empty = await searchParagraphs("", 5);
  assert.deepEqual(empty, [], "空 query 空数组");
});

test("混合检索：跨文档聚合（多文档命中）", async () => {
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC, "utf8");
  writeFileSync(path.join(notesDir, "闭包.md"), "# 闭包\n\n## 原理\n闭包是函数与其词法作用域的组合，内部函数可以访问外部函数的变量，这是 JS 的核心特性。\n\n## 边界\n闭包可能导致内存泄漏风险，需要注意引用释放。\n", "utf8");
  indexStudyNotes();
  const hits = await searchParagraphs("闭包", 5);
  assert.ok(hits.some((h) => h.docId === "闭包"), "闭包文档命中");
  const stats = getParagraphStats();
  assert.equal(stats.docs, 2, "2 篇文档");
});

// ---------- 个人学习知识库工单任务 2：rerank 精排（交叉编码器——测试环境无模型 → 降级 RRF 原序） ----------
test("任务2：rerankParagraphs 模型不可用 → 降级 RRF 原序（不炸）", async () => {
  const { rerankParagraphs } = await import("../lib/knowledge-base.mjs");
  const candidates = [
    { id: "a", content: "事件循环原理内容" },
    { id: "b", content: "闭包作用域内容" },
  ];
  // 测试环境 transformers 模型不可用（getReranker 失败 → null）→ 降级原序
  const out = await rerankParagraphs("事件循环", candidates, 2);
  assert.equal(out.length, 2, "降级返回全部候选");
  assert.deepEqual(out.map((o) => o.id), ["a", "b"], "降级保持 RRF 原序");
});

test("任务2：searchParagraphsReranked 降级路径（模型不可用 → RRF 结果）", async () => {
  const { searchParagraphsReranked } = await import("../lib/knowledge-base.mjs");
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC, "utf8");
  indexStudyNotes();
  const hits = await searchParagraphsReranked("宏任务 微任务", 5);
  assert.ok(hits.length >= 1, "降级仍有结果");
  assert.ok(hits.every((h) => h.rerankScore !== undefined), "rerankScore 字段存在（降级为 0）");
});

// ---------- 个人学习知识库工单任务 3：追问段落 → 复习卡 ----------
test("任务3：追问段落 → 复习卡（source=追问，进 FSRS 调度；幂等不重复建）", async () => {
  const { followupsToReviewCards } = await import("../lib/knowledge-base.mjs");
  const { review } = await import("../lib/review.mjs");
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC, "utf8");
  indexStudyNotes();
  const r1 = await followupsToReviewCards();
  assert.ok(r1.added.length >= 2, `2 个追问转复习卡（实际 ${r1.added.length}）`);
  // 卡已建（source=追问）
  const cards = review.loadCards().cards;
  const fuCards = cards.filter((c) => c.source === "追问");
  assert.ok(fuCards.length >= 2, "追问卡存在");
  assert.ok(fuCards.some((c) => c.topic.includes("宏任务和微任务谁先执行")), "追问问题成为卡 topic");
  // 幂等：再跑不重复建（同 topic 更新）
  await followupsToReviewCards();
  const cards2 = review.loadCards().cards.filter((c) => c.source === "追问");
  assert.equal(cards2.length, fuCards.length, "幂等不重复建");
});

// ---------- 模型运行环境（2026-09-11：向量腿静默失效的根因） ----------
test("模型环境：镜像 env 生效 + 缓存目录落到 data/models（不再污染仓库根 .cache）", () => {
  const env = {};
  applyTransformersEnv(env, { MIANSHI_HF_ENDPOINT: "https://hf-mirror.com" });
  assert.equal(env.remoteHost, "https://hf-mirror.com/", "缺尾斜杠自动补");
  assert.ok(env.cacheDir.includes(path.join("models", "transformers")), "缓存目录 = <data>/models/transformers");

  const envStd = {};
  applyTransformersEnv(envStd, { HF_ENDPOINT: "https://hf-mirror.com/" });
  assert.equal(envStd.remoteHost, "https://hf-mirror.com/", "标准 HF_ENDPOINT 也认");

  const envBoth = {};
  applyTransformersEnv(envBoth, { MIANSHI_HF_ENDPOINT: "https://a.example", HF_ENDPOINT: "https://b.example" });
  assert.equal(envBoth.remoteHost, "https://a.example/", "MIANSHI_ 前缀优先");

  const envDefault = {};
  const applied = applyTransformersEnv(envDefault, {});
  assert.equal(envDefault.remoteHost, undefined, "未配置镜像时不覆盖 transformers 默认远端（huggingface.co）");
  assert.equal(applied.remoteHost, "https://huggingface.co/", "返回值报告实际生效的远端");
});

// ---------- 向量回填（2026-09-11：此前 vector 列只读不写 → 混合检索实际退化成纯关键词） ----------
test("向量回填：注入 embedder → 写入向量且幂等；模型不可用 → 不写空向量", async () => {
  const { backfillVectors, countMissingVectors, getParagraphStats } = await import("../lib/knowledge-base.mjs");
  writeFileSync(path.join(notesDir, "事件循环.md"), DOC, "utf8");
  indexStudyNotes();
  const before = countMissingVectors();
  assert.ok(before > 0, `索引后应有待向量化段落（实际 ${before}）`);

  // 模型不可用：不写空向量、如实报告（测试里注入 embedder，避免真去下载模型）
  const failed = await backfillVectors({ limit: 5, embed: async () => null });
  assert.equal(failed.embedded, 0, "模型不可用时不写向量");
  assert.equal(failed.modelAvailable, false, "如实报告模型不可用");
  assert.equal(countMissingVectors(), before, "缺向量数不变");

  // 注入假 embedder → 正常写入
  const fake = async (text) => Float32Array.from([String(text).length % 7, 1, 0, 0]);
  const ok = await backfillVectors({ limit: 1000, embed: fake });
  assert.ok(ok.embedded >= before, `写入 ${ok.embedded} 段向量`);
  assert.equal(ok.remaining, 0, "全部补齐");
  assert.equal(countMissingVectors(), 0, "缺向量归零");

  const stats = getParagraphStats();
  assert.equal(stats.withVectors, stats.total, "统计口径：withVectors = total");
  assert.equal(stats.missingVectors, 0);

  // 幂等：再跑没有可写的
  const again = await backfillVectors({ limit: 100, embed: fake });
  assert.equal(again.embedded, 0, "幂等：无待写段落");
  assert.equal(again.modelAvailable, true);
});

after(() => { cleanupTempDb(dbDir); });
