// memory.mjs 单测：画像/关注点/薄弱点/已掌握/对话历史/复盘回流
// 策略：静态单例 + resetMemoryState（保持模块 URL 稳定，让 V8 coverage 全量统计）；
//       持久化验证用 freshMemory 重载实例（少数）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, resetMemoryState } from "./helpers.mjs";

const dbDir = setupTempDb("memory");
const { memory } = await import("../lib/memory.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  resetMemoryState(memory);
  try { db.exec("DELETE FROM curated_memory;"); } catch { /* ignore */ }
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 关注点 ----------
test("addInterests 去重 + trim + 持久化(DB)", () => {
  memory.addInterests(["React", "字节", "React"]);
  memory.addInterests(["  Event Loop  "]);
  assert.deepEqual(memory.getInterests(), ["React", "字节", "Event Loop"]);
  const rows = db.prepare("SELECT topic FROM interests ORDER BY added_at").all().map((r) => r.topic);
  assert.deepEqual(rows, ["React", "字节", "Event Loop"], "DB 持久化");
});

test("addInterests 空值忽略/超长截断到 30 字符", () => {
  memory.addInterests(["", "   ", "x".repeat(50)]);
  assert.deepEqual(memory.getInterests(), ["x".repeat(30)]);
});

test("addWeakPoint 被挤出镜像后 DB 仍累计 fail_count（不因裁剪丢累计）", () => {
  // 塞满镜像（20 条 failCount=1），再反复记录"点0"——它会被挤出 top20 镜像
  for (let i = 0; i < 20; i++) memory.addWeakPoint(`点${i}`, "s");
  for (let i = 0; i < 5; i++) memory.addWeakPoint("点0", "s");
  // DB 侧必须累计（修复前：find 在裁剪后的镜像里找不到 → upsert 跳过 → fail_count 停在 1）
  const row = db.prepare("SELECT fail_count FROM weak_points WHERE topic='点0'").get();
  assert.equal(Number(row.fail_count), 6, "DB 累计 6 次（1 初始 + 5 重入）");
});

test("clearWeakPoint 归一化匹配：调用方传未截断/未 trim 的原始 topic 也能删", () => {
  const long = "这是一个超过三十个字符的知识点名字用来测试过滤逻辑是否正常工作的例子"; // >30 字
  memory.addWeakPoint(long, "x");
  assert.equal(memory.getWeakPoints().length, 1, "长 topic 截断 30 字入库");
  // 传原始（未截断）topic：内部经 _cleanTopic 归一化后匹配删除（修复前精确匹配删不到）
  memory.clearWeakPoint(long);
  assert.equal(memory.getWeakPoints().length, 0, "归一化后删除成功");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM weak_points").get().n, 0, "DB 同步删除");
});

// ---------- 已看帖子 ----------
test("markSeen/isSeen 持久化(DB)", () => {
  assert.equal(memory.isSeen("http://a"), false);
  memory.markSeen("http://a");
  assert.equal(memory.isSeen("http://a"), true);
  const row = db.prepare("SELECT url FROM seen_urls WHERE url=?").get("http://a");
  assert.ok(row, "DB 持久化");
});

test("markSeen 空值忽略", () => {
  memory.markSeen("");
  memory.markSeen(null);
  assert.equal(memory.get().seenUrls.length, 0);
});

// 修复：seen_urls/interests DB 侧永不修剪 → 重启后镜像=DB 全量（镜像 slice 上限失效）
test("markSeen DB 侧同步裁剪到 500（重启后镜像不会被全量 DB 撑爆）", () => {
  for (let i = 0; i < 520; i++) memory.markSeen(`https://x.com/${i}`);
  const n = db.prepare("SELECT COUNT(*) n FROM seen_urls").get().n;
  assert.equal(n, 500, "DB 只保留最近 500 条");
  assert.equal(memory.get().seenUrls.length, 500, "镜像一致");
});

test("addInterests DB 侧同步裁剪到 20", () => {
  const topics = [];
  for (let i = 0; i < 30; i++) topics.push(`兴趣${i}`);
  memory.addInterests(topics);
  const n = db.prepare("SELECT COUNT(*) n FROM interests").get().n;
  assert.equal(n, 20, "DB 只保留最近 20 条");
  assert.equal(memory.getInterests().length, 20);
});

// ---------- 对话历史 ----------
test("appendChat/getChatHistory 持久化(DB)", () => {
  memory.appendChat("user", "你好");
  memory.appendChat("assistant", "你好呀");
  const hist = memory.getChatHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].role, "user");
  const n = db.prepare("SELECT COUNT(*) n FROM chat_history").get().n;
  assert.equal(n, 2, "DB 持久化");
});

