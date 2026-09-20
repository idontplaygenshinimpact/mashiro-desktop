// 链表/树沙箱构造器 护栏（2026-09-16）：__buildListNode__/__listToArray__/__buildTreeNode__/__treeToArray__
// 由来：448 道 core 题里 167 道没有 test_code，其中 74 道是链表/树题（示例输入是数组，过去无法构造节点 →
// 一律跳过，点判题恒失败）。给沙箱加 LeetCode 惯例的构造/序列化后，scripts/gen-listtree-tests.mjs 才能
// 把「输入: head = [1,2,5] 输出: [1,2,5]」变成断言。本护栏用**真沙箱**验证四个辅助函数的语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("listtree-helpers");
mockLLM();
const { runChallengeCode } = await import("../lib/ai-career.ts");

/** 跑一段用户代码 + 断言（走真沙箱：worker + vm） */
async function run(code, skeleton, testCode) {
  return runChallengeCode({ userCode: code, testCode, skeleton });
}

const T = `async function __test__(solve) { __assert__(JSON.stringify(solve()) === "\\"ok\\"", "solver 返回 ok"); }`;

test("链表：__buildListNode__ → __listToArray__ 往返一致（含空数组/单元素）", async () => {
  const code = `function solve() { const a = __buildListNode__([1, 2, 3]); return JSON.stringify(__listToArray__(a)) === "[1,2,3]" && JSON.stringify(__listToArray__(__buildListNode__([]))) === "[]" && JSON.stringify(__listToArray__(__buildListNode__([7]))) === "[7]" ? "ok" : "bad"; }`;
  const r = await run(code, "function solve() {}", T);
  assert.equal(r.success, true, `链表往返应一致：${JSON.stringify(r.tests)} ${r.error || ""}`);
});

test("树：__buildTreeNode__ → __treeToArray__ 往返一致（含 null 空位与尾部裁剪）", async () => {
  const code = `function solve() {
    const t = __buildTreeNode__([1, null, 2, 3]);
    const ok1 = JSON.stringify(__treeToArray__(t)) === "[1,null,2,3]";
    const ok2 = JSON.stringify(__treeToArray__(__buildTreeNode__([1, 2, 3]))) === "[1,2,3]";
    const ok3 = __buildTreeNode__([]) === null && __treeToArray__(null).length === 0;
    return ok1 && ok2 && ok3 ? "ok" : ("bad:" + JSON.stringify(__treeToArray__(t)));
  }`;
  const r = await run(code, "function solve() {}", T);
  assert.equal(r.success, true, `树往返应一致：${JSON.stringify(r.tests)} ${r.error || ""}`);
});

test("有环链表不会让 __listToArray__ 死循环（靠 limit 兜底返回前 N 个）", async () => {
  const code = `function solve() { const a = __buildListNode__([1, 2, 3]); let cur = a; while (cur.next) cur = cur.next; cur.next = a; const arr = __listToArray__(a, 5); return arr.length === 5 && arr[3] === 1 ? "ok" : ("bad:" + JSON.stringify(arr)); }`;
  const r = await run(code, "function solve() {}", T);
  assert.equal(r.success, true, `有环应被 limit 兜住：${JSON.stringify(r.tests)} ${r.error || ""}`);
});

test("生成的 test_code 形态可判题（示例→构造器→序列化比较，且失败会如实报错）", async () => {
  // 与 scripts/gen-listtree-tests.mjs 产物同形：数组入参用构造器包一层，期望值用序列化比较
  const testCode = `async function __test__(reverseList) {
  {
    const __ret__ = reverseList(__buildListNode__([1,2,3]));
    __assert__(JSON.stringify(__listToArray__(__ret__)) === "[3,2,1]", "示例1");
  }
}`;
  const right = `function reverseList(head) { let prev = null; while (head) { const n = head.next; head.next = prev; prev = head; head = n; } return prev; }`;
  const wrong = `function reverseList(head) { return head; }`;
  const skeleton = "function reverseList(head) {}";
  const r1 = await run(right, skeleton, testCode);
  assert.equal(r1.success, true, `正确解应通过：${JSON.stringify(r1.tests)} ${r1.error || ""}`);
  const r2 = await run(wrong, skeleton, testCode);
  assert.equal(r2.success, false, "错误解必须被判失败（测试不能空转）");
  assert.equal(r2.tests.length > 0, true, "断言应真的执行（tests 非空）");
});
