// preload 流式桥回归护栏（闭环清查）：SSE 事件必须按类型送到正确的回调
// 背景：streamPromise 把 type:"delta" 只发给 onChunk，非 delta 才给 onEvent。
// chatStream 原先把 onChunk 写成空函数 → 三态渲染层的正文增量全丢（React/Vue 的 delta 分支不触发、
// 原生面板的流式逐句语音播报失效），只有 done 一次性出全文；本测试用 vm 加载真实 preload.js 锁死该行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "preload.js");

/** 在受控沙箱里加载真实 preload.js，返回被 exposeInMainWorld 暴露的 API + 可控的 ipcRenderer 桩 */
function loadPreload() {
  const src = readFileSync(PRELOAD, "utf8");
  const listeners = new Map(); // chan → listener
  const invoked = [];
  const ipcRenderer = {
    on(chan, fn) { listeners.set(chan, fn); },
    removeListener(chan) { listeners.delete(chan); },
    invoke(name, args) { invoked.push({ name, args }); return Promise.resolve({ ok: true }); },
    send() {},
  };
  let api = null;
  const sandbox = {
    require: (id) => {
      if (id === "electron") return { contextBridge: { exposeInMainWorld: (_k, v) => { api = v; } }, ipcRenderer };
      throw new Error(`unexpected require: ${id}`);
    },
    process: { argv: [], env: {} },
    console,
    setTimeout,
    clearTimeout,
    Promise,
  };
  vm.runInNewContext(src, sandbox, { filename: PRELOAD });
  assert.ok(api, "preload 应通过 contextBridge 暴露 kanban API");
  /** 向指定 channel 推一条 SSE 行（模拟主进程转发） */
  const emit = (chan, obj) => {
    const fn = [...listeners.entries()].find(([c]) => c.startsWith(chan))?.[1];
    assert.ok(fn, `应有监听器订阅 ${chan}（实际：${[...listeners.keys()].join(",")}）`);
    fn({}, `data: ${JSON.stringify(obj)}\n\n`);
  };
  return { api, emit, invoked, listeners };
}

test("chatStream：正文 delta 必须透传给调用方（否则流式正文/语音逐句全丢）", async () => {
  const { api, emit } = loadPreload();
  const events = [];
  const p = api.chatStream("你好", [], (ev) => events.push(ev), "s-1");
  emit("chat-chunk", { type: "start" });
  emit("chat-chunk", { type: "delta", delta: "宏任务与" });
  emit("chat-chunk", { type: "delta", delta: "微任务" });
  emit("chat-chunk", { type: "tool_start", name: "web_search", args: { query: "事件循环" } });
  emit("chat-chunk", { type: "done", reply: "宏任务与微任务" });
  const done = await p;

  const deltas = events.filter((e) => e.type === "delta").map((e) => e.delta);
  assert.deepEqual(deltas, ["宏任务与", "微任务"], "两段 delta 都应送达渲染层回调（按顺序）");
  assert.ok(events.some((e) => e.type === "tool_start"), "工具事件仍走同一回调（不回归）");
  assert.equal(done.reply, "宏任务与微任务", "done 载荷经 Promise 返回");
});

test("chatStream：sessionId 进 invoke 载荷（多会话隔离靠它）", async () => {
  const { api, invoked, emit } = loadPreload();
  const p = api.chatStream("hi", [], () => {}, "session-42");
  emit("chat-chunk", { type: "done", reply: "ok" });
  await p;
  const call = invoked.find((c) => c.name === "widget:chat-stream");
  assert.ok(call, "应调用 widget:chat-stream");
  assert.equal(call.args.sessionId, "session-42", "sessionId 必须进载荷");
  assert.equal(typeof call.args.__streamToken, "number", "并发隔离 token 仍在");
});

test("其它流式桥不回退：studyDetailStream 的 delta 仍走 onChunk", async () => {
  const { api, emit } = loadPreload();
  const chunks = [];
  const p = api.studyDetailStream("item-1", (d) => chunks.push(d));
  emit("study-detail-chunk", { type: "delta", delta: "第一段" });
  emit("study-detail-chunk", { type: "delta", delta: "第二段" });
  emit("study-detail-chunk", { type: "done", reply: "完" });
  await p;
  assert.deepEqual(chunks, ["第一段", "第二段"], "学习讲解流仍按 onChunk 累积");
});