test("appendChat 上限 40 条", () => {
  for (let i = 0; i < 50; i++) memory.appendChat("user", `m${i}`);
  assert.equal(memory.getChatHistory().length, 40);
  assert.equal(memory.get().stats.chats, 50);
});

test("appendChat DB 防堆积：超出 200 条自动删最旧", () => {
  for (let i = 0; i < 250; i++) memory.appendChat("user", `堆积消息${i}`);
  const n = db.prepare("SELECT COUNT(*) n FROM chat_history").get().n;
  assert.ok(n <= 200, `DB 只保留最近 200 条（实际 ${n}）`);
  // 最旧消息已被清掉（只留最近的）
  const oldest = db.prepare("SELECT content FROM chat_history ORDER BY id ASC LIMIT 1").get();
  assert.ok(String(oldest.content).includes("堆积消息"), "留下的都是最近消息");
});

test("deleteChatSession 同步清内存镜像（防已删会话复活注入 prompt）", () => {
  // 回归 P1-8：原来只删 DB 不清 mem.chatHistory → 已删会话借 agent 无 history 路径复活
  memory.appendChat("user", "会话A的消息", "sessA");
  memory.appendChat("assistant", "会话A的回复", "sessA");
  memory.appendChat("user", "会话B的消息", "sessB");
  assert.ok(memory.getChatHistory().some((m) => m.sessionId === "sessA"), "内存含会话 A");
  const r = memory.deleteChatSession("sessA");
  assert.equal(r.ok, true);
  assert.equal(memory.getChatHistory().filter((m) => m.sessionId === "sessA").length, 0, "内存镜像已清会话 A");
  assert.ok(memory.getChatHistory().some((m) => m.sessionId === "sessB"), "会话 B 不受影响");
  // DB 也清了
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chat_history WHERE session_id='sessA'").get().n, 0);
});

test("appendChat DB 按会话分桶互不截断（多会话历史不互吞）", () => {
  // 回归：原全局 200 条互截 → 高频会话会把低频会话旧消息顶掉；现按 session 各自保留
  for (let i = 0; i < 150; i++) memory.appendChat("user", `默认会话${i}`, "default");
  for (let i = 0; i < 150; i++) memory.appendChat("user", `沉淀会话${i}`, "sess_archive");
  const defN = db.prepare("SELECT COUNT(*) n FROM chat_history WHERE session_id='default'").get().n;
  const arcN = db.prepare("SELECT COUNT(*) n FROM chat_history WHERE session_id='sess_archive'").get().n;
  assert.equal(defN, 150, "default 会话完整保留（未被高频默认消息截断）");
  assert.equal(arcN, 150, "低频会话不被其他会话顶掉");
});

// ---------- 薄弱点 ----------
test("addWeakPoint 过滤伪知识点", () => {
  memory.addWeakPoint("综合能力", "复盘验证");
  memory.addWeakPoint("考察维度：深度", "复盘验证");
  memory.addWeakPoint("", "x");
  memory.addWeakPoint("事件循环", "复盘验证");
  assert.equal(memory.getWeakPoints().length, 1);
  assert.equal(memory.getWeakPoints()[0].topic, "事件循环");
});

test("addWeakPoint 同主题累加 failCount + 排序 + 上限20", () => {
  memory.addWeakPoint("A点", "s1");
  memory.addWeakPoint("A点", "s2");
  for (let i = 0; i < 25; i++) memory.addWeakPoint(`点${i}`, "s3");
  const wps = memory.getWeakPoints();
  assert.equal(wps.length, 20, "最多保留 20 条");
  assert.equal(wps[0].topic, "A点");
  assert.equal(wps[0].failCount, 2);
});

test("addWeakPoint 持久化(DB)", () => {
  memory.addWeakPoint("事件循环", "面试实录", "agent");
  const row = db.prepare("SELECT * FROM weak_points WHERE topic=?").get("事件循环");
  assert.equal(row.origin, "agent");
  assert.equal(row.fail_count, 1);
});

