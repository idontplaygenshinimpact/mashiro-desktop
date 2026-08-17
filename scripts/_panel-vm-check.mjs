// 模拟浏览器环境按序执行拆分后的 panel 文件，验证顶层执行无 ReferenceError
// stub：window/document/元素（Proxy 通吃）/fetch/EventSource 等
import { readFileSync } from "node:fs";
import vm from "node:vm";

function makeEl() {
  const handler = {
    get(t, prop) {
      if (prop === "addEventListener") return () => {};
      if (prop === "removeEventListener") return () => {};
      if (prop === "querySelectorAll") return () => [];
      if (prop === "querySelector") return () => makeEl();
      if (prop === "closest") return () => makeEl();
      if (prop === "scrollIntoView") return () => {};
      if (prop === "focus") return () => {};
      if (prop === "click") return () => {};
      if (prop === "appendChild") return () => {};
      if (prop === "removeChild") return () => {};
      if (prop === "setAttribute") return () => {};
      if (prop === "getAttribute") return () => null;
      if (prop === "classList") return { add(){}, remove(){}, toggle(){}, contains(){return false;} };
      if (prop === "style") return { setProperty(){}, getPropertyValue: () => "", removeProperty(){} };
      if (prop === "dataset") return {};
      if (prop === "value") return "";
      if (prop === "textContent") return "";
      if (prop === "innerHTML") return "";
      if (prop === "checked") return false;
      if (prop === "files") return [];
      if (prop === "hidden") return false;
      if (prop === "disabled") return false;
      if (prop === "width") return 0;
      if (prop === "height") return 0;
      if (prop === "rows") return 0;
      if (prop === "toLowerCase") return () => "";
      if (prop === "toString") return () => "";
      if (typeof prop === "symbol") return undefined;
      return () => makeEl(); // 其他方法调用返回假元素
    },
    set() { return true; },
    has() { return true; },
  };
  return new Proxy(function () {}, handler);
}

const el = makeEl();
const sandbox = {
  console,
  window: { addEventListener(){}, kanban: {}, innerWidth: 1280, innerHeight: 800 },
  document: {
    getElementById: () => el,
    querySelectorAll: () => [],
    querySelector: () => el,
    addEventListener: () => {},
    body: el,
    documentElement: el,
    createElement: () => el,
    title: "",
  },
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }), text: async () => "" }),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { mediaDevices: {}, userAgent: "" },
  EventSource: class { constructor() {} close() {} },
  AbortController,
  performance,
  URL,
  Blob,
  FileReader: class { readAsDataURL() {} },
  FormData: class { append() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  confirm: () => false,
  alert: () => {},
  structuredClone: (v) => JSON.parse(JSON.stringify(v)),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  MediaRecorder: class { start() {} stop() {} ondataavailable() {} onstop() {} },
  webkitAudioContext: class {},
  AudioContext: class {},
  Image: class { set src(v) {} },
  screen: { width: 1920, height: 1080 },
};
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.fetch = sandbox.fetch;
sandbox.window.confirm = sandbox.confirm;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const FILES = ["panel-core.js", "panel-study.js", "panel-chat.js", "panel-jobs.js", "panel-rest.js"];
// 真实浏览器：多个普通 script 的顶层 let/const/function 共享全局词法环境（跨 script 可见）。
// vm 逐文件执行不共享 → 拼接成单个 script 再执行，等价浏览器语义
const combined = FILES.map((f) => {
  const code = readFileSync(`desktop/renderer/${f}`, "utf8");
  return `// ===== ${f} =====\n${code}`;
}).join("\n");
try {
  vm.runInContext(combined, sandbox, { filename: "panel-combined.js", timeout: 30000 });
  console.log("✅ 5 个文件拼接执行（浏览器全局语义）顶层无异常");
} catch (e) {
  console.log(`❌ 顶层执行异常: ${e.message.slice(0, 300)}`);
  console.log(`   位置: ${String(e.stack || "").split("\n").slice(0, 3).join(" | ")}`);
  process.exit(1);
}
console.log("✅ 全部文件顶层执行通过（模拟 DOM 环境）");
