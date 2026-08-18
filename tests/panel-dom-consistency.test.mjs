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
