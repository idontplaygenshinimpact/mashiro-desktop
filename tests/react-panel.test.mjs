// React 版面板护栏（渲染层可替换性验证）：
// ① main.mjs 有 React 窗口接线（同一 preload IPC 桥）；② react-panel.html 引用构建产物；
// ③ React 源码存在（jsx/markdown）；④ 业务层零改动（interview.mjs 无 React 相关侵入）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => path.join(ROOT, p);

test("React 面板窗口接线：main.mjs 有 createReactPanelWindow + 托盘入口（同一 preload 桥）", () => {
  const main = readFileSync(R("desktop/main.mjs"), "utf8");
  assert.ok(main.includes("createReactPanelWindow"), "窗口创建函数存在");
  assert.ok(main.includes("panel-react"), "加载独立 Vite 项目（panel-react/dist/index.html）");
  assert.ok(main.includes("React 版"), "托盘入口存在");
  assert.ok(/preload:\s*path\.join\(__dirname, "preload\.js"\)/.test(main), "复用同一 preload IPC 桥");
});

test("panel-react 独立 Vite 项目结构（package.json/vite.config/src/dist）", () => {
  assert.ok(existsSync(R("desktop/renderer/panel-react/package.json")), "子项目 package.json");
  assert.ok(existsSync(R("desktop/renderer/panel-react/vite.config.js")), "vite 配置");
  assert.ok(existsSync(R("desktop/renderer/panel-react/index.html")), "入口 html");
  for (const f of ["main.jsx", "panel.jsx", "score.jsx", "markdown.js"]) {
    assert.ok(existsSync(R("desktop/renderer/panel-react/src/" + f)), `src/${f} 存在`);
  }
  assert.ok(existsSync(R("desktop/renderer/panel-react/dist/index.html")), "构建产物 dist/index.html");
  assert.ok(existsSync(R("desktop/renderer/panel-react/dist/assets/react-panel.js")), "构建产物 react-panel.js");
});

test("React 面板只经 window.kanban IPC 桥驱动（不直连后端/不 import 业务层）", () => {
  const panel = readFileSync(R("desktop/renderer/panel-react/src/panel.jsx"), "utf8");
  // 必须使用 IPC 桥（window.kanban.invXxx）且不直连 8899/不 import lib 业务层
  for (const m of ["window.kanban.invStart", "window.kanban.invAnswer", "window.kanban.invEnd", "window.kanban.invStatus", "window.kanban.interviewHistory"]) {
    assert.ok(panel.includes(m), `使用 ${m}`);
  }
  assert.ok(!panel.includes("8899"), "不直连后端端口（解耦验证）");
  assert.ok(!panel.includes('from "../../lib/'), "不 import 业务层（解耦验证）");
});

test("业务层零改动：interview.mjs 不感知 React 渲染层", () => {
  const biz = readFileSync(R("lib/interview.mjs"), "utf8");
  assert.ok(!biz.includes("react"), "业务层无 React 相关代码");
  assert.ok(!biz.includes("window.kanban"), "业务层不引用渲染层 IPC");
});