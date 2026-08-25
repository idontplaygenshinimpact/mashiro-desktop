// validate-evaldata.mjs 自测 + 真数据合法性（Phase 评测 W1）
// 验收 §8.1：校验器全绿；故意塞坏样本（缺 source）→ 拒绝（校验器 exit 1 的等价语义）
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateList, validateAll, validateDataset } from "../scripts/validate-evaldata.mjs";

const good = { id: "t1", title: "题", question: "讲解", type: "coverage", must_cover: ["宏任务"], source: "测试来源" };

test("validateList：合法样本通过（各数据集类型枚举）", () => {
  assert.deepEqual(validateList("questions", [good]), []);
  assert.deepEqual(validateList("questions", [{ ...good, type: "code", fn: "f", test: "t" }]), []);
  assert.deepEqual(validateList("questions", [{ ...good, type: "predict", expected_stdout: "1" }]), []);
  assert.deepEqual(validateList("classify", [{ id: "c", text: "x", expected: "mianshi", source: "s" }]), []);
  assert.deepEqual(validateList("detect", [{ id: "d", text: "x", expected: true, source: "s" }]), []);
  assert.deepEqual(validateList("judge-gold", [{ id: "g", question: "q", answer: "a", label: "correct", source: "s" }]), []);
  assert.deepEqual(validateList("web-tasks", [{ id: "w", name: "n", difficulty: "easy", prompt: "p", judge: { type: "answer_contains", requiredKeywords: ["k"] }, timeoutMs: 100, source: "s" }]), []);
  assert.deepEqual(validateList("static", [{ id: "s", text: "x", expected: null, source: "s" }]), []);
});

test("validateList：缺 source → 拒绝（可追溯来源强制）", () => {
  const errs = validateList("questions", [{ id: "t1", title: "题", question: "x", type: "coverage", must_cover: ["宏任务"] }]);
  assert.ok(errs.some((e) => e.includes("source")), `应报缺 source: ${errs.join(";")}`);
});

test("validateList：类型枚举与必填字段拒绝", () => {
  assert.ok(validateList("questions", [{ ...good, type: "wrong-type" }]).length > 0, "type 非法");
  assert.ok(validateList("questions", [{ ...good, must_cover: [] }]).length > 0, "must_cover 空");
  assert.ok(validateList("questions", [{ ...good, type: "predict" }]).length > 0, "predict 缺 expected_stdout");
  assert.ok(validateList("questions", [{ ...good, type: "code" }]).length > 0, "code 缺 fn/test");
  assert.ok(validateList("classify", [{ ...good, expected: "不存在的类" }]).length > 0, "classify 类非法");
  assert.ok(validateList("detect", [{ ...good, expected: "true" }]).length > 0, "detect expected 非布尔");
  assert.ok(validateList("judge-gold", [{ ...good, label: "wrong" }]).length > 0, "judge-gold label 非法");
  assert.ok(validateList("web-tasks", [{ ...good, judge: { type: "bad" } }]).length > 0, "web judge.type 非法");
  assert.ok(validateList("static", [{ ...good, expected: 123 }]).length > 0, "static expected 非 string|null");
});

test("validateAll：6 个真实数据集全部合法（含 source/meta/version）", () => {
  const r = validateAll();
  assert.equal(r.ok, true, r.datasets.map((d) => d.errors?.join(";")).filter(Boolean).join("\n"));
  assert.equal(r.datasets.length, 6);
  for (const d of r.datasets) {
    assert.ok(d.count > 0, `${d.name} 非空`);
    assert.match(d.hash, /^[0-9a-f]{16}$/, `${d.name} datasetHash 格式`);
    assert.ok(d.version >= 2, `${d.name} version>=2`);
  }
});

test("datasetHash：同 version 样本变更 → hash 变化（回归对比同 hash 才可比）", async () => {
  const { createHash } = await import("node:crypto");
  const h = (cases) => createHash("sha256").update(`2|${JSON.stringify(cases)}`).digest("hex").slice(0, 16);
  assert.notEqual(h([good]), h([{ ...good, title: "改标题" }]), "样本变更 → hash 变化");
  assert.equal(h([good]), h([good]), "同样本同 hash");
});

test("validateDataset：真实 questions.json envelope 完整", () => {
  const r = validateDataset({ name: "questions", file: "benchmark/questions.json", listKey: "questions", check: (c, errs, ctx) => {
    if (!["code", "predict", "coverage", "trace"].includes(c.type)) errs.push("bad-type");
  } });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.count, 14);
});