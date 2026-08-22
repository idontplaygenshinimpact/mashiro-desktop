// pipeline 管线测试：顺序执行/中间产物/错误处理（fatal vs 非 fatal）+ discover 阶段函数
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline, pipelineSummary } from "../lib/pipeline.mjs";

test("runPipeline 顺序执行阶段并记录耗时", async () => {
  const order = [];
  const ctx = {};
  await runPipeline(
    [
      { name: "a", run: () => { order.push("a"); ctx.a = 1; } },
      { name: "b", run: async () => { order.push("b"); ctx.b = ctx.a + 1; } },
    ],
    ctx
  );
  assert.deepEqual(order, ["a", "b"], "阶段按序执行");
  assert.equal(ctx.b, 2, "中间产物跨阶段传递");
  assert.ok(ctx.stageTimings.a >= 0 && ctx.stageTimings.b >= 0, "耗时记录");
});

test("runPipeline 非 fatal 阶段失败 → 记录并继续", async () => {
  const ctx = {};
  await runPipeline(
    [
      { name: "fail", run: () => { throw new Error("boom"); } },
      { name: "after", run: () => { ctx.done = true; } },
    ],
    ctx
  );
  assert.equal(ctx.done, true, "失败后继续执行");
  assert.equal(ctx.errors.length, 1, "错误被记录");
  assert.equal(ctx.errors[0].stage, "fail");
});

test("runPipeline fatal 阶段失败 → 中断并抛错", async () => {
  const ctx = {};
  await assert.rejects(
    () => runPipeline(
      [
        { name: "fatal", run: () => { throw new Error("fatal-boom"); }, fatal: true },
        { name: "never", run: () => { ctx.done = true; } },
      ],
      ctx
    ),
    /fatal-boom/
  );
  assert.ok(!ctx.done, "fatal 后不再执行");
});

test("runPipeline onStage 回调带耗时", async () => {
  const seen = [];
  await runPipeline([{ name: "x", run: () => {} }], {}, {
    onStage: (name, c, ms) => seen.push([name, ms]),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "x");
  assert.equal(typeof seen[0][1], "number");
});

test("pipelineSummary 输出阶段耗时与失败", () => {
  const s = pipelineSummary({ stageTimings: { a: 100 }, errors: [{ stage: "b", error: "x" }] });
  assert.ok(s.includes("a: 0.1s"));
  assert.ok(s.includes("b"));
});
