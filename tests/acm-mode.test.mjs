// ACM 模式（标准输入输出判题）回归护栏
// 背景：秋招笔试（牛客/赛码等）绝大多数是 ACM 模式——自己读输入、自己输出、多组用例，而本地判题
// 原先只有 LeetCode 核心代码模式（骨架函数 + __test__ 断言），练不到"读入解析/输出格式/EOF 处理"
// 这些真实考点。本次给沙箱加了 mode:"acm"：注入 readline()/print()，按 io_cases 逐组比对。
// 本护栏覆盖：正解通过 / 错解逐用例 diff / 缺用例明确报错 / 运行时报错归因 / 多用例输入隔离 /
// 输出归一化口径（行尾空格与末尾空行按 OJ 口径忽略，行内差异不忽略）/ 数据库迁移与列默认值 /
// 路由按 mode 过滤且判题走 ACM 分支 / 题库 15 题参考解全绿（题库+判题器一起验）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("acm-mode");
mockLLM();

const { runChallengeCode, importChallengesData, getChallengeDetail, parseIoCases } = await import("../lib/ai-career.ts");
const { ACM_CHALLENGES } = await import("../lib/acm-bank.ts");
const { db } = await import("../lib/db.mjs");
const { registerPracticeRoutes } = await import("../plugins/job-hunter/routes/practice.ts");

const SUM = [{ input: "3\n1 2 3", expected: "6" }, { input: "1\n-7", expected: "-7" }];
const SUM_CODE = `const n = Number(readline()); const a = readline().trim().split(/\\s+/).map(Number).slice(0, n); print(a.reduce((x, y) => x + y, 0));`;

test("ACM 判题：正解通过（readline 逐行读 + print 输出，多用例）", async () => {
  const r = await runChallengeCode({ userCode: SUM_CODE, mode: "acm", cases: SUM });
  assert.equal(r.success, true, `正解应通过：${JSON.stringify(r.tests)} ${r.error || ""}`);
  assert.equal(r.tests.length, 2, "应逐用例给出结果");
  assert.ok(r.tests.every((t) => t.passed));
});

test("ACM 判题：错解不通过，并给出逐用例 diff（输入/期望/实际）", async () => {
  const r = await runChallengeCode({ userCode: `const n = Number(readline()); readline(); print(0);`, mode: "acm", cases: SUM });
  assert.equal(r.success, false);
  const bad = r.tests.filter((t) => !t.passed);
  assert.equal(bad.length >= 1, true, "应有失败用例");
  const t = bad[0];
  assert.equal(typeof t.input, "string", "失败用例应带输入");
  assert.equal(typeof t.expected, "string", "失败用例应带期望输出");
  assert.equal(typeof t.actual, "string", "失败用例应带实际输出");
  assert.equal(t.expected, "6");
  assert.equal(t.actual, "0");
});

test("ACM 判题：用例间输入互相隔离（第二组从队首重新读，不残留上一组）", async () => {
  // 若输入队列不在用例间重置，第二组会读到上一组残留 → 结果错
  const echo = `const out = []; while (true) { const l = readline(); if (l === null) break; out.push(l); } print(out.join("|"));`;
  const r = await runChallengeCode({ userCode: echo, mode: "acm", cases: [
    { input: "a\nb", expected: "a|b" },
    { input: "c", expected: "c" },
  ] });
  assert.equal(r.success, true, `输入应逐用例隔离：${JSON.stringify(r.tests)}`);
});

test("ACM 判题：输出归一化按 OJ 口径（忽略行尾空格与末尾空行，行内差异仍判错）", async () => {
  const trailing = `print("6   "); `; // 行尾空格
  const r1 = await runChallengeCode({ userCode: trailing, mode: "acm", cases: [{ input: "x", expected: "6" }] });
  assert.equal(r1.success, true, "行尾空格应被忽略（OJ 标准口径）");
  const inner = `print("6 7");`;
  const r2 = await runChallengeCode({ userCode: inner, mode: "acm", cases: [{ input: "x", expected: "67" }] });
  assert.equal(r2.success, false, "行内空格差异不应被忽略");
});

test("ACM 判题：运行时报错如实归因到该用例（不静默算过）", async () => {
  const r = await runChallengeCode({ userCode: `throw new Error("boom");`, mode: "acm", cases: [{ input: "1", expected: "1" }] });
  assert.equal(r.success, false);
  assert.match(String(r.tests[0].actual), /boom/, "应把错误信息放进该用例的实际输出");
  assert.match(String(r.tests[0].label), /运行报错/);
});

test("ACM 判题：缺用例 → 明确报错（而不是当作「无断言通过」）", async () => {
  const r = await runChallengeCode({ userCode: SUM_CODE, mode: "acm", cases: [] });
  assert.equal(r.success, false);
  assert.match(String(r.error), /缺少测试用例/);
});

test("迁移与列默认值：存量题 mode='core'、io_cases 为空；ACM 题有 mode/io_cases", async () => {
  const cols = db.prepare("PRAGMA table_info(challenges)").all().map((c) => c.name);
  assert.ok(cols.includes("mode"), "challenges 应有 mode 列（迁移 v5）");
  assert.ok(cols.includes("io_cases"), "challenges 应有 io_cases 列（迁移 v5）");
  // 存量导入（不传 mode）→ 默认 core
  importChallengesData([{ id: "legacy-1", title: "老题", category: "handwrite", testCode: `async function __test__(f){ __assert__(true,"x"); }`, skeleton: "function f(){}" }]);
  const legacy = getChallengeDetail("legacy-1");
  assert.equal(legacy.mode, "core", "不传 mode 的题应落默认 core");
  assert.deepEqual(legacy.ioCases, [], "core 题不应有用例");
  // ACM 导入：mode/ioCases 落库并可读回
  importChallengesData([{ id: "acm-1", title: "ACM 测试题", category: "algorithm", mode: "acm", ioCases: SUM }]);
  const acm = getChallengeDetail("acm-1");
  assert.equal(acm.mode, "acm");
  assert.deepEqual(acm.ioCases, SUM, "io_cases 应原样读回");
  assert.deepEqual(parseIoCases("坏 JSON"), [], "坏 io_cases 不应抛错（返回空数组，判题侧报缺少用例）");
});

