// Vue 复习面板 P0 修复验证（useReview.js）：
// ①真实队列加载（r.due + c.topic 映射）；②评分数字 0..3 提交（对齐 Grades 坐标）；
// ③demo 卡不上报后端；④提交失败可见（不再 fire-and-forget 静默）
import { test } from "node:test";
import assert from "node:assert/strict";

const { useReview } = await import("../desktop/renderer/panel-vue-review/src/useReview.js");

function realCard(over = {}) {
  return {
    id: "cmsbhz2n7", topic: "事件循环：宏任务与微任务", question: "说说事件循环", answer: "先同步→微任务→宏任务",
    fsrs: { state: 2, stability: 3.2, difficulty: 5.0, due: new Date(Date.now() - 3600e3).toISOString() },
    ...over,
  };
}

test("① 真实队列加载：读 r.due（非 r.cards）+ 标题映射 c.topic", async () => {
  globalThis.window = {
    kanban: { reviewDue: async () => ({ due: [realCard()] }), reviewSubmit: async () => ({ ok: true }) },
  };
  const rv = useReview();
  await rv.load();
  assert.equal(rv.cards.value.length, 1, "真实卡加载（非 demo 回退）");
  assert.equal(rv.cards.value[0].title, "事件循环：宏任务与微任务", "标题来自 topic 字段");
  assert.equal(rv.cards.value[0].answer, "先同步→微任务→宏任务", "答案字段");
  assert.equal(rv.cards.value[0].demo, false, "真实卡非 demo");
});

test("② 评分提交：数字 0..3（again=0/good=2），对齐后端 Grades[ratingNum] 坐标", async () => {
  const submits = [];
  globalThis.window = {
    kanban: {
      reviewDue: async () => ({ due: [realCard(), realCard({ id: "card-2", topic: "浏览器缓存" })] }),
      reviewSubmit: async (id, rating) => { submits.push([id, rating]); return { ok: true }; },
    },
  };
  const rv = useReview();
  await rv.load();
  await rv.rate("good");
  assert.deepEqual(submits[0], ["cmsbhz2n7", 2], "good → 2（数字，非字符串 'good'）");
  await rv.rate("again");
  assert.equal(submits[1][1], 0, "again → 0");
});

test("③ demo 卡绝不提交后端（无 kanban/加载失败回退示例数据）", async () => {
  const submits = [];
  globalThis.window = {
    kanban: {
      reviewDue: async () => ({ due: [] }), // 空队列 → 回退 DEMO
      reviewSubmit: async (id, rating) => { submits.push([id, rating]); return { ok: true }; },
    },
  };
  const rv = useReview();
  await rv.load();
  assert.equal(rv.cards.value.length, 4, "demo 卡回退（DEMO_CARDS 4 张：事件循环/Vue响应式/浏览器缓存/防抖节流）");
  assert.ok(rv.cards.value.every((c) => c.demo === true), "全部标记 demo");
  await rv.rate("good");
  assert.equal(submits.length, 0, "demo 卡不调 reviewSubmit（防 id 污染后端）");
});

test("④ 提交失败可见：error 暴露，不静默（fire-and-forget 修复）", async () => {
  globalThis.window = {
    kanban: {
      reviewDue: async () => ({ due: [realCard()] }),
      reviewSubmit: async () => ({ ok: false, error: "rating 必须 0-3" }),
    },
  };
  const rv = useReview();
  await rv.load();
  await rv.rate("good");
  assert.ok(rv.error.value.includes("rating"), "提交失败写入 error（可观测）");
});
