// scripts/_diag-panel-load.mjs —— 诊断面板脚本顶层加载异常（jsdom 模拟真实加载）
// 逐文件拼接 eval（与 panel.html script 顺序一致），捕获顶层抛错并打印
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer");
const html = readFileSync(path.join(renderer, "panel.html"), "utf8");
const SCRIPTS = ["panel-core.js", "panel-study.js", "panel-chat.js", "panel-jobs.js", "panel-rest.js"];

const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1:8899/panel.html", pretendToBeVisual: true });
const { window } = dom;
window.kanban = { notify() {}, speechToText: async () => ({ ok: false }) };
window.fetch = async (url, _opts = {}) => {
  const u = String(url);
  if (u.includes("study/detail") || u.includes("stream")) {
    // SSE 流：mock 一个可读 body
    const enc = new TextEncoder();
    return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(enc.encode('data: {"content":"测试内容","topic":"测试"}\n\n')); c.close(); } }) };
  }
  return { ok: true, json: async () => ({ ok: true, active: false, phase: "idle", todayMinutes: 0, week: [], goal: "", items: [], list: [], goals: [] }) };
};
window.addEventListener("error", (e) => console.error("window.onerror:", e.message));

try {
  window.eval(SCRIPTS.map((f) => readFileSync(path.join(renderer, f), "utf8")).join("\n"));
  console.log("✅ 全部脚本顶层加载无异常");
} catch (e) {
  console.error("❌ 顶层加载抛错:", e?.message || e);
  console.error(e?.stack?.split("\n").slice(0, 6).join("\n"));
  process.exitCode = 1;
} finally {
  dom.window.close();
}
