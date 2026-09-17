// 判题执行 worker：接收 {userCode, testCode, skeleton}，在 vm 沙箱（worker 线程内）执行并回报结果
// 本文件只在 worker 线程运行——即使 vm 逃逸，触达的也是本 worker 的进程对象（无用户数据、可被 terminate 回收）
// 全量 TS 升级工单阶段 3：lib/sandbox-worker.mjs → .ts（worker 入口被 lib/sandbox-runner.ts 以 path 引用 →
//   路径同步改；Electron/Node 内置类型擦除已验证可加载 .ts worker）
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

// ---------- 逃逸防护（tests/sandbox.test.mjs ③b 实测暴露的真漏洞，2026-08 修复） ----------
// worker_threads 与主进程同进程：vm 注入的 Promise/Date 等是 worker realm 对象，原型链可达
// worker 的 Function → 用户代码可 `Promise.constructor("return process")()` 拿到 worker 的 process。
// 实测两个真实危害：
//   1. process.exit() / process.kill() 会终止整个 Node 进程（worker 与主进程同进程）——判题代码可杀桌宠（DoS）
//   2. process.env 是主进程 env 的共享视图——判题代码可读 LLM API key 等敏感配置
// 修复：worker 入口遮蔽危险方法 + 清理敏感 env。worker 自身逻辑不用 exit/env 操作，无副作用。
// 2026-09 再修（安全工单 S2）：process.getBuiltinModule（Node ≥22.3）可绕过 require 限制读宿主
// 文件/执行命令（如 getBuiltinModule('fs').readFileSync）——与 exit/kill 同列表遮蔽；
// _linkedBinding 同理（内部绑定访问）
const DANGEROUS_PROCESS_METHODS = ["exit", "kill", "abort", "disconnect", "binding", "dlopen", "chdir", "getBuiltinModule", "_linkedBinding"];
for (const k of DANGEROUS_PROCESS_METHODS) {
  try { Object.defineProperty(process, k, { value: undefined, configurable: true }); } catch { /* 遮蔽失败不影响（worker 自身不用） */ }
}
const SENSITIVE_ENV_PATTERNS = ["DEEPSEEK_API_KEY", "MIANSHI_", "OPENAI", "ANTHROPIC", "API_KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH"];
for (const k of Object.keys(process.env)) {
  if (SENSITIVE_ENV_PATTERNS.some((p) => k.includes(p))) {
    try { delete process.env[k]; } catch { /* ignore */ }
  }
}

/** 主线程传入的判题数据 */
interface JudgeWorkerData {
  userCode?: string;
  testCode?: string;
  skeleton?: string;
  /** 判题模式：core=LeetCode 核心代码模式（默认：__test__ + __assert__）；acm=标准输入输出（readline/print + 用例比对） */
  mode?: "core" | "acm";
  /** ACM 模式用例（多组输入输出） */
  cases?: Array<{ input?: string; expected?: string }>;
}

/** 单条断言结果（主线程据此判定 success） */
interface AssertResult {
  passed: boolean;
  label: string;
  /** ACM 模式：逐用例 diff（供面板展示；核心代码模式为 undefined） */
  input?: string;
  expected?: string;
  actual?: string;
}

const { userCode, testCode, skeleton, mode = "core", cases = [] } = (workerData || {}) as JudgeWorkerData;
const tests: AssertResult[] = [];
const logs: string[] = [];
const VM_TIMEOUT_MS = 25000; // vm 同步执行上限（主线程 terminate 是最终兜底）

/** 行尾归一化（OJ 标准判题口径）：逐行去尾空白 + 去末尾空行；**不**忽略行内空白差异 */
function normalizeOutput(s: unknown): string {
  const lines = String(s ?? "").replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function buildExportArgs(skeleton: unknown): string {
  const names: string[] = [];
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*function\s+(\w+)/g)) names.push(m[1]);
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*class\s+(\w+)/g)) names.push(m[1]);
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*var\s+(\w+)\s*=\s*(?:async\s+)?function/g)) names.push(m[1]);
  return [...new Set(names)].join(", ");
}

