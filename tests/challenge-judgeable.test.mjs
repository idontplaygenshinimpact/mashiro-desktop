// 「无判题用例的题不得给假判题按钮」护栏（2026-09-16）
// 由来（仓库 P1 里记着的真实缺陷）：真实库 448 道 core 题里 **167 道 test_code 为空**
// （多为链表/树题、示例参数无法自动解析的题——实测 `scripts/gen-challenge-tests.mjs` 对它们
//  可生成 **0** 条，所以"用脚本补测试"这条路走不通）。此前面板照样渲染「▶ 运行判题」，
// 点了必然失败且错误信息是"测试未执行（可能骨架函数名与测试不匹配）"——误导用户以为自己写错了。
// 本护栏盯住三件事：① 列表/详情带 judgeable 标记；② 路由对不可判题的题**如实**返回明确原因
// （不跑沙箱、不假装 ok）；③ 面板三态在 judgeable=false 时都不渲染判题按钮、改为说明。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("judgeable");
mockLLM();

const { importChallengesData, getChallenges, getChallengeDetail } = await import("../lib/ai-career.ts");
const { registerPracticeRoutes } = await import("../plugins/job-hunter/routes/practice.ts");

test("judgeable 口径：core 看 test_code、acm 看 io_cases", () => {
  importChallengesData([
    { id: "j-with-test", title: "有测试的题", category: "handwrite", skeleton: "function f(){}", testCode: "async function __test__(f){ __assert__(true, 'ok'); }" },
    { id: "j-no-test", title: "链表题（无测试）", category: "algorithm", skeleton: "function reverseList(head){}" },
    { id: "j-acm-ok", title: "ACM 有样例", category: "algorithm", mode: "acm", ioCases: [{ input: "1", expected: "1" }] },
    { id: "j-acm-empty", title: "ACM 没样例", category: "algorithm", mode: "acm", ioCases: [] },
  ]);
  const list = getChallenges();
  const by = (id) => list.find((c) => c.id === id);
  assert.equal(by("j-with-test").judgeable, true, "有 test_code → 可判题");
  assert.equal(by("j-no-test").judgeable, false, "无 test_code → 不可判题（真实库 167 道此类）");
  assert.equal(by("j-acm-ok").judgeable, true, "ACM 有用例 → 可判题");
  assert.equal(by("j-acm-empty").judgeable, false, "ACM 无用例 → 不可判题");
  assert.equal(getChallengeDetail("j-no-test").judgeable, false, "详情与列表同一口径");
});

test("路由：不可判题的题 → 如实返回原因（不跑沙箱、不假装成功）", async () => {
  const router = createRouter();
  registerPracticeRoutes(router);
  const res = () => {
    const chunks = [];
    return { chunks, writableEnded: false, status: 0,
      writeHead(c) { this.status = c; return this; }, write(c) { chunks.push(String(c)); return true; },
      end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; }, on() {} };
  };
  const post = (path, body) => {
    const ls = {};
    return { method: "POST", url: path, headers: {}, destroyed: false,
      on(ev, fn) { ls[ev] = fn; if (ev === "end") setImmediate(() => { if (ls.data) ls.data(Buffer.from(JSON.stringify(body))); fn(); }); return this; }, destroy() {} };
  };
  const r1 = res();
  await router.resolve("/api/challenges/run", "POST").fn(post("/api/challenges/run", { id: "j-no-test", userCode: "function reverseList(){}" }), r1, new URL("/api/challenges/run", "http://x"));
  for (let i = 0; i < 200 && !r1.writableEnded; i++) await new Promise((x) => setTimeout(x, 10));
  const j1 = JSON.parse(r1.chunks.join(""));
  assert.equal(j1.success, false, "不可判题不得报成功");
  assert.equal(j1.judgeable, false, "应带 judgeable:false 让面板能区分");
  assert.match(String(j1.error), /暂无自动判题用例/, `错误信息应说明真实原因（实得「${j1.error}」）`);
  assert.doesNotMatch(String(j1.error), /骨架函数名/, "不得再给「骨架函数名不匹配」这种误导性原因");

  // 正对照：可判题的题走正常沙箱路径（不能被这条守卫误伤）
  const r2 = res();
  await router.resolve("/api/challenges/run", "POST").fn(post("/api/challenges/run", { id: "j-with-test", userCode: "function f(){}" }), r2, new URL("/api/challenges/run", "http://x"));
  for (let i = 0; i < 600 && !r2.writableEnded; i++) await new Promise((x) => setTimeout(x, 20));
  const j2 = JSON.parse(r2.chunks.join(""));
  assert.equal(j2.success, true, `可判题的题应正常通过（实得 ${JSON.stringify(j2).slice(0, 160)}）`);
});

test("三态面板：judgeable=false 时不渲染判题按钮、改为说明", () => {
  const native = readFileSync(new URL("../desktop/renderer/panel-rest.js", import.meta.url), "utf8");
  const react = readFileSync(new URL("../desktop/renderer/panel-react/src/tabs/Practice.jsx", import.meta.url), "utf8");
  const vue = readFileSync(new URL("../desktop/renderer/panel-vue-review/src/tabs/Practice.vue", import.meta.url), "utf8");
  for (const [name, src, btn] of [["原生", native, "ch-editor-run"], ["React", react, "runJudgement"], ["Vue", vue, "runJudgement"]]) {
    assert.match(src, /judgeable === false/, `${name}：应按 judgeable 分流`);
    assert.match(src, /暂无自动判题用例/, `${name}：应有明确说明文案`);
    assert.ok(src.includes(btn), `${name}：原本的判题入口仍在（可判题的题不受影响）`);
  }
  assert.match(native, /🧩 仅手动/, "原生列表应给「仅手动」徽标（一眼看出这题不能自动判）");
});
