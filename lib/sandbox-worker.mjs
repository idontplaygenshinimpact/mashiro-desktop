// 判题执行 worker：接收 {userCode, testCode, skeleton}，在 vm 沙箱（worker 线程内）执行并回报结果
// 本文件只在 worker 线程运行——即使 vm 逃逸，触达的也是本 worker 的进程对象（无用户数据、可被 terminate 回收）
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

// ---------- 逃逸防护（tests/sandbox.test.mjs ③b 实测暴露的真漏洞，2026-08 修复） ----------
// worker_threads 与主进程同进程：vm 注入的 Promise/Date 等是 worker realm 对象，原型链可达
// worker 的 Function → 用户代码可 `Promise.constructor("return process")()` 拿到 worker 的 process。
// 实测两个真实危害：
//   1. process.exit() / process.kill() 会终止整个 Node 进程（worker 与主进程同进程）——判题代码可杀桌宠（DoS）
//   2. process.env 是主进程 env 的共享视图——判题代码可读 LLM API key 等敏感配置
// 修复：worker 入口遮蔽危险方法 + 清理敏感 env。worker 自身逻辑不用 exit/env 操作，无副作用。
const DANGEROUS_PROCESS_METHODS = ["exit", "kill", "abort", "disconnect", "binding", "dlopen", "chdir"];
for (const k of DANGEROUS_PROCESS_METHODS) {
  try { Object.defineProperty(process, k, { value: undefined, configurable: true }); } catch { /* 遮蔽失败不影响（worker 自身不用） */ }
}
const SENSITIVE_ENV_PATTERNS = ["DEEPSEEK_API_KEY", "MIANSHI_", "OPENAI", "ANTHROPIC", "API_KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"];
for (const k of Object.keys(process.env)) {
  if (SENSITIVE_ENV_PATTERNS.some((p) => k.includes(p))) {
    try { delete process.env[k]; } catch { /* ignore */ }
  }
}

const { userCode, testCode, skeleton } = workerData || {};
const tests = [];
const logs = [];
const VM_TIMEOUT_MS = 25000; // vm 同步执行上限（主线程 terminate 是最终兜底）

function buildExportArgs(skeleton) {
  const names = [];
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*function\s+(\w+)/g)) names.push(m[1]);
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*class\s+(\w+)/g)) names.push(m[1]);
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*var\s+(\w+)\s*=\s*(?:async\s+)?function/g)) names.push(m[1]);
  return [...new Set(names)].join(", ");
}

(async () => {
  try {
    const exportArgs = buildExportArgs(skeleton);
    const sandbox = {
      console: {
        log: (...a) => logs.push(a.map(String).join(" ")),
        error: (...a) => logs.push("[error] " + a.map(String).join(" ")),
        warn: (...a) => logs.push("[warn] " + a.map(String).join(" ")),
      },
      __sleep__: (ms) => new Promise((r) => setTimeout(r, ms)), // 测试代码的时序辅助（防抖断言用）
      // 断言闭包在 worker 侧定义（引用 worker 的 tests 数组——vm 脚本内访问不到 worker 闭包）
      __mashiroAssert9f3a__: (cond, label) => {
        const l = label || "unnamed";
        tests.push({ passed: !!cond, label: l });
        if (!cond) throw new Error("FAIL: " + l);
      },
      // 注入 worker realm 的对象：逃逸最坏只能触达 worker 自身（主进程安全）
      setTimeout, clearTimeout, setInterval, clearInterval,
      Promise, Date, Math, JSON, Array, Object, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet,
      RegExp, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      structuredClone,
    };
    vm.createContext(sandbox);
    // 组装：用户代码 + 测试代码。
    // 遮蔽防护：testCode 定义的 __test__ 与 __assert__ 都在独立 IIFE 作用域内（参数注入），
    // 用户代码无法用同名 const 遮蔽断言使其静默失效（辅助名带独特前缀，冲突会显式报 SyntaxError）
    const script = `(async () => {
      "use strict";
      ${String(userCode || "")}
      await (async (__assert__) => {
        ${String(testCode || "")}
        await __test__(${exportArgs});
      })(__mashiroAssert9f3a__);
    })()`;
    await vm.runInContext(script, sandbox, { timeout: VM_TIMEOUT_MS });
    parentPort.postMessage({
      success: tests.length > 0 && tests.every((t) => t.passed),
      tests,
      logs,
      error: tests.length === 0 ? "测试未执行（可能骨架函数名与测试不匹配）" : null,
      durationMs: 0,
    });
  } catch (e) {
    parentPort.postMessage({
      success: false,
      tests,
      logs,
      error: String(e?.message || e).slice(0, 500),
      durationMs: 0,
    });
  }
})();
