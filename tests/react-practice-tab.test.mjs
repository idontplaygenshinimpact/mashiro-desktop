// React 版「专项练习」Tab 护栏（前端三态 CodeMirror 6 升级工单 · React 侧）
// 断言四件事：① Practice.jsx 存在且用 CodeMirror 6（import 'codemirror'）；
// ② main.jsx 的 TABS 注册表登记了 practice（React 版有该 Tab）；
// ③ 组件经统一 api() 调用判题四路由（列表/运行/mark-done/mark-wrong），且不硬编码 8899；
// ④ 编辑器卸载时 destroy()（切 Tab 不泄漏 DOM/状态）。
// 附带一份"反证"：把 /api/challenges/run 改成不存在的路径 → 护栏必红（证明非空断言，
// 不是"删掉检查就绿"）。恢复后全绿（验证过程记录在最终回答）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => path.join(ROOT, p);
const REACT = "desktop/renderer/panel-react/src";

function src(p) {
  const f = R(path.join(REACT, p));
  assert.ok(existsSync(f), `文件存在：${p}`);
  return readFileSync(f, "utf8");
}

/**
 * 端点是否作为"被引号包裹的完整路径字面量"出现（如 api("/api/challenges/run", ...)）。
 * 为什么不用裸 `.includes('/api/challenges/run')`：反证时把路径改成
 * `/api/challenges/run-BROKEN` 这种"前缀相同但已损坏"的字符串，`.includes` 仍会命中子串
 * → 护栏假绿（反证失效，正是第一版护栏暴露出来的真实缺陷）。
 * 这里要求路径后紧跟收尾引号，"改成不存在的路径"（无论是否保留了公共前缀）都会打红。
 */
const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const QUOTED = (path) => new RegExp(`["']${escapeReg(path)}["']`);

test("Practice.jsx 存在且使用 CodeMirror 6（import codemirror）", () => {
  const code = src("tabs/Practice.jsx");
  assert.ok(code.includes("codemirror"), "import 了 codemirror（CodeMirror 6 基础包）");
  // 扩展至少：basicSetup / javascript / oneDark / indentWithTab
  assert.ok(code.includes("basicSetup"), "含 basicSetup");
  assert.ok(code.includes("javascript"), "含 javascript() 语法扩展");
  assert.ok(code.includes("oneDark"), "含 oneDark 深色主题");
  assert.ok(/import\s*{[^}]*indentWithTab/.test(code), "含 indentWithTab（Tab 缩进）");
});

test("React TABS 注册表登记了 practice（React 版有专项练习 Tab）", () => {
  const main = src("main.jsx");
  assert.ok(/practice:\s*PracticePanel/.test(main), "TABS 注册表含 practice: PracticePanel");
  assert.ok(/\bimport\s*\{[^}]*PracticePanel[^}]*\}\s*from\s*["']\.\/tabs\/Practice\.jsx["']/.test(main), "import 了 PracticePanel");
});

test("Practice.jsx 经统一 api() 调用判题四路由 + 不硬编码端口", () => {
  const code = src("tabs/Practice.jsx");
  assert.ok(code.includes('from "../api.js"'), "数据入口走统一 api client（api.js）");
  for (const ep of [
    '/api/challenges?',            // 题库列表（带查询串字面量）
    '/api/challenges/run',         // 判题
    '/api/challenges/mark-done',   // 标记完成
    '/api/challenges/mark-wrong',  // 记错题
  ]) {
    assert.ok(QUOTED(ep).test(code), `用 api() 调用了完整路径字面量 ${ep}`);
  }
  assert.ok(!code.includes("8899"), "不硬编码端口（复用 api-client 单一来源）");
});

test("编辑器卸载时 destroy()（切 tab 不泄漏 EditorView）", () => {
  const code = src("tabs/Practice.jsx");
  // 卸载清理：useEffect cleanup 里 destroy CodeMirror EditorView（或等价清理，如 viewRef.current=null 前 destroy）
  assert.ok(/view\.destroy\(\)|editor\.destroy\(\)|\.destroy\(\)/.test(code), "显式调用了 destroy() 清理编辑器");
  assert.ok(/return\s*\(\)\s*=>/.test(code) || /=>\s*\{[^}]*destroy|cleanup/.test(code), "在 useEffect cleanup 里做销毁");
});

test("反证基线：判题用真实端点（一旦改坏路由名，此测试与上面 api() 断言一起红）", () => {
  const code = src("tabs/Practice.jsx");
  // 正常态：/api/challenges/run 必须作为完整路径字面量存在（与 QUOTED 同口径）
  assert.ok(QUOTED("/api/challenges/run").test(code), "/api/challenges/run 真实存在");
});
