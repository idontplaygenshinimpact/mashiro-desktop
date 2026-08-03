// llm.mjs 纯函数单测：extractJson / getReplyText
import { test } from "node:test";
import assert from "node:assert/strict";

const { extractJson, getReplyText } = await import("../lib/llm.mjs");

test("extractJson：纯 JSON 直接解析", () => {
  assert.deepEqual(extractJson('{"a":1,"b":"x"}'), { a: 1, b: "x" });
});
test("extractJson：```json 代码块包裹", () => {
  const raw = '```json\n{"items":[{"topic":"事件循环"}]}\n```';
  assert.deepEqual(extractJson(raw), { items: [{ topic: "事件循环" }] });
});
test("extractJson：裸 ``` 代码块包裹", () => {
  const raw = '```\n{"ok":true}\n```';
  assert.deepEqual(extractJson(raw), { ok: true });
});
test("extractJson：前后缀文本包裹", () => {
  const raw = '好的，结果如下：\n{"verdict":"对","comment":"不错"}\n以上就是全部内容';
  assert.deepEqual(extractJson(raw), { verdict: "对", comment: "不错" });
});
test("extractJson：嵌套大括号内容", () => {
  const raw = '{"a":{"b":{"c":[1,2,{"d":"}"}]}}}';
  assert.deepEqual(extractJson(raw), { a: { b: { c: [1, 2, { d: "}" }] } } });
});
test("extractJson：无 JSON 返回 null", () => {
  assert.equal(extractJson("这不是 JSON 内容"), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
});
test("extractJson：字符串里的引号不会提前截断", () => {
  const raw = '{"text":"他说：\\"你好\\""}';
  assert.deepEqual(extractJson(raw), { text: '他说："你好"' });
});
test("getReplyText：从 OpenAI 响应提取 content", () => {
  const data = { choices: [{ message: { content: "回答内容" } }] };
  assert.equal(getReplyText(data), "回答内容");
});
test("getReplyText：空响应返回空串", () => {
  assert.equal(getReplyText(null), "");
  assert.equal(getReplyText({}), "");
  assert.equal(getReplyText({ choices: [] }), "");
});
