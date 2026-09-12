// lane.ts 测试：串行执行/错误隔离/状态
// 2026-09：用 createLane 独立实例——lane 是全局单例，测试文件并发时其他测试的
// submit 会污染队列（CI flaky：慢任务耗时断言 <100ms——队列被并发任务干扰）
import { test } from "node:test";
import assert from "node:assert/strict";

const { submit, laneStatus } = await import("../lib/lane.ts").then((m) => m.createLane());

test("串行执行：任务按提交顺序完成，前一个完成后才下一个", async () => {
  const order = [];
  const p1 = submit(async () => { await new Promise((r) => setTimeout(r, 80)); order.push("A"); return "A"; });
  const p2 = submit(async () => { order.push("B"); return "B"; });
  const p3 = submit(async () => { order.push("C"); return "C"; });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ["A", "B", "C"], "严格串行顺序");
  assert.equal(r1, "A");
  assert.equal(r2, "B");
  assert.equal(r3, "C");
});

test("慢任务不阻塞队列进度（排队等待）", async () => {
  const start = Date.now();
  // 慢任务用 300ms（原 100ms）：全套件并行跑时主线程可能被 GC/调度卡住上百毫秒，
  // 100ms 的慢任务有概率在"提交 p2 后立刻断言 queued"之前就跑完 → 断言随机失败（CI flaky）。
  // 断言语义不变（p2 排队/串行/队列清空），只是让"慢"真的慢到不会被调度抖动吃掉。
  const SLOW_MS = 300;
  const p1 = submit(async () => { await new Promise((r) => setTimeout(r, SLOW_MS)); return 1; });
  // p2 排队，但 laneStatus 能看到 queued
  const p2 = submit(async () => 2);
  assert.equal(laneStatus().queued >= 1, true, "p2 在队列中");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.ok(Date.now() - start >= SLOW_MS);
  assert.equal(laneStatus().queued, 0, "队列清空");
});

test("错误隔离：任务抛错 reject，后续任务正常执行", async () => {
  const p1 = submit(async () => { throw new Error("boom"); });
  const p2 = submit(async () => "ok2");
  await assert.rejects(p1, /boom/);
  const r2 = await p2;
  assert.equal(r2, "ok2", "错误任务不阻塞后续");
});

test("laneStatus 空闲状态", () => {
  const s = laneStatus();
  assert.equal(typeof s.queued, "number");
  assert.equal(typeof s.running, "boolean");
});
