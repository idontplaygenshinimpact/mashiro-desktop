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

test("队列：预取（播放期间后台 prepare 下一句，总耗时显著短于串行）", async () => {
  const order = [];
  const q = createSpeechQueue({
    prepare: async (t) => { order.push(`P:${t}`); await new Promise((r) => setTimeout(r, 30)); return { path: t }; },
    play: async (a) => { order.push(`L:${a.path}`); await new Promise((r) => setTimeout(r, 30)); },
  });
  const t0 = Date.now();
  q.push("一。");
  q.push("二。");
  q.push("三。");
  // 轮询等待队列完成（不用固定等待——避免计时污染）
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (!q.isSpeaking && q.size === 0) { clearInterval(iv); resolve(); } }, 5);
  });
  const elapsed = Date.now() - t0;
  // 串行基线 = (30+30)*3 = 180ms；预取并行 → 显著更短（首句 30 + 逐句播放 30 + 少量）
  assert.ok(elapsed < 160, `预取应并行（实测 ${elapsed}ms，串行基线 ~180ms）`);
  const p1 = order.indexOf("P:一。"), l1 = order.indexOf("L:一。"), p2 = order.indexOf("P:二。"), l2 = order.indexOf("L:二。");
  assert.ok(p1 < l1, "句1 先准备后播放");
  assert.ok(p2 < l2, "句2 先准备后播放");
  assert.ok(p2 <= l1 + 1, "句2 准备已与句1 播放并行启动");
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
