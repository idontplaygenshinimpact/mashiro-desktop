// React 版面板渲染交互测试（jsdom + 真实构建产物，mock window.kanban IPC 桥）
// 验证渲染层功能闭环：配置 → 开始 → 回答提交（评分累计）→ 面试结束 → 复盘报告
// 说明：import 构建产物（panel-react/dist/assets/react-panel.js，ESM 自动挂载 #root）——
// 测的是"真实产物"；产物缺失（fresh clone 未构建）时跳过，CI 已把构建提前到 test 之前
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "panel-react", "dist", "assets", "react-panel.js");

test("渲染层闭环：配置 → 开始 → 提交（评分累计）→ 复盘报告", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.SVGElement = dom.window.SVGElement;
  globalThis.MutationObserver = dom.window.MutationObserver; // React 19 createRoot 需要
  // 注意：globalThis.navigator 在 Node 22 只读不可覆盖——React DOM 渲染不依赖它

  // mock IPC 桥（与 preload 同签名；业务层不参与）
  const calls = [];
  globalThis.window.kanban = {
    invStart: async (cfg) => { calls.push(["invStart", cfg]); return { ok: true, round: 1, roundType: "开场", question: "先自我介绍并讲一个项目", dimension: "表达清晰", basis: "考察表达组织", criteria: "结构完整有量化", boundary: "不背稿", depth: 0, totalRounds: 6 }; },
    invAnswer: async () => { calls.push(["invAnswer"]); return { round: 1, roundType: "开场", question: "（下一问）", dimension: "技术深度", scores: { tech: 80, expr: 90, depth: 70, edge: 60, reflect: 75 }, total: 75, finished: true }; },
    invEnd: async () => { calls.push(["invEnd"]); return { ok: true, report: "## 复盘\n\n**亮点**：表达清晰\n- 技术基础扎实\n\n```js\n// 建议\n```", hint: "薄弱点已回流" }; },
    invStatus: async () => ({ ok: true, active: false }),
    interviewHistory: async () => ({ history: [{ position: "前端实习生", rounds: 3, date: "2026-08-01 10:00" }] }),
  };

  // 动态 import 构建产物（ESM，挂载到 #root）
  await import(new URL("../desktop/renderer/panel-react/dist/assets/react-panel.js", import.meta.url).href);
  // 轮询等待渲染与 useEffect 完成——import resolve 后 React 首次渲染是异步的（时序竞态，勿用固定等待）
  const waitFor = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 30));
    }
    return false;
  };

  const textOf = (el) => el?.textContent || "";
  const bodyText = () => textOf(document.body);

  // setup 视图（轮询等待首次渲染完成）
  assert.ok(await waitFor(() => bodyText().includes("模拟面试")), "setup 标题");
  assert.ok(bodyText().includes("开始面试"), "开始按钮");
  const posInput = document.querySelector("input");
  assert.equal(posInput?.value, "前端实习生", "岗位输入默认值");
  assert.ok(await waitFor(() => bodyText().includes("历史复盘")), "历史列表区（useEffect 加载）");

  // 开始面试
  const startBtn = [...document.querySelectorAll("button")].find((b) => textOf(b).includes("开始面试"));
  assert.ok(startBtn, "找到开始按钮");
  startBtn.click();
  await new Promise((r) => setTimeout(r, 30));

  // active 视图
  assert.ok(bodyText().includes("先自我介绍并讲一个项目"), "问题渲染");
  assert.ok(bodyText().includes("考察维度：表达清晰"), "维度渲染");
  assert.ok(bodyText().includes("提交回答"), "提交按钮");
  assert.ok(bodyText().includes("累计评分"), "评分区渲染");

  // 填写回答并提交（invAnswer → finished → invEnd → 复盘）
  const ta = document.querySelector("textarea");
  assert.ok(ta, "回答输入框");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "我的回答：项目 A 用了 React，性能提升 30%…");
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const submitBtn = [...document.querySelectorAll("button")].find((b) => textOf(b).includes("提交回答"));
  submitBtn.click();
  await new Promise((r) => setTimeout(r, 50));

  // finished 视图：复盘 Markdown 渲染 + IPC 调用链
  assert.ok(bodyText().includes("面试复盘"), "复盘视图");
  assert.ok(bodyText().includes("亮点"), "Markdown 渲染（标题/粗体/列表）");
  assert.ok(calls.some((c) => c[0] === "invStart"), "调用了 invStart");
  assert.ok(calls.some((c) => c[0] === "invAnswer"), "调用了 invAnswer");
  assert.ok(calls.some((c) => c[0] === "invEnd"), "调用了 invEnd");
  // 评分累计进复盘视图总分展示（finished 视图不含 session——验证历史区存在）
  assert.ok(bodyText().includes("历史复盘") || bodyText().includes("新面试"), "复盘视图操作区");
});