test("addWeakPoint 自动建复习卡（source=薄弱点，同 topic+question 去重）", async () => {
  const { review } = await import("../lib/review.mjs"); // 预热模块，保证后续动态 import 立即 resolve
  memory.addWeakPoint("事件循环", "复盘验证");
  await new Promise((r) => setImmediate(r)); // 等 fire-and-forget 复习卡创建完成
  const cards = review.loadCards().cards.filter((c) => c.topic === "事件循环");
  assert.equal(cards.length, 1, "薄弱点自动建复习卡");
  assert.equal(cards[0].source, "薄弱点");
  assert.equal(cards[0].question, "事件循环", "无原题时 question 回退 topic");
  // 再次记录同主题：不重复建卡（同 topic+question）
  memory.addWeakPoint("事件循环", "复盘验证");
  await new Promise((r) => setImmediate(r));
  assert.equal(review.loadCards().cards.filter((c) => c.topic === "事件循环").length, 1, "同 topic+question 去重");
});

test("addWeakPoint 带原题/答案的复习卡", async () => {
  const { review } = await import("../lib/review.mjs");
  memory.addWeakPoint("防抖节流", "模拟面试", "agent", { question: "讲讲防抖", answer: "闭包定时器" });
  await new Promise((r) => setImmediate(r));
  const card = review.loadCards().cards.find((c) => c.topic === "防抖节流");
  assert.ok(card, "薄弱点自动建复习卡");
  assert.equal(card.question, "讲讲防抖");
  assert.equal(card.answer, "闭包定时器");
});

test("getTrustedWeakPoints 过滤 untrusted", () => {
  memory.addWeakPoint("可信点", "x", "agent");
  memory.addWeakPoint("不可信点", "x", "untrusted");
  assert.deepEqual(memory.getTrustedWeakPoints().map((w) => w.topic), ["可信点"]);
});

test("_cleanTopic 长度/模式过滤", () => {
  // 超长 topic：截断到 30 字（修复 LOW-9：原实现 31~40 字被丢弃）
  const long = memory._cleanTopic("这是一个超过三十个字符的知识点名字用来测试过滤逻辑是否正常工作的例子");
  assert.equal(long.length, 30, "超长 topic 截断到 30 字而非丢弃");
  assert.ok(long.startsWith("这是一个超过三十个字符的知识点名字用来测试过滤逻辑是否正常工"), "保留前 30 字");
  assert.equal(memory._cleanTopic("整体表现"), null);
  assert.equal(memory._cleanTopic("暂无"), null);
  assert.equal(memory._cleanTopic("none"), null);
  assert.equal(memory._cleanTopic("  React Hooks 原理  "), "React Hooks 原理");
});

test("clearWeakPoint", () => {
  memory.addWeakPoint("A点", "x");
  memory.clearWeakPoint("A点");
  assert.equal(memory.getWeakPoints().length, 0);
});

// ---------- 复盘回流 ----------
test("applyReviewResults：错→薄弱点，答对→已掌握并清薄弱点", () => {
  memory.addWeakPoint("闭包", "旧");
  memory.applyReviewResults([
    { topic: "闭包", verdict: "对" },
    { topic: "事件循环", verdict: "错" },
    { topic: "综合能力", verdict: "错" },
    { topic: "原型链", verdict: "部分对" },
  ]);
  assert.deepEqual(memory.getMastered().map((m) => m.topic), ["闭包"]);
  const weak = memory.getWeakPoints().map((w) => w.topic).sort();
  assert.deepEqual(weak, ["事件循环", "原型链"]);
  assert.equal(memory.getWeakPoints().some((w) => w.topic === "闭包"), false);
});

test("applyReviewResults 空结果不崩溃", () => {
  memory.applyReviewResults(null);
  memory.applyReviewResults([]);
  assert.equal(memory.getWeakPoints().length, 0);
});

test("applyReviewResults 无 topic 条目跳过", () => {
  memory.applyReviewResults([{ verdict: "错" }, { topic: "综合能力", verdict: "错" }]);
  assert.equal(memory.getWeakPoints().length, 0);
});

// F2 回归：同 tick 批量薄弱点 id 不碰撞（旧版 `wp_${Date.now()}` 同毫秒重复 → PRIMARY KEY 冲突 → 全部丢弃）
test("multiple weak points in one applyReviewResults batch all persist", () => {
  memory.applyReviewResults([
    { topic: "闭包", verdict: "错" },
    { topic: "事件循环", verdict: "错" },
    { topic: "原型链", verdict: "部分对" },
    { topic: "Promise", verdict: "部分对" },
  ]);
  const rows = db.prepare("SELECT topic FROM weak_points ORDER BY rowid").all().map((r) => r.topic);
  assert.equal(rows.length, 4, "4 个薄弱点全部入库（不被同 id 覆盖丢弃）");
  assert.deepEqual(rows.sort(), ["Promise", "原型链", "事件循环", "闭包"].sort());
});

