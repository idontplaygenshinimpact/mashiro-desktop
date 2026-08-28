// 判题沙箱测试（第二轮任务 ③：最危险组件补盲区）
// lib/sandbox-runner.mjs（worker 线程）+ lib/sandbox-worker.mjs（vm 双隔离）执行不可信用户代码——
// 此前 tests/ 零引用。本测试验证隔离有效（正例 + 逃逸反例 + 超时 + 资源限制），不改沙箱实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInSandbox } from "../lib/sandbox-runner.mjs";

const TEST_TMPL = `async function __test__({EXPORT}) {
  {BODY}
}`;

// 骨架：单一导出函数（与 ai-career 判题格式一致）
function code({ userCode, body, skeleton = "function solution(x) { return x; }" }) {
  return {
    userCode,
    testCode: TEST_TMPL.replace("{EXPORT}", "solution").replace("{BODY}", body),
    skeleton,
  };
}

test("① 正例：正常实现 → PASS（ok:true, success:true）", async () => {
  const r = await runInSandbox(code({
    userCode: "function solution(x) { return x * 2; }",
    body: `__mashiroAssert9f3a__(solution(2) === 4, "双倍");\n__mashiroAssert9f3a__(solution(0) === 0, "零");`,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.success, true);
  assert.equal(r.tests.length, 2);
  assert.ok(r.tests.every((t) => t.passed), "全部断言通过");
  assert.equal(r.error, null);
});

test("② 正例：断言失败 → ok:false + 失败信息（不崩溃）", async () => {
  const r = await runInSandbox(code({
    userCode: "function solution(x) { return x + 1; }", // 错误实现
    body: `__mashiroAssert9f3a__(solution(2) === 5, "应为 5");`,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.success, false);
  assert.ok(r.tests.some((t) => !t.passed), "失败断言被记录");
  assert.ok(r.error.includes("FAIL"), "错误信息带 FAIL 标记");
});

test("③ 逃逸反例：process/require 直接访问 → ReferenceError（context 未注入句柄）", async () => {
  // vm context 未注入 process/require——直接访问必须失败（拿不到宿主句柄）
  const r = await runInSandbox(code({
    userCode: "function solution() { return process.version; }",
    body: `__mashiroAssert9f3a__(typeof process !== "undefined", "不该拿到 process");`,
  }));
  assert.equal(r.success, false);
  assert.ok(/process|not defined/i.test(r.error || ""), `报错（实际: ${r.error}）`);
  const r2 = await runInSandbox(code({
    userCode: "function solution() { return require('fs'); }",
    body: `__mashiroAssert9f3a__(typeof require !== "undefined", "不该拿到 require");`,
  }));
  assert.equal(r2.success, false, "require 逃逸被拒");
});

test("③b 逃逸反例：Promise.constructor 链触达 worker 但拿不到危险句柄（2026-08 实测暴露的真漏洞已堵）", async () => {
  // worker_threads 与主进程同进程：注入的 worker realm 对象原型链可达 worker 的 Function，
  // 用户代码可 `Promise.constructor("return process")()` 拿到 worker 的 process。
  // 实测暴露：process.exit 可杀主进程（DoS）、process.env 可读 LLM key（敏感泄露）——
  // sandbox-worker.mjs 入口已遮蔽危险方法 + 清理敏感 env。以下断言验证修复生效：
  // 1) process.exit 已被遮蔽为 undefined
  const rExit = await runInSandbox(code({
    userCode: `function solution() {
      try {
        const p = Promise.constructor("return process")();
        return typeof p.exit;
      } catch (e) { return "ERR:" + e.message; }
    }`,
    body: `__mashiroAssert9f3a__(solution() === "undefined", "exit 被遮蔽");`,
  }));
  assert.equal(rExit.success, true, "逃逸拿不到 process.exit（DoS 已堵）");
  // 2) 敏感 env（LLM key）已从 worker 清理
  const rEnv = await runInSandbox(code({
    userCode: `function solution() {
      try { const env = Promise.constructor("return process.env")(); return env.DEEPSEEK_API_KEY; } catch (e) { return "ERR:" + e.message; }
    }`,
    body: `__mashiroAssert9f3a__(solution() === undefined, "key 不可读");`,
  }));
  assert.equal(rEnv.success, true, "逃逸读不到 LLM key（敏感泄露已堵）");
  // 3) 主进程安然无恙（runInSandbox 正常返回、worker 被回收）
  const rOk = await runInSandbox(code({
    userCode: "function solution() { return 42; }",
    body: `__mashiroAssert9f3a__(solution() === 42, "正常判题不受影响");`,
  }));
  assert.equal(rOk.success, true, "正常判题链路不受逃逸防护影响");
});

test("④ 死循环：while(true) → 超时强制终止（不挂死）", async () => {
  const t0 = Date.now();
  const r = await runInSandbox({
    ...code({
      userCode: "function solution() { while (true) {} }",
      body: `solution(); __mashiroAssert9f3a__(true, "到不了这里");`, // 先调用触发死循环
    }), timeoutMs: 3000,
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("超时"), `超时信息（实际: ${r.error}）`);
  assert.ok(Date.now() - t0 < 15000, "15s 内被掐断（worker.terminate 真正终止）");
});

test("⑤ 异步挂起：new Promise(()=>{}) 永不 resolve → 超时终止", async () => {
  const t0 = Date.now();
  const r = await runInSandbox({
    ...code({
      userCode: "function solution() { return new Promise(() => {}); }",
      body: `await solution(); __mashiroAssert9f3a__(true, "永不执行");`, // await 挂起 Promise
    }), timeoutMs: 3000,
  });
  assert.equal(r.ok, false);
  // pending Promise 不保持 worker 事件循环活跃 → worker 自然退出（或超时 terminate）——都不挂死
  assert.ok(r.error.includes("超时") || r.error.includes("退出"), `终止信息（实际: ${r.error}）`);
  assert.ok(Date.now() - t0 < 15000, "不挂死");
});

test("⑥ 资源限制：无限递归 → 栈限制生效（RangeError 被捕获而非崩溃）", async () => {
  const r = await runInSandbox(code({
    userCode: "function solution() { return (function f() { return f(); })(); }",
    body: `solution(); __mashiroAssert9f3a__(true, "永不执行");`, // 先调用触发无限递归
  }));
  assert.equal(r.success, false);
  // stackSizeMb 2MB 限制生效：Maximum call stack 或堆栈溢出类错误（被 worker catch 返回，不崩溃）
  assert.ok(/call stack|stack|RangeError|heap|allocation/i.test(r.error || ""), `受限错误（实际: ${String(r.error).slice(0, 80)}）`);
  assert.equal(r.ok, true, "worker 正常返回（错误被捕获而非崩溃）");
});

// ⑥b 内存限制：实测（2026-08）resourceLimits 的 maxOldGenerationSizeMb 在 worker 里**非硬上限**
// （1e7=80MB 分配超过 64MB 限制仍成功），且极端分配（5e7=400MB）触发 V8 OOM → **FATAL 杀整个进程**
// （worker 线程的 OOM 是进程级 fatal，Node 平台行为）——沙箱隔离不了 V8 OOM。
// 这是测试暴露的已知 DoS 边界（判题代码可崩桌宠进程）：实际防护靠 timeout + widget 守护自动重启兜底，
// 不写触发 fatal 的测试用例（会杀测试进程本身）。见 sandbox-runner.mjs 注释。

test("⑦ 正例：console 日志收集 + 多断言混合", async () => {
  const r = await runInSandbox(code({
    userCode: "function solution(x) { console.log('输入', x); return x >= 0 ? 'PASS' : 'FAIL'; }",
    body: `__mashiroAssert9f3a__(solution(1) === "PASS", "正数");\n__mashiroAssert9f3a__(solution(-1) === "FAIL", "负数");`,
  }));
  assert.equal(r.success, true);
  assert.ok(r.logs.some((l) => l.includes("输入")), "console 日志被收集");
});