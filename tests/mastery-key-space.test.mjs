// 掌握度 key 空间回归护栏（闭环清查）：
// 写侧 recordKp(matchKp(topic)) 在未命中知识树时会用**归一化 topic 自身**当 key；
// 读侧若只按知识树内的点建 map（getMastery），树外条目永远 false → 「已掌握」不可达。
// 这里钉两件事：① 树外动态主题能写能读（getMasteryLookup 同 key 空间）；② 整句题干类脏键被拒收。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("mastery-key-space");
mockLLM();

const { recordKp, matchKp, getMasteryLookup, getMastery } = await import("../lib/knowledge.ts");

test("树外动态主题：写入后能按同一 key 读回，分数达阈值（「已掌握」可达）", () => {
  const topic = "防抖与节流手写实现"; // 非知识树文案，matchKp 会回落成归一化 topic 自身
  const key = matchKp(topic);
  assert.ok(key, `matchKp 应给出 key：${topic}`);
  for (let i = 0; i < 8; i++) recordKp(key, { correct: true, strong: true });
  const lookup = getMasteryLookup();
  assert.ok(lookup[key] >= 80, `落盘掌握表应含该 key 且 ≥80（实得 ${lookup[key]}）`);
  const treeOnly = new Map(getMastery().map((k) => [k.id, k.score]));
  if (!treeOnly.has(key)) {
    // 这正是修复前的断点：读侧只认树内点 → 树外条目恒 false
    assert.ok(lookup[key] >= 80, "读侧必须改用落盘快照（getMasteryLookup）", true);
  }
});

test("整句题干/问句类 key 被拒收（防 kp_mastery 脏键污染）", () => {
  const before = Object.keys(getMasteryLookup()).length;
  const dirty = "请继续深入讲讲「请继续深入讲讲「事件循环」」的手写能力、闭包、边界";
  recordKp(dirty, { correct: true, strong: true });
  recordKp("什么是事件循环？", { correct: true, strong: true });
  const after = Object.keys(getMasteryLookup());
  assert.equal(after.length, before, "脏键不得写入掌握表");
  assert.equal(after.some((k) => k.includes("请继续深入讲讲")), false, "追问句式不得入库");
  assert.equal(after.some((k) => k.includes("？")), false, "问句不得入库");
});