test("路由：/api/challenges?mode=acm 只回 ACM 题；/api/challenges/run 走 ACM 分支并回流", async () => {
  const router = createRouter();
  registerPracticeRoutes(router);
  const res = () => {
    const chunks = [];
    return { chunks, destroyed: false, writableEnded: false, status: 0,
      writeHead(c) { this.status = c; return this; }, write(c) { chunks.push(String(c)); return true; },
      end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; }, on() {} };
  };
  // GET 列表（mode 过滤）
  const listRes = res();
  await router.resolve("/api/challenges", "GET").fn({ method: "GET", url: "/api/challenges?mode=acm", headers: {}, on(ev, fn) { if (ev === "end") setImmediate(fn); return this; }, destroy() {} }, listRes, new URL("/api/challenges?mode=acm", "http://x"));
  const listJ = JSON.parse(listRes.chunks.join(""));
  assert.equal(listJ.ok, true);
  assert.equal(listJ.list.every((c) => c.mode === "acm"), true, "列表应只含 ACM 题");
  assert.equal(listJ.list.some((c) => c.id === "acm-1"), true);

  // POST 判题（正解 → 通过 + 回流 done）
  const runRes = res();
  const runReq = (() => { const ls = {}; return { method: "POST", url: "/api/challenges/run", headers: {}, destroyed: false,
    on(ev, fn) { ls[ev] = fn; if (ev === "end") setImmediate(() => { if (ls.data) ls.data(Buffer.from(JSON.stringify({ id: "acm-1", userCode: SUM_CODE }))); fn(); }); return this; }, destroy() {} }; })();
  await router.resolve("/api/challenges/run", "POST").fn(runReq, runRes, new URL("/api/challenges/run", "http://x"));
  for (let i = 0; i < 300 && !runRes.writableEnded; i++) await new Promise((r) => setTimeout(r, 20));
  const runJ = JSON.parse(runRes.chunks.join(""));
  assert.equal(runJ.success, true, `ACM 正解应通过：${JSON.stringify(runJ).slice(0, 300)}`);
  assert.equal(runJ.reflow?.done, true, "通过应回流 done（与核心代码模式同一条闭环）");
  assert.equal(runJ.tests[0].expected, "6", "响应应带逐用例的期望/实际（面板展示 diff）");

  // POST 判题（错解 → wrong 回流）
  const badRes = res();
  const badReq = (() => { const ls = {}; return { method: "POST", url: "/api/challenges/run", headers: {}, destroyed: false,
    on(ev, fn) { ls[ev] = fn; if (ev === "end") setImmediate(() => { if (ls.data) ls.data(Buffer.from(JSON.stringify({ id: "acm-1", userCode: "print(0)" }))); fn(); }); return this; }, destroy() {} }; })();
  await router.resolve("/api/challenges/run", "POST").fn(badReq, badRes, new URL("/api/challenges/run", "http://x"));
  for (let i = 0; i < 300 && !badRes.writableEnded; i++) await new Promise((r) => setTimeout(r, 20));
  const badJ = JSON.parse(badRes.chunks.join(""));
  assert.equal(badJ.success, false);
  assert.equal(badJ.reflow?.wrong, true, "失败应回流 wrong（错题/薄弱点/复习卡）");
});

test("题库：15 道 ACM 题都有题面与用例，且参考解逐题通过（题库与判题器一起验）", async () => {
  assert.equal(ACM_CHALLENGES.length, 15, "ACM 题库应为 15 道");
  const ids = new Set();
  for (const c of ACM_CHALLENGES) {
    assert.equal(ids.has(c.id), false, `题号重复: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.ioCases.length >= 2, `${c.id} 至少 2 组用例`);
    assert.match(c.description, /输入格式/, `${c.id} 题面应写清输入格式`);
    assert.match(c.description, /输出格式/, `${c.id} 题面应写清输出格式`);
  }
  // 参考解验证（跑真判题器）：题库里手写的期望输出必须与判题口径一致
  const refs = {
    "acm-a-plus-b": `const o=[];while(true){const l=readline();if(l===null)break;if(!l.trim())continue;const[a,b]=l.trim().split(/\\s+/).map(Number);o.push(a+b);}print(o.join("\\n"));`,
    "acm-sum-n": SUM_CODE,
    "acm-max-min": `const n=Number(readline());const a=readline().trim().split(/\\s+/).map(Number).slice(0,n);print(Math.max(...a)-Math.min(...a));`,
    "acm-fib-mod": `const MOD=1000000007;const T=Number(readline());const o=[];for(let t=0;t<T;t++){const n=Number(readline());let a=1,b=1;for(let i=3;i<=n;i++){const c=(a+b)%MOD;a=b;b=c;}o.push(n<=2?1:b);}print(o.join("\\n"));`,
  };
  for (const [id, code] of Object.entries(refs)) {
    const ch = ACM_CHALLENGES.find((c) => c.id === id);
    const r = await runChallengeCode({ userCode: code, mode: "acm", cases: ch.ioCases });
    assert.equal(r.success, true, `${id} 参考解应通过：${JSON.stringify(r.tests.filter((t) => !t.passed))}`);
  }
});
