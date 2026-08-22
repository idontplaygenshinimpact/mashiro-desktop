// 判题执行器（worker 线程承载）：不可信用户代码在独立线程 + vm 双隔离中执行
// 为什么不用"宿主进程内 vm 直接跑"：
//   vm 不是安全边界——把宿主 realm 的函数对象（setTimeout/Promise/Date 等）注入 context 后，
//   原型链可达宿主 Function 构造器，任意用户代码可获宿主进程权限
//   （实测：Promise.constructor("return process.version")() 在注入式沙箱内返回宿主版本号）。
// 安全模型：
//   1. worker 是独立 JS 环境——无用户数据、无宿主句柄，逃逸最坏只能危害 worker 自身
//   2. 超时由主线程 worker.terminate() 真正终止（vm 的 async 挂起/定时器无法被 Promise.race 取消）
//   3. resourceLimits 限制内存/栈（防无限递归/大对象撑爆）
//   4. 主线程只传可序列化代码串，不传任何函数/句柄
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "sandbox-worker.mjs");

/**
 * 在隔离 worker 中执行判题脚本
 * @param {{userCode: string, testCode: string, skeleton: string, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, success: boolean, tests: Array<{passed: boolean, label: string}>, logs: string[], error: string|null, durationMs: number}>}
 */
export function runInSandbox({ userCode, testCode, skeleton, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 收尾回收 worker（幂等；超时分支已 terminate）
      worker.terminate().catch(() => {});
      resolve(payload);
    };
    let worker;
    try {
      worker = new Worker(WORKER_FILE, {
        workerData: {
          userCode: String(userCode || ""),
          testCode: String(testCode || ""),
          skeleton: String(skeleton || ""),
        },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      });
    } catch (e) {
      resolve({ ok: false, success: false, tests: [], logs: [], error: `执行器启动失败: ${String(e?.message || e).slice(0, 150)}`, durationMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      // 真正终止：async 挂起/沙箱定时器随 worker 一起回收（vm 方案做不到）
      worker.terminate().catch(() => {});
      done({ ok: false, success: false, tests: [], logs: [], error: `执行超时（${timeoutMs / 1000} 秒），已强制终止——检查是否有死循环/无限递归`, durationMs: timeoutMs });
    }, timeoutMs);
    worker.on("message", (msg) => done({ ok: true, ...msg, durationMs: Number(msg?.durationMs) || 0 }));
    worker.on("error", (err) => done({ ok: false, success: false, tests: [], logs: [], error: `执行器异常: ${String(err?.message || err).slice(0, 200)}`, durationMs: 0 }));
    worker.on("exit", (code) => {
      if (!settled) done({ ok: false, success: false, tests: [], logs: [], error: `执行器意外退出(${code})`, durationMs: 0 });
    });
  });
}
