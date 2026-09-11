// node:test 协议通道守卫（2026-09-11 定位的真实 CI 事故）
//
// 事故：CI 上 tests/integration/integration-widget.test.mjs 一条断言都没跑就整文件失败：
//   error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
//   code: 'ERR_TEST_FAILURE'
// 报错前日志里最后一行正是该文件自己打印的 `  ⏭️ 无清单条目，跳过`。
//
// 根因（Node v22.23.2 lib/internal/test_runner/runner.js，本地读过源码确认）：
//   1) 运行器把每个测试文件子进程的 **stdout 当二进制协议通道**：
//        const stdio = ['pipe', 'pipe', 'pipe']; ... child.stdout.on('data', (d) => subtest.parseMessage(d));
//      协议帧是 v8 序列化数据（DefaultSerializer().writeHeader() 开头），**杂散文本和帧共用这条管道**；
//   2) 父进程按帧长解析时用的是**有符号** 32 位左移：
//        const fullMessageSize = (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) + kSerializedSizeHeader;
//        if (this.#rawBufferSize < fullMessageSize) break;   // 负长度永远不 break → 反序列化垃圾
//      于是文本落在帧边界上时：ASCII 会得到巨大正数而"等更多数据"自愈，
//      中文/emoji（字节 >= 0x80）会得到负长度 → 崩溃 → **整个测试文件判失败**（与断言无关）。
//   3) stderr 是**独立**管道且按行安全转发（new Interface({ input: child.stderr })），是安全通道。
//
// 本仓库暴露面实测：CI 单测一轮有 656 行杂散 stdout（其中含中文/emoji），每一次都是抽奖。
// 上游 issue：nodejs/node#64061（含同样的 `#processRawBuffer` 栈与有符号长度分析）。
//
// 对策：测试子进程里把「非协议帧」的 stdout 输出改道到 stderr —— 日志不丢，协议不再被污染。
// 加载方式：package.json 的 test/test:unit/test:integration/coverage 脚本用
//   node --import ./tests/protocol-guard.mjs ...
// 运行器会把 process.execArgv 里除 --test/--watch/--experimental-test-coverage/--test-reporter 之外的
// 参数透传给测试文件子进程，所以子进程自动加载本模块；父进程加载时因不是 test 子进程而不生效
// （父进程的 stdout 要留给测试报告本身）。

import { DefaultSerializer } from "node:v8";

/** 运行器注入给测试文件子进程的标识（runner.js: env.NODE_TEST_CONTEXT = 'child-v8'） */
const TEST_CHILD_CONTEXT = "child-v8";

const headerSerializer = new DefaultSerializer();
headerSerializer.writeHeader();

/** v8 序列化头（当前为 0xFF 0x0F），协议帧一定以它开头 */
export const V8_HEADER = headerSerializer.releaseBuffer();

const INSTALL_MARK = Symbol.for("mianshi.testProtocolGuard");

/**
 * 是否运行在 node:test 的测试文件子进程里（父进程/普通脚本为 false）。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isTestChild(env = process.env) {
  return env.NODE_TEST_CONTEXT === TEST_CHILD_CONTEXT;
}

/**
 * 是否测试运行器的协议帧（v8 序列化数据）。字符串/普通文本一律不是。
 * @param {unknown} chunk
 * @returns {boolean}
 */
export function isProtocolFrame(chunk) {
  if (typeof chunk === "string" || chunk == null) return false;
  const bytes = /** @type {{ length: number, 0?: number, 1?: number }} */ (chunk);
  if (typeof bytes.length !== "number" || bytes.length < V8_HEADER.length) return false;
  return bytes[0] === V8_HEADER[0] && bytes[1] === V8_HEADER[1];
}

/**
 * 把 stdout 上非协议帧的输出改道到 stderr（幂等）。
 * @param {{ stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream }} [opts]
 * @returns {boolean} 本次是否真的安装了守卫
 */
export function install({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const stream = /** @type {any} */ (stdout);
  if (!stream || stream[INSTALL_MARK]) return false;
  const originalWrite = stream.write.bind(stream);
  stream.write = function guardedWrite(chunk, encoding, callback) {
    if (isProtocolFrame(chunk)) return originalWrite(chunk, encoding, callback);
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    stderr.write(text);
    const cb = typeof encoding === "function" ? encoding : callback;
    if (typeof cb === "function") cb();
    return true;
  };
  Object.defineProperty(stream, INSTALL_MARK, { value: true, enumerable: false, configurable: false });
  return true;
}

/** 子进程内自动生效；父进程内为 false（不动测试报告自己的 stdout） */
export const installed = isTestChild() ? install() : false;