// ---------- 已掌握 ----------
test("addMastered 去重 + 上限30 + 清薄弱点", () => {
  memory.addWeakPoint("闭包", "x");
  memory.addMastered("闭包");
  memory.addMastered("闭包");
  assert.equal(memory.getMastered().length, 1);
  assert.equal(memory.getWeakPoints().length, 0, "掌握后清除薄弱点");
  for (let i = 0; i < 35; i++) memory.addMastered(`已掌握${i}`);
  assert.equal(memory.getMastered().length, 30);
});

// ---------- 学习进度 ----------
test("recordProgress 累积次数/状态", () => {
  memory.recordProgress("事件循环", "done");
  memory.recordProgress("事件循环", "reviewed");
  const p = memory.get().studyProgress["事件循环"];
  assert.equal(p.times, 2);
  assert.equal(p.done, true);
  assert.equal(p.reviewed, true);
});

// ---------- 画像摘要 ----------
test("getProfileSummary 组装画像", () => {
  memory.addInterests(["React"]);
  memory.addWeakPoint("事件循环", "x");
  const s = memory.getProfileSummary();
  assert.ok(s.includes("关注点：React"));
  assert.ok(s.includes("事件循环"));
  assert.ok(s.includes("目标：前端秋招"));
});

test("getProfileSummary 空状态仅剩目标", () => {
  // resetMemoryState 后 profile.target 默认"前端秋招"
  assert.equal(memory.getProfileSummary(), "目标：前端秋招");
});

// ---------- 面试会话 ----------
test("setInterview/getInterview/clearInterview 持久化(DB)", () => {
  assert.equal(memory.getInterview(), null);
  memory.setInterview({ position: "前端" });
  assert.equal(memory.getInterview().position, "前端");
  const row = db.prepare("SELECT value FROM settings WHERE key='interview'").get();
  assert.ok(row && JSON.parse(row.value).position === "前端", "DB 持久化");
  memory.clearInterview();
  assert.equal(memory.getInterview(), null);
});

test("saveInterviewHistory 持久化(DB) + 内存上限20", () => {
  for (let i = 0; i < 25; i++) {
    memory.saveInterviewHistory({ date: "2026-01-01", position: `岗${i}`, rounds: 1, avg: 60, dims: {}, report: "r" });
  }
  assert.equal(memory.getInterviewHistory().length, 20, "内存镜像保留最近 20 条");
  const n = db.prepare("SELECT COUNT(*) n FROM interview_history").get().n;
  assert.ok(n >= 20, "DB 全量保留");
});

