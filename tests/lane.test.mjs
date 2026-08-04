// lane.mjs 测试：串行执行/错误隔离/状态
import { test } from "node:test";
import assert from "node:assert/strict";

const { submit, laneStatus } = await import("../lib/lane.mjs");

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
  const p1 = submit(async () => { await new Promise((r) => setTimeout(r, 100)); return 1; });
  // p2 排队，但 laneStatus 能看到 queued
  const p2 = submit(async () => 2);
  assert.equal(laneStatus().queued >= 1, true, "p2 在队列中");
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.ok(Date.now() - start >= 100);
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
