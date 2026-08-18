// scripts/_diag-restart-btn.mjs —— 诊断「一键重启」按钮：点击后 restartApp 是否被调用
import { bootPanel, tick } from "../tests/panel-helper.mjs";

const ctx = bootPanel();
const { window, kanban } = ctx;
let restartCalled = 0;
kanban.restartApp = async () => { restartCalled++; return { ok: true }; };

const btn = window.document.getElementById("restart-btn");
console.log("restart-btn 元素:", btn ? "存在" : "不存在");
if (btn) {
  // mock confirm 自动确认
  window.confirm = () => true;
  btn.click();
  await tick(50);
  console.log("restartApp 被调用次数:", restartCalled);
  console.log("按钮状态: disabled =", btn.disabled, "text =", JSON.stringify(btn.textContent));
}
await new Promise((r) => setTimeout(r, 30));
window.clearAllTimers();
ctx.dom.window.close();
