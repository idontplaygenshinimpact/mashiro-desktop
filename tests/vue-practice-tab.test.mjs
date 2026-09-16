// Vue 版「专项练习」Tab 源码级护栏（前端三态并行展示工单任务 3 补口）：
// Practice.vue 是唯一带 CodeMirror 6 判题编辑器的 Vue Tab，且复用与原生/React 同一 HTTP 路由
// （/api/challenges*，经 api() 解析实际端口）。
// 护栏守的是「真实缺陷要修、不许放宽断言变绿」：逐项源码断言 + 反证一次（改错路径必须红）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "panel-vue-review", "src");
const PRACTICE = path.join(SRC_DIR, "tabs", "Practice.vue");
const MAIN = path.join(SRC_DIR, "main.js");

/** 对指定源码字符串逐项断言，返回失败信息数组（空 = 全部通过）。
 *  抽成函数既能测真实源码（绿），也能测篡改串（反证护栏确实会红）。 */
function assess(src) {
  const fails = [];
  const has = (needle) => src.includes(String(needle));
  const hasPath = (path) => new RegExp(`["'\`]/api/challenges${path}["'\`]`).test(src);
  // ① 确实引入了 CodeMirror（判题编辑器本体，不是手搓 textarea）
  if (!has("codemirror")) fails.push("未 import/引用 codemirror（编辑器必须 CodeMirror 6）");
  if (!has("basicSetup") || !/\bjavascript\(\s*\)/.test(src)) fails.push("缺少 basicSetup 或 javascript() 扩展");
  if (!has("oneDark")) fails.push("缺少 oneDark 主题");
  if (!has("indentWithTab")) fails.push("缺少 indentWithTab（Tab 缩进）");
  if (!has("Mod-Enter")) fails.push("缺少 Mod-Enter 判题快捷键");
  // ② 走统一 api() 并命中四个契约路由（前端不许另起协议/直连裸地址）
  if (!has("from \"../api.js\"") && !has("from '../api.js'")) fails.push("未从 ../api.js 引用统一 api()");
  // 路由用「带引号边界的精确匹配」：只改路径名也必须红（子串 includes 会被 /run-xxx 蒙混过关，护栏就形同虚设）
  if (!hasPath("")) fails.push("未调用列表路由 /api/challenges");
  if (!hasPath("/run")) fails.push("未调用判题路由 /api/challenges/run");
  if (!hasPath("/mark-done")) fails.push("未调用标记完成路由 /api/challenges/mark-done");
  if (!hasPath("/mark-wrong")) fails.push("未调用记错路由 /api/challenges/mark-wrong");
  // ③ 不许硬编码端口（api() 内部解析实际端口，这是与其它 Tab 一致性的生命线）
  const m = src.match(/8899/);
  if (m) fails.push("硬编码端口 8899（必须经 api() 解析基址）");
  // ④ 卸载清理：onUnmounted 里 destroy()（切 Tab 不泄漏 CodeMirror DOM/监听）
  if (!has("onUnmounted")) fails.push("缺少 onUnmounted 清理钩子");
  if (!/onUnmounted\([\s\S]{0,200}destroy/.test(src)) fails.push("onUnmounted 里没有 view.destroy()");
  if (!has("editorHost")) fails.push("缺少编辑器挂载点 ref(editorHost)");
  return fails;
}

test("Practice.vue 存在且含 CodeMirror 6 + 四个判题路由 + api() + onUnmounted destroy（源码级）", () => {
  assert.ok(existsSync(PRACTICE), `Practice.vue 必须存在：${PRACTICE}`);
  const src = readFileSync(PRACTICE, "utf8");
  const fails = assess(src);
  assert.deepEqual(fails, [], `Practice.vue 未过护栏：\n` + (fails.length ? fails.map((f) => "  ❌ " + f).join("\n") : "（无）"));
});

test("Vue Tab 注册表包含 practice（main.js 登记）", () => {
  const src = readFileSync(MAIN, "utf8");
  assert.ok(/\bpractice\s*:\s*PracticeTab/.test(src), "TABS 注册表里必须有 practice: PracticeTab");
  assert.ok(src.includes('from "./tabs/Practice.vue"'), "必须 import Practice.vue");
});

test("反证：把判题路由 /api/challenges/run 改成不存在的路径 → 护栏必须红", () => {
  const src = readFileSync(PRACTICE, "utf8");
  // 篡改：判题路径换成不存在的 /api/challenges/run-xxx → 护栏应抓出「未调用判题路由」
  const tampered = src.replace("/api/challenges/run", "/api/challenges/run-wrong-path");
  const fails = assess(tampered);
  assert.ok(
    fails.some((f) => f.includes("/api/challenges/run")),
    `反证失败：篡改判题路径后护栏仍全绿（failures=${JSON.stringify(fails)}）`
  );
  // 同时确保篡改没有波及到 mark-done/mark-wrong（否则是测试 bug，不是护栏）
  assert.ok(tampered.includes("/api/challenges/mark-done"), "反证前提：mark-done 未被误改");
  assert.ok(tampered.includes("/api/challenges/mark-wrong"), "反证前提：mark-wrong 未被误改");
});

test("整仓无其它 Vue Tab 硬编码 8899（practice 之外的 Tab 一致性）", () => {
  const tabsDir = path.join(SRC_DIR, "tabs");
  const files = readdirSync(tabsDir).filter((f) => f.endsWith(".vue"));
  const offenders = files.filter((f) => {
    const s = readFileSync(path.join(tabsDir, f), "utf8");
    return /\b8899\b/.test(s);
  });
  assert.deepEqual(offenders, [], "任何 Vue Tab 都不得硬编码 8899（统一走 api()）");
});
