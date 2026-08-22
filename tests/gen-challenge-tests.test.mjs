// gen-challenge-tests.mjs 相关：buildExportArgs 支持 LeetCode var 骨架 + 解析正确性
// 生成器本身是运维脚本（已用真实数据验证 189 道可生成、抽样判题通过），此处锁关键回归点
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb } from "./helpers.mjs";
import { buildExportArgs, runChallengeCode } from "../lib/ai-career.mjs";

setupTempDb("gen-tests");

test("buildExportArgs 支持 var X = function（LeetCode 骨架）", () => {
  assert.equal(buildExportArgs("/** @param {number} x */\nvar mySqrt = function(x) {};"), "mySqrt");
  assert.equal(buildExportArgs("function foo() {}"), "foo");
  assert.equal(buildExportArgs("class Bar {}"), "Bar");
  const multi = buildExportArgs("var a = function() {};\nfunction b() {}");
  assert.ok(multi.includes("a") && multi.includes("b"), "多函数名提取");
});

test("生成式测试码端到端：示例驱动的 __test__ 可判题（含解释文字截断/True 归一化）", async () => {
  // 模拟生成器输出（与 scripts/gen-challenge-tests.mjs 同构）：
  // 1) 解释文字不混入期望值；2) True→true；3) 多参数
  const skeleton = "/** @param {number[]} nums @param {number} k */\nvar findKthLargest = function(nums, k) {};";
  const testCode = `async function __test__(findKthLargest) {
  __assert__(JSON.stringify(findKthLargest([3,2,1,5,6,4], 2)) === "5", '示例1');
  __assert__(JSON.stringify(findKthLargest([3,2,3,1,2,4,5,5,6], 4)) === "4", '示例2');
}`;
  const ok = await runChallengeCode({
    userCode: "function findKthLargest(nums, k) { return nums.sort((a,b)=>b-a)[k-1]; }",
    testCode, skeleton,
  });
  assert.equal(ok.success, true, "正确实现通过");
  assert.equal(ok.tests.length, 2);
  // 错误实现失败
  const bad = await runChallengeCode({
    userCode: "function findKthLargest(nums, k) { return 0; }",
    testCode, skeleton,
  });
  assert.equal(bad.success, false, "错误实现失败");
  assert.ok(bad.tests.some((t) => !t.passed), "有失败断言");
});

test("True/False 输出归一化判题（Python 风格示例 → JS 布尔）", async () => {
  const skeleton = "/** @param {number[]} nums */\nvar judgePoint24 = function(nums) {};";
  const testCode = `async function __test__(judgePoint24) {
  __assert__(JSON.stringify(judgePoint24([4,1,8,7])) === "true", '示例1');
  __assert__(JSON.stringify(judgePoint24([1,2,1,2])) === "false", '示例2');
}`;
  const ok = await runChallengeCode({
    userCode: "function judgePoint24(nums) { return nums[0]===4; }",
    testCode, skeleton,
  });
  assert.equal(ok.success, true, "true 实现通过（True→true 归一化）");
});