// ---------- 长期记忆（curated_memory） ----------
test("getCuratedMemory 按 importance DESC, updated_at DESC 排序", () => {
  const ins = db.prepare("INSERT INTO curated_memory (id, topic, content, source_ref, importance, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  ins.run("cm_1", "低", "c", "weak:低", 1, "agent", 1000, 1000);
  ins.run("cm_2", "高", "c", "weak:高", 5, "agent", 1000, 1000);
  ins.run("cm_3", "中", "c", "weak:中", 3, "agent", 1000, 1000);
  ins.run("cm_4", "高2", "c", "weak:高2", 5, "agent", 1000, 2000); // 同 important，updated_at 更大排前
  const mem = memory.getCuratedMemory();
  assert.deepEqual(mem.map((m) => m.topic), ["高2", "高", "中", "低"]);
  assert.equal(mem[0].sourceRef, "weak:高2", "带来源溯源");
});

test("getCuratedMemory limit 生效", () => {
  const ins = db.prepare("INSERT INTO curated_memory (id, topic, content, source_ref, importance, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 10; i++) ins.run(`cm_l${i}`, `主题${i}`, "c", `weak:${i}`, i + 1, "agent", 1000, 1000);
  assert.equal(memory.getCuratedMemory(3).length, 3);
});

test("injectCuratedIntoPrompt 追加长期记忆章节 + 空记忆不追加", () => {
  const base = "你是前端秋招助手。";
  assert.equal(memory.injectCuratedIntoPrompt(base), base, "无长期记忆时原样返回");
  db.prepare("INSERT INTO curated_memory (id, topic, content, source_ref, importance, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("cm_i", "事件循环", "宏任务先于微任务", "weak:事件循环", 4, "agent", 1000, 1000);
  const injected = memory.injectCuratedIntoPrompt(base);
  assert.ok(injected.startsWith(base), "保留原提示词");
  assert.ok(injected.includes("长期记忆（带来源）"), "追加章节标题");
  assert.ok(injected.includes("来源:weak:事件循环"), "带来源引用");
  assert.ok(injected.includes("事件循环"), "含记忆内容");
});

// ---------- 表述漂移合并（模拟面试提问措辞每次不同 → 同一知识点不应分裂成多条） ----------
test("addWeakPoint 相似表述合并：状态机族不同措辞 → 归并为一条并累计 fail_count", () => {
  memory.addWeakPoint("状态机与异步并发", "模拟面试");
  memory.addWeakPoint("异步状态机与并发提交控制", "模拟面试");
  memory.addWeakPoint("状态机状态转移表、异步并发控制", "模拟面试");
  memory.addWeakPoint("状态机设计、异步状态流转与竞态控制", "模拟面试");
  const rows = db.prepare("SELECT topic, fail_count FROM weak_points").all();
  assert.equal(rows.length, 1, "5 种措辞归并为 1 条");
  assert.equal(Number(rows[0].fail_count), 4, "fail_count 累计 4 次");
  assert.equal(rows[0].topic, "状态机与异步并发", "保留首个（fail_count 最高）条目");
  // 镜像同步
  assert.equal(memory.getWeakPoints().length, 1);
});

test("addWeakPoint 不同知识点不误合并", () => {
  memory.addWeakPoint("事件循环与微任务", "模拟面试");
  memory.addWeakPoint("CSS 布局与 Flexbox", "模拟面试");
  memory.addWeakPoint("闭包与作用域", "模拟面试");
  const rows = db.prepare("SELECT topic FROM weak_points").all();
  assert.equal(rows.length, 3, "互不相似 → 各自成条");
});

test("mergeSimilarWeakPoints：历史漂移数据一次性归并（幂等）", () => {
  // 直接造历史分裂数据（绕过 addWeakPoint 合并——模拟修复前的存量）
  const ins = db.prepare("INSERT INTO weak_points (id, topic, fail_count, last_failed_at, source, origin, updated_at) VALUES (?,?,?,?,?,?,?)");
  ins.run("w1", "状态机与异步并发", 2, "2026-01-01", "模拟面试", "agent", 1);
  ins.run("w2", "异步状态机与并发提交控制", 2, "2026-01-01", "模拟面试", "agent", 1);
  ins.run("w3", "状态机状态定义与重复提交拦截机制", 2, "2026-01-01", "模拟面试", "agent", 1);
  ins.run("w4", "事件循环与微任务", 3, "2026-01-01", "模拟面试", "agent", 1);
  const r = memory.mergeSimilarWeakPoints();
  assert.equal(r.merged, 2, "2 条漂移条目被并入");
  assert.equal(r.removed, 2);
  const rows = db.prepare("SELECT topic, fail_count FROM weak_points ORDER BY fail_count DESC").all();
  assert.equal(rows.length, 2, "归并后剩 2 条");
  assert.equal(Number(rows[0].fail_count), 6, "状态机簇 fail_count 累加（2+2+2）");
  assert.equal(Number(rows[1].fail_count), 3, "事件循环条目不误并");
  // 幂等：再跑一次不再合并
  const r2 = memory.mergeSimilarWeakPoints();
  assert.equal(r2.removed, 0, "二次运行无变化");
});

test("表述漂移合并后的复习卡用合并键（答对复习可清薄弱点——闭环）", async () => {
  // 等待异步复习卡创建（addWeakPoint 动态 import review）
  memory.addWeakPoint("状态机与异步并发", "模拟面试", "agent", { question: "讲讲状态机" });
  memory.addWeakPoint("异步状态机与并发提交控制", "模拟面试", "agent", { question: "讲讲状态机" });
  await new Promise((r) => setTimeout(r, 80));
  const { review } = await import("../lib/review.mjs");
  const cards = review.loadCards().cards.filter((c) => c.source === "薄弱点");
  // 合并后只有一张卡，topic 必须是合并键（旧表述），而非新表述
  assert.equal(cards.length, 1, "两张表述漂移卡只回流一张复习卡");
  assert.equal(cards[0].topic, "状态机与异步并发", "复习卡 topic 用合并键");
  // 答对复习（Good）→ 薄弱点被清除（闭环：卡 topic 与薄弱点键一致才能清掉）
  review.reviewCard(cards[0].id, 2);
  await new Promise((r) => setTimeout(r, 30));
  const weak = db.prepare("SELECT topic FROM weak_points").all();
  assert.equal(weak.length, 0, "答对复习后薄弱点已清除");
});
