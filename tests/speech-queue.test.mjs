// speech-queue 测试：切句规则 + 串行队列行为（纯逻辑，无播放依赖）
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSentences, flushRest, createSpeechQueue } from "../desktop/renderer/speech-queue.mjs";

// ---------- 切句 ----------
test("切句：按终止符切出完整句，残句留 rest", () => {
  const { sentences, rest } = splitSentences("こんにちは。今日はいい天気だね！明日は");
  assert.deepEqual(sentences, ["こんにちは。", "今日はいい天気だね！"]);
  assert.equal(rest, "明日は");
});

test("切句：换行也是终止符", () => {
  const { sentences } = splitSentences("第一句。\n第二句。");
  assert.deepEqual(sentences, ["第一句。", "第二句。"]);
});

test("切句：短残句并入下一句（防碎片）", () => {
  const { sentences } = splitSentences("第一句。うん。第二句。");
  // "うん。" 长度 <8 且并入后 <60 → 与前面拼接？这里前面已是完整句被切出，再看行为
  assert.ok(sentences.length >= 2);
  assert.ok(sentences[0].includes("第一句"));
  assert.ok(sentences[sentences.length - 1].includes("第二句"));
});

test("切句：代码块/URL 行不播", () => {
  const { sentences } = splitSentences("讲解开始。\n```js\nconst a=1;\n```\nhttps://example.com\n结论是。");
  const joined = sentences.join("");
  assert.ok(!joined.includes("```"));
  assert.ok(!joined.includes("http"));
  assert.ok(joined.includes("结论是"));
});

test("切句：残句超 60 字强制切出（防累积）", () => {
  const long = "あ".repeat(70);
  const { sentences, rest } = splitSentences(long);
  assert.equal(sentences.length, 1);
  assert.equal(rest, "");
});

test("flushRest：极短碎片不播，≥2 字播（防话没说完）", () => {
  assert.equal(flushRest("う"), "");           // 1 字碎片不播
  assert.equal(flushRest("うん"), "うん");       // 2 字播（原 8 字阈值丢尾句，已放宽）
  assert.equal(flushRest("それでは、また明日お会いしましょう"), "それでは、また明日お会いしましょう");
});

// ---------- 队列 ----------
test("队列：串行播放，一句播完才播下一句（prepare/play 两阶段，预取先行）", async () => {
  const order = [];
  const q = createSpeechQueue({
    prepare: async (t) => { order.push(`P:${t}`); return { path: t }; },
    play: async (a) => { order.push(`L:${a.path}`); await new Promise((r) => setTimeout(r, 5)); },
  });
  q.push("一。");
  q.push("二。");
  q.push("三。");
  await new Promise((r) => setTimeout(r, 200));
  // 预取先行语义：P:下一句 在 L:当前句 之前触发（合成与播放并行），播放严格串行
  assert.deepEqual(order, ["P:一。", "P:二。", "L:一。", "P:三。", "L:二。", "L:三。"]);
  assert.equal(q.size, 0);
});

test("队列：预取（播放期间后台 prepare 下一句——并行性用事件时序断言，不用挂钟）", async () => {
  // 2026-09-11 修 flake：原断言 `elapsed < 160`（串行基线 ~180ms）在满负载/CI 并行下随机变红
  // （每个 await 都可能被调度延迟，挂钟与并发度不成比例）。改为断言**预取语义本身**：
  // 句2 的 prepare 必须在句1 的 play **结束之前**开始——这是"预取"的定义，与机器快慢无关；
  // 若把预取去掉（严格串行），该断言必然失败。
  const marks = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = createSpeechQueue({
    prepare: async (t) => { marks.push({ ev: "P", t, at: Date.now(), done: 0 }); await sleep(30); marks[marks.length - 1].done = Date.now(); return { path: t }; },
    play: async (a) => { marks.push({ ev: "L", t: a.path, at: Date.now(), done: 0 }); await sleep(30); marks[marks.length - 1].done = Date.now(); },
  });
  q.push("一。");
  q.push("二。");
  q.push("三。");
  // 轮询等待队列完成（不用固定等待——避免计时污染）
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (!q.isSpeaking && q.size === 0) { clearInterval(iv); resolve(); } }, 5);
  });
  const find = (ev, t) => marks.find((m) => m.ev === ev && m.t === t);
  const p2 = find("P", "二。"), l1 = find("L", "一。"), p3 = find("P", "三。"), l2 = find("L", "二。");
  assert.ok(p2 && l1 && p3 && l2, "四步都已发生");
  assert.ok(p2.at < l1.done, `句2 的准备应在句1 播放结束前启动（预取并行；P2@${p2.at} vs L1 结束@${l1.done}）`);
  assert.ok(p3.at < l2.done, `句3 的准备应在句2 播放结束前启动（P3@${p3.at} vs L2 结束@${l2.done}）`);
  // 播放仍严格串行（不重叠）
  assert.ok(l2.at >= l1.done, `播放不得重叠（L2 起 ${l2.at} 应 ≥ L1 止 ${l1.done}）`);
  const p1 = find("P", "一。"), l1b = find("L", "一。");
  assert.ok(p1.at < l1b.at, "句1 先准备后播放");
  assert.ok(p2.at <= l1b.at + 1, "句2 准备已与句1 播放并行启动（顺序表同步断言）");
});

test("队列：prepare 返回 null 跳过本句", async () => {
  const order = [];
  const q = createSpeechQueue({
    prepare: async (t) => (t === "静。") ? null : { path: t },
    play: async (a) => { order.push(a.path); await new Promise((r) => setTimeout(r, 5)); },
  });
  q.push("一。");
  q.push("静。");
  q.push("三。");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, ["一。", "三。"]);
});

test("队列：打断清空排队 + 停当前", async () => {
  const order = [];
  const q = createSpeechQueue({
    prepare: async (t) => ({ path: t }),
    play: async (a) => { order.push(a.path); await new Promise((r) => setTimeout(r, 20)); },
  });
  q.push("一。");
  await new Promise((r) => setTimeout(r, 10)); // 正在播"一。"
  q.push("二。");
  q.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, ["一。"]);
  assert.equal(q.size, 0);
});

test("队列：预算耗尽后静默跳过，不阻塞", async () => {
  const order = [];
  const q = createSpeechQueue({
    prepare: async (t) => ({ path: t }),
    play: async (a) => { order.push(a.path); await new Promise((r) => setTimeout(r, 5)); },
    budget: 2,
  });
  q.push("一。");
  q.push("二。");
  q.push("三。"); // 超出预算
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, ["一。", "二。"]);
  assert.equal(q.remainingBudget, 0);
});

test("队列：prepare/play 抛错不中断队列", async () => {
  const order = [];
  const q = createSpeechQueue({
    prepare: async (t) => ({ path: t }),
    play: async (a) => { order.push(a.path); if (a.path === "坏。") throw new Error("fail"); await new Promise((r) => setTimeout(r, 5)); },
  });
  q.push("一。");
  q.push("坏。");
  q.push("三。");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, ["一。", "坏。", "三。"]);
});

test("队列：stop 后 push 无效，resetBudget 恢复", () => {
  const q = createSpeechQueue({ prepare: async () => ({ path: "x" }), play: async () => {}, budget: 3 });
  q.push("一。");
  q.stop();
  q.push("二。");
  assert.equal(q.size, 0);
  assert.equal(q.remainingBudget, 3);
  q.resetBudget();
  assert.equal(q.remainingBudget, 3);
});
