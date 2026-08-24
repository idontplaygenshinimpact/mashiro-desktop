// tests/panel-dom-consistency.test.mjs —— 面板 JS 元素引用 ↔ HTML 实际元素一致性
// 背景：focus-goal 被 JS 读取 .value 但 HTML 从无此元素 → 点"25 分钟"必崩
//       （Cannot read properties of null (reading 'value')）；iv-answer-area 是 class 被当 id 用。
// 护栏：静态提取 JS 的 $("id") 引用，断言每个 id 都存在于 panel.html 或 JS 内联创建（模板字符串）中。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer");
const htmlSrc = readFileSync(path.join(renderer, "panel.html"), "utf8");
const jsFiles = readdirSync(renderer).filter((f) => f.startsWith("panel-") && f.endsWith(".js"));
const jsSrc = jsFiles.map((f) => readFileSync(path.join(renderer, f), "utf8")).join("\n");

function collect(re, src) {
  return [...src.matchAll(re)].map((m) => m[1]);
}

const htmlIds = new Set(collect(/id="([a-zA-Z0-9-]+)"/g, htmlSrc));
// JS 模板字符串内联创建的 HTML 元素 id（动态注入 DOM）
const inlineIds = new Set(collect(/id="([a-zA-Z0-9-]+)"/g, jsSrc));
// JS 里所有 $("...") 引用（panel-core.js 的 $ = getElementById）
const refs = collect(/\$\("([a-zA-Z0-9-]+)"\)/g, jsSrc);

test("JS 引用的每个元素 id 都在 HTML 或 JS 内联创建中存在", () => {
  const missing = [...new Set(refs)].filter((id) => !htmlIds.has(id) && !inlineIds.has(id));
  assert.deepEqual(
    missing,
    [],
    `JS 引用了不存在的元素 id（HTML 缺元素会直接 null 崩溃）: ${missing.join(", ")}`
  );
});

test("专注监督关键元素存在（focus-goal 输入框回归护栏）", () => {
  for (const id of ["focus-goal", "focus-25", "focus-45", "focus-status", "focus-blacklist", "focus-whitelist"]) {
    assert.ok(htmlIds.has(id), `专注监督元素 #${id} 应存在于 panel.html`);
  }
});

test("面试/邮箱关键元素存在（iv-answer-area 曾是 class 被当 id 用）", () => {
  for (const id of ["iv-answer-area", "iv-answer", "iv-scores", "iv-status", "mail-check-btn", "mail-status"]) {
    assert.ok(htmlIds.has(id), `元素 #${id} 应存在于 panel.html`);
  }
});

test("panel-*.js 文件集完整（5 个模块按序加载）", () => {
  assert.deepEqual(jsFiles.sort(), ["panel-chat.js", "panel-core.js", "panel-jobs.js", "panel-rest.js", "panel-study.js"]);
});

// ---------- 面板 ↔ widget 接口字段契约（防"题库为空"类错位回归） ----------
// 背景：30d5733 路由拆分后 /api/challenges 响应字段从 challenges 变为 list，
//       detail 接口字段从 challenge 变为 detail，而面板仍读旧字段 → 专项练习永远显示
//       "题库为空——运行 scripts/import-ai-career.mjs"，做题展开也抛 undefined。
// 护栏：面板读取字段必须与路由返回字段一致（静态断言，双侧锚定）。
const panelRest = readFileSync(path.join(renderer, "panel-rest.js"), "utf8");
const practiceRoute = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "job-hunter", "routes", "practice.mjs"),
  "utf8"
);

test("手写题库列表：面板读 j.list，路由返回 list（回归护栏）", () => {
  assert.match(panelRest, /!j\.list\?\.length/, "面板空态判断应读 j.list（接口字段）");
  assert.match(panelRest, /\[\.\.\.j\.list\]/, "面板排序应读 j.list");
  assert.doesNotMatch(panelRest, /j\.challenges\?\.length/, "不应回退到旧字段 j.challenges");
  assert.match(practiceRoute, /total: stats\.total, done: stats\.done, left: Math\.max\(0, stats\.total - stats\.done\), list/, "路由应返回 list 字段");
});

test("手写题库详情：面板读 j.detail，路由返回 detail（回归护栏）", () => {
  assert.match(panelRest, /const c = j\.detail;/, "面板做题展开应读 j.detail");
  assert.doesNotMatch(panelRest, /const c = j\.challenge;/, "不应回退到旧字段 j.challenge");
  assert.match(practiceRoute, /JSON\.stringify\(\{ ok: true, detail \}\)/, "detail 路由应返回 detail 字段");
});

test("标记完成/答错：路由必须回传 title（面板通知依赖；曾丢字段显示 undefined）", () => {
  assert.match(practiceRoute, /title: r\?\.title, message: r\?\.message/, "mark-done 路由应回传 title");
  assert.match(practiceRoute, /title: r\?\.title, message: "已记录答错/, "mark-wrong 路由应回传 title");
  assert.match(panelRest, /\$\{j\.title\}/, "面板通知读 j.title");
});

// ---------- focus 域契约（白名单断链 + week 日期格式） ----------
const focusRoute = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "job-hunter", "routes", "focus.mjs"),
  "utf8"
);
const focusLib = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "focus.mjs"),
  "utf8"
);

test("focus 黑/白名单：GET 返回 whitelist，POST 接受 whitelist（曾断链白名单被静默丢弃）", () => {
  assert.match(focusRoute, /blacklist: focusApi\.getBlacklist\(\), whitelist: focusApi\.getWhitelist\(\)/, "GET 应返回 whitelist");
  assert.match(focusRoute, /const \{ blacklist, whitelist \} = JSON\.parse/, "POST 应解构 whitelist");
  assert.match(focusRoute, /Array\.isArray\(whitelist\)\) focusApi\.setWhitelist/, "POST 应保存 whitelist");
  assert.match(panelRest, /j\.whitelist \|\| \[\]/, "面板白名单框读 j.whitelist");
});

test("focus week 日期：服务端本地 ISO，面板本地 todayStr（曾 M/D 导致星期空/今日不高亮）", () => {
  assert.match(focusLib, /week\.push\(\{ date: `\$\{d\.getFullYear\(\)\}-\$\{pad\(d\.getMonth/, "服务端应输出 YYYY-MM-DD");
  assert.doesNotMatch(focusLib, /date: `\$\{d\.getMonth\(\) \+ 1\}\/\$\{d\.getDate\(\)\}`/, "不应回退到 M/D 格式");
  assert.doesNotMatch(panelRest, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, "面板 todayStr 不应是 UTC 日期（东八区错位）");
});

// ---------- self-check 语义契约（ok = "检查全绿"，非"请求成功"） ----------
const panelChat = readFileSync(path.join(renderer, "panel-chat.js"), "utf8");
const panelJobs = readFileSync(path.join(renderer, "panel-jobs.js"), "utf8");

test("self-check：面板把 ok 当'检查全绿'而非'请求成功'（曾发现任何问题就误报'检查失败'）", () => {
  assert.match(panelChat, /renderSelfCheck\(j\);/, "POST 后把 j（报告本体）直接交给渲染");
  assert.doesNotMatch(panelChat, /j\.ok \? j : j\.report/, "不应按 ok 分支取报告（ok 是全绿标记）");
  assert.doesNotMatch(panelChat, /j\.error \|\| "检查失败"/, "不应在发现问题时误报检查失败");
  assert.match(panelJobs, /j\.issues\?\.length/, "panel-jobs 按 issues 判问题（ok 全绿语义）");
});
