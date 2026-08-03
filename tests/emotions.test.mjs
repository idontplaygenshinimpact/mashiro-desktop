// emotions.mjs 单测
import { test } from "node:test";
import assert from "node:assert/strict";

const { EMOTIONS, pick } = await import("../lib/emotions.mjs");

test("EMOTIONS 各组非空且有内容", () => {
  for (const [k, arr] of Object.entries(EMOTIONS)) {
    assert.ok(Array.isArray(arr), `${k} 应为数组`);
    assert.ok(arr.length >= 2, `${k} 至少 2 句`);
    for (const s of arr) assert.ok(typeof s === "string" && s.length > 0, `${k} 内容非空`);
  }
});
test("pick 返回数组内元素", () => {
  const arr = ["a", "b", "c"];
  for (let i = 0; i < 20; i++) assert.ok(arr.includes(pick(arr)));
});
test("pick 空数组返回空串", () => {
  assert.equal(pick([]), "");
  assert.equal(pick(null), "");
  assert.equal(pick(undefined), "");
});
test("celebrate 情绪峰值稀缺性：仅完成任务组", () => {
  // 设计约束：庆祝语只在完成任务时出现（反差红利）——验证 celebrate 是独立小集合
  assert.ok(EMOTIONS.celebrate.length <= 5);
});
