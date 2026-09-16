// 爬取停止入口 / 互斥闸门回归护栏（闭环清查第五批②）
// 背景（三条都是"样子货"）：
//   ① createCrawlMutex 只有 begin 的临界区语义——`begin(async () => spawn(...))` 在 spawn 返回那一刻
//      就置回 running=false，而 discover 要跑几分钟 → isRunning() 几乎恒 false，
//      /api/run-discover 的 409「已有爬取任务运行中」与巡检「爬取中则跳过」两道闸门全部失效。
//   ② 没有任何停止入口：爬取卡住只能等它自己结束或杀掉整个桌宠。
//   ③ progress.json 与真实进程脱节：子进程被强杀时来不及写终态 → 永远 status:"running"，
//      面板一直显示"爬取中"且没有任何办法把它变回来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRouter } from "../lib/routes/router.mjs";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("crawl-stop");
mockLLM();

const { registerCoreRoutes } = await import("../lib/routes/core.mjs");
const { createCrawlMutex } = await import("../lib/widget-core.mjs");

function mockRes() {
  const chunks = [];
  return {
    chunks, destroyed: false, writableEnded: false, status: 0,
    writeHead(code) { this.status = code; return this; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; },
    on() {},
  };
}
function mockReq(method = "GET") {
  return { method, url: "/", headers: {}, on(ev, fn) { if (ev === "end") setImmediate(fn); return this; }, destroy() {} };
}
async function hit(router, pathname, method = "GET") {
  const entry = router.resolve(pathname, method);
  assert.ok(entry, `${pathname} 应已注册`);
  const res = mockRes();
  await entry.fn(mockReq(method), res, new URL(pathname, "http://x"));
  let json = {};
  try { json = JSON.parse(res.chunks.join("")); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

/** 假爬取子进程：可手动触发 exit（模拟 discover 退出） */
function fakeChild(pid = 4242) {
  const handlers = { exit: [], error: [] };
  return {
    pid, killed: 0,
    kill() { this.killed++; return true; },
    once(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
    emit(ev) { for (const fn of handlers[ev] || []) fn(); },
  };
}

test("互斥锁接管子进程存活期：spawn 返回后仍 running，退出才释放", async () => {
  const m = createCrawlMutex();
  assert.equal(m.isRunning(), false, "初始空闲");
  const child = fakeChild();
  const r = await m.begin(async () => { m.track(child); return true; });
  assert.equal(r, true);
  // 核心：begin 的 fn 已返回（真实世界里 spawn 也就这样返回），但子进程还活着 → 必须仍视为运行中
  assert.equal(m.isRunning(), true, "子进程存活期间必须恒为 running（否则 409 闸门形同虚设）");
  assert.equal(m.current(), child, "current() 应给出可停止的句柄");
  assert.equal(await m.begin(async () => true), false, "运行中二次 begin 必须拒绝并发");
  child.emit("exit");
  assert.equal(m.isRunning(), false, "子进程退出后自动释放");
  assert.equal(m.current(), null);
});

test("互斥锁 track 二次接管：拒绝并让调用方回收新进程（防双跑）", () => {
  const m = createCrawlMutex();
  const a = fakeChild(1), b = fakeChild(2);
  assert.equal(m.track(a), true);
  assert.equal(m.track(b), false, "已有爬取在跑时应拒绝第二个");
  assert.equal(m.current(), a, "仍持有第一个句柄");
  // 释放兜底：kill 无效时不至于永久锁死
  m.release();
  assert.equal(m.isRunning(), false);
});

test("POST /api/run-discover：已有爬取在跑 → 409（不再并发拉起 chromium）", async () => {
  const router = createRouter();
  let spawned = 0;
  registerCoreRoutes(router, { runtime: { runDiscoverHidden: () => { spawned++; }, crawlMutex: () => ({ isRunning: () => true }) } });
  const r = await hit(router, "/api/run-discover", "POST");
  assert.equal(r.status, 409);
  assert.equal(r.json.ok, false);
  assert.match(String(r.json.error), /运行中/);
  assert.equal(spawned, 0, "被闸门拦住时不得启动新爬取");
});

test("POST /api/run-discover：启动失败 → 如实报失败（原实现先写 status:running，面板会永远转圈）", async () => {
  const router = createRouter();
  registerCoreRoutes(router, {
    runtime: {
      crawlMutex: () => ({ isRunning: () => false }),
      runDiscoverHidden: async () => false, // spawn 没起来（并发竞争/子进程创建失败）
    },
  });
  const r = await hit(router, "/api/run-discover", "POST");
  assert.equal(r.json.ok, false, "没起来就必须如实报失败");
  assert.equal(r.status, 409);
  // 未注入 runDiscoverHidden（旧宿主/独立单测）时同样不得假成功
  const bare = createRouter();
  registerCoreRoutes(bare, {});
  const b = await hit(bare, "/api/run-discover", "POST");
  assert.equal(b.json.ok, false);
  assert.equal(b.status, 500);
});

test("POST /api/stop-discover：无任务在跑 → 200 + ok:false（幂等可预期，不当 HTTP 错误）", async () => {
  const router = createRouter();
  registerCoreRoutes(router, { runtime: { stopCrawl: () => ({ ok: false, error: "当前没有正在运行的爬取" }) } });
  const r = await hit(router, "/api/stop-discover", "POST");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(String(r.json.error), /没有正在运行/);
});

test("POST /api/stop-discover：停止成功 → ok:true + pid；未注入 → 如实报错", async () => {
  const router = createRouter();
  registerCoreRoutes(router, { runtime: { stopCrawl: () => ({ ok: true, pid: 999, message: "已被用户停止" }) } });
  const ok = await hit(router, "/api/stop-discover", "POST");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.pid, 999);
  // 未注入 stopCrawl（例如旧宿主）时不得假成功
  const bare = createRouter();
  registerCoreRoutes(bare, {});
  const r = await hit(bare, "/api/stop-discover", "POST");
  assert.equal(r.json.ok, false);
  assert.match(String(r.json.error), /未注入/);
});

test("GET /api/widget-data 带 crawlRunning（面板按钮态/轮询不得只信 progress.json）", async () => {
  const running = createRouter();
  registerCoreRoutes(running, { runtime: { crawlMutex: () => ({ isRunning: () => true }) } });
  const a = await hit(running, "/api/widget-data");
  assert.equal(a.json.ok, true);
  assert.equal(a.json.crawlRunning, true, "子进程在跑 → crawlRunning:true");
  const idle = createRouter();
  registerCoreRoutes(idle, { runtime: { crawlMutex: () => ({ isRunning: () => false }) } });
  const b = await hit(idle, "/api/widget-data");
  assert.equal(b.json.crawlRunning, false);
});

test("三态停止入口齐备：原生按钮/面板 handler、React、Vue、preload、IPC 声明", async () => {
  const html = await readFile(new URL("../desktop/renderer/panel.html", import.meta.url), "utf8");
  assert.match(html, /id="crawl-stop"/, "原生面板必须有「停止爬取」按钮");
  const native = await readFile(new URL("../desktop/renderer/panel-chat.js", import.meta.url), "utf8");
  assert.match(native, /\$\("crawl-stop"\)/, "原生面板必须绑定停止按钮");
  assert.match(native, /stopDiscover/, "原生走 IPC stopDiscover");
  assert.match(native, /r\?\.ok === false/, "启动/停止失败必须如实提示（原实现无条件显示已启动）");
  assert.match(native, /crawlRunning/, "按钮态/进度必须参考真实存活状态");
  const react = await readFile(new URL("../desktop/renderer/panel-react/src/tabs/Crawl.jsx", import.meta.url), "utf8");
  assert.match(react, /stopDiscover/, "React 版必须有停止入口");
  const vue = await readFile(new URL("../desktop/renderer/panel-vue-review/src/tabs/Crawl.vue", import.meta.url), "utf8");
  assert.match(vue, /stopDiscover/, "Vue 版必须有停止入口");
  const preload = await readFile(new URL("../desktop/preload.js", import.meta.url), "utf8");
  assert.match(preload, /stopDiscover: \(\) => ipcRenderer\.invoke\("widget:stop-discover"\)/, "preload 必须暴露 stopDiscover");
  const main = await readFile(new URL("../desktop/main.ts", import.meta.url), "utf8");
  assert.match(main, /safeHandle\("widget:stop-discover"/, "主进程必须有对应 handler");
});
