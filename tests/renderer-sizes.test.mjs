// 三态对比展示（前端三态并行展示工单任务 4）测试
// ① 对比卡数据"真实"：renderer-sizes.js 的字节数必须与磁盘上的 dist 产物/原生脚本实测一致（±1% 容差防构建差异）
// ② 面板接线：panel.html 引入 renderer-sizes.js；panel-core.js 在切换条旁渲染对比卡
// ③ 对比维度齐全：包体积（实测）/渲染方式/状态管理范式/框架特色
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => path.join(ROOT, p);
const renderer = R("desktop/renderer");

/** 从生成文件里取回数据对象（它是给普通 script 用的 window.xxx = {...}，测试里用 vm 求值最忠实） */
function loadSizes() {
  const src = readFileSync(path.join(renderer, "renderer-sizes.js"), "utf8");
  const sandbox = { window: {} };
  new Function("window", src)(sandbox.window);
  return sandbox.window.__RENDERER_SIZES;
}

const close = (a, b, tol = 0.01) => Math.abs(a - b) <= Math.max(1, b * tol);

test("对比卡包体积 = dist 产物实测（还原到磁盘字节，含 gzip）", () => {
  const S = loadSizes();
  assert.ok(S && S.measuredAt, "有测量日期（不写死数字的凭据）");

  // React / Vue：单文件实测
  const react = statSync(path.join(renderer, "panel-react/dist/assets/react-panel.js"));
  assert.ok(S.react, "React 体积已测量");
  assert.ok(close(S.react.bytes, react.size), `React 原始体积与磁盘一致（记录 ${S.react.bytes} vs 磁盘 ${react.size}）`);
  const reactGzip = gzipSync(readFileSync(path.join(renderer, "panel-react/dist/assets/react-panel.js"))).length;
  assert.ok(close(S.react.gzip, reactGzip), `React gzip 体积与磁盘一致（记录 ${S.react.gzip} vs 实测 ${reactGzip}）`);

  const vue = statSync(path.join(renderer, "panel-vue-review/dist/assets/vue-review.js"));
  assert.ok(S.vue, "Vue 体积已测量");
  assert.ok(close(S.vue.bytes, vue.size), `Vue 原始体积与磁盘一致（记录 ${S.vue.bytes} vs 磁盘 ${vue.size}）`);

  // 原生：panel-*.js 求和（无打包步骤，多个 script 直引）
  const dir = renderer;
  const files = readdirSync(dir).filter((f) => f.startsWith("panel-") && f.endsWith(".js") && f !== "panel-react.bundle.js");
  const sum = files.reduce((n, f) => n + statSync(path.join(dir, f)).size, 0);
  assert.ok(S.native && close(S.native.bytes, sum), `原生体积 = panel-*.js 实测求和（记录 ${S.native?.bytes} vs 磁盘 ${sum}）`);
  assert.equal(S.native.files, files.length, `原生文件数一致（记录 ${S.native.files} vs 磁盘 ${files.length}）`);
});

test("面板接线：panel.html 引入 sizes 脚本 + panel-core 在切换条旁渲染对比卡", () => {
  const html = readFileSync(path.join(renderer, "panel.html"), "utf8");
  assert.ok(/<script src="renderer-sizes\.js"><\/script>/.test(html), "panel.html 引入 renderer-sizes.js");
  const core = readFileSync(path.join(renderer, "panel-core.js"), "utf8");
  assert.ok(core.includes("initRendererCompare()"), "启动时初始化对比卡");
  assert.ok(/renderer-compare-btn/.test(core), "切换条旁有对比入口按钮");
  assert.ok(/bar\.insertAdjacentElement\("afterend", cardEl\)/.test(core), "对比卡挂在切换条之后（入口旁可见）");
});

test("对比维度齐全且为三态并列（渲染方式/状态管理/框架特色/包体积）", () => {
  const core = readFileSync(path.join(renderer, "panel-core.js"), "utf8");
  for (const dim of ["渲染方式", "状态管理", "框架特色"]) {
    assert.ok(core.includes(`"${dim}"`), `对比维度：${dim}`);
  }
  for (const [paradigm, kw] of [
    ["原生=命令式 DOM", "命令式 DOM"],
    ["React=虚拟 DOM", "虚拟 DOM"],
    ["Vue=响应式模板", "响应式模板"],
    ["原生状态=模块单例+事件", "emitPanelEvent"],
    ["React 状态=useReducer", "useReducer"],
    ["Vue 状态=ref/computed", "computed"],
  ]) {
    assert.ok(core.includes(kw), `范式标注：${paradigm}`);
  }
  assert.ok(core.includes("window.__RENDERER_SIZES"), "体积取自实测文件（不写死）");
  assert.ok(/gzip/.test(core), "同时展示 gzip 传输量");
});

test("数据文件缺失时不崩（降级提示而不是空白/报错）", () => {
  assert.ok(existsSync(path.join(renderer, "renderer-sizes.js")), "生成文件已入库");
  const core = readFileSync(path.join(renderer, "panel-core.js"), "utf8");
  assert.ok(/if \(!S\) return/.test(core), "缺数据时返回可读提示（附重新生成命令）");
  assert.ok(/gen-renderer-sizes\.mjs/.test(core), "提示里给出重新生成命令");
});