(async () => {
  try {
    const exportArgs = buildExportArgs(skeleton);
    const sandbox: Record<string, unknown> = {
      console: {
        log: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
        error: (...a: unknown[]) => logs.push("[error] " + a.map(String).join(" ")),
        warn: (...a: unknown[]) => logs.push("[warn] " + a.map(String).join(" ")),
      },
      __sleep__: (ms: number) => new Promise((r) => setTimeout(r, ms)), // 测试代码的时序辅助（防抖断言用）
      // 断言闭包在 worker 侧定义（引用 worker 的 tests 数组——vm 脚本内访问不到 worker 闭包）
      // 2026-09 再修（安全工单 S3）：断言可被用户代码伪造（sandbox 全局属性可写——
      // userCode 里 `__mashiroAssert9f3a__ = (c) => {}` 覆盖 → 断言静默失效）。
      // 改为**不可写不可配置属性**（writable:false + configurable:false）——用户代码覆盖
      // 在严格模式下抛 TypeError（"use strict" 已启用）——断言不可伪造
      // （defineProperty 在 vm 内对 configurable:false 的属性同样抛错——双保险）
      setTimeout, clearTimeout, setInterval, clearInterval,
      Promise, Date, Math, JSON, Array, Object, String, Number, Boolean, Symbol, Map, Set, WeakMap, WeakSet,
      RegExp, Error, TypeError, RangeError, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      structuredClone,
    };
    Object.defineProperty(sandbox, "__mashiroAssert9f3a__", {
      value: (cond: unknown, label: unknown) => {
        const l = String(label || "unnamed");
        tests.push({ passed: Boolean(cond), label: l });
        if (!cond) throw new Error("FAIL: " + l);
      },
      writable: false,
      configurable: false,
      enumerable: false,
    });
    vm.createContext(sandbox);

    // ---------- ACM 模式（标准输入输出）----------
    // 秋招笔试（牛客/赛码等）绝大多数是 ACM 模式：自己读输入、自己输出、多组用例。本沙箱原先只有
    // LeetCode 核心代码模式（骨架函数 + __test__ 断言），练不到"读入解析/输出格式"这层真实考点。
    // 约定与国内 OJ 的 JS 环境一致：`readline()` 逐行取输入（耗尽返回 null）、`print(...)` 输出。
    if (mode === "acm") {
      if (!Array.isArray(cases) || cases.length === 0) {
        parentPort!.postMessage({ success: false, tests: [], logs, error: "ACM 模式缺少测试用例（io_cases 为空）", durationMs: 0 });
        return;
      }
      // 输入队列 / 输出缓冲：闭包在 worker 侧，vm 脚本通过注入的 readline/print 读写（逐用例重置）
      let inputLines: string[] = [];
      let inputIdx = 0;
      const stdout: string[] = [];
      sandbox.readline = () => (inputIdx < inputLines.length ? inputLines[inputIdx++] : null);
      sandbox.print = (...a: unknown[]) => { stdout.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
      // console.log 在 ACM 模式下也算输出（学员常直接 console.log 调试/输出，判题按 OJ 口径收集）
      sandbox.console = { log: (...a: unknown[]) => stdout.push(a.map(String).join(" ")), error: (...a: unknown[]) => logs.push("[error] " + a.map(String).join(" ")), warn: (...a: unknown[]) => logs.push("[warn] " + a.map(String).join(" ")) };
      vm.createContext(sandbox); // 重新创建上下文：把 readline/print 纳入沙箱全局
      const acmScript = `(async () => {
        "use strict";
        ${String(userCode || "")}
      })()`;
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i] || {};
        inputLines = String(c.input ?? "").replace(/\r\n/g, "\n").split("\n");
        inputIdx = 0;
        stdout.length = 0;
        try {
          await vm.runInContext(acmScript, sandbox, { timeout: VM_TIMEOUT_MS });
        } catch (e) {
          const err = e as Error;
          tests.push({
            passed: false, label: `用例 ${i + 1} · 运行报错`,
            input: String(c.input ?? ""), expected: normalizeOutput(c.expected),
            actual: `⚠️ ${String(err?.message || err).slice(0, 200)}`,
          });
          continue;
        }
        const actual = normalizeOutput(stdout.join("\n"));
        const expected = normalizeOutput(c.expected);
        tests.push({ passed: actual === expected, label: `用例 ${i + 1}`, input: String(c.input ?? ""), expected, actual });
      }
      parentPort!.postMessage({
        success: tests.length > 0 && tests.every((t) => t.passed),
        tests, logs, error: null, durationMs: 0,
      });
      return;
    }

    // ---------- 核心代码模式（默认）----------
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
    parentPort!.postMessage({
      success: tests.length > 0 && tests.every((t) => t.passed),
      tests,
      logs,
      error: tests.length === 0 ? "测试未执行（可能骨架函数名与测试不匹配）" : null,
      durationMs: 0,
    });
  } catch (e) {
    const err = e as Error;
    parentPort!.postMessage({
      success: false,
      tests,
      logs,
      error: String(err?.message || err).slice(0, 500),
      durationMs: 0,
    });
  }
})();
