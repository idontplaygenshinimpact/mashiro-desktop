// node:test 协议通道守卫的回归测试。
// 背景见 tests/protocol-guard.mjs：CI 上 integration-widget.test.mjs 因为自己往 stdout 打了一行
// 中文日志（"  ⏭️ 无清单条目，跳过"），被运行器当协议帧解析，整文件判失败。

import { test } from "node:test";
import assert from "node:assert/strict";
import { serialize } from "node:v8";

import { V8_HEADER, install, isProtocolFrame, isTestChild, installed } from "./protocol-guard.mjs";

/** @returns {{ chunks: unknown[], write: (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean }} */
function fakeStream() {
  const chunks = [];
  return {
    chunks,
    write(chunk, _encoding, _callback) {
      chunks.push(chunk);
      return true;
    },
  };
}

test("V8_HEADER：与 v8.serialize 产物前缀一致", () => {
  const frame = serialize({ ok: true });
  assert.ok(V8_HEADER.length >= 2, "v8 头至少 2 字节");
  assert.equal(frame[0], V8_HEADER[0]);
  assert.equal(frame[1], V8_HEADER[1]);
});

test("isProtocolFrame：真协议帧 → true", () => {
  assert.equal(isProtocolFrame(serialize({ type: "test:pass", data: { 中文: "值" } })), true);
  assert.equal(isProtocolFrame(new Uint8Array(serialize([1, 2, 3]))), true);
});

test("isProtocolFrame：字符串/文本/空值 → false", () => {
  assert.equal(isProtocolFrame("普通字符串"), false);
  assert.equal(isProtocolFrame(undefined), false);
  assert.equal(isProtocolFrame(null), false);
  assert.equal(isProtocolFrame(""), false);
  assert.equal(isProtocolFrame(Buffer.alloc(0)), false);
  assert.equal(isProtocolFrame(Buffer.from("  ⏭️ 无清单条目，跳过")), false);
});

test("isProtocolFrame：CI 事故那行日志的致命特征（第 3 字节 >= 0x80）", () => {
  const killer = Buffer.from("  ⏭️ 无清单条目，跳过", "utf8");
  assert.equal(isProtocolFrame(killer), false);
  // 父进程按有符号 32 位读第 3~6 字节当帧长：0xE2 开头 → 负数 → 永不 break → 反序列化崩溃
  assert.ok(killer[2] >= 0x80, "emoji/中文首字节 >= 0x80，正是它把可自愈的失步变成致命失败");
});

test("install：文本改道 stderr，协议帧原样放行", () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  assert.equal(install({ stdout, stderr }), true);

  stdout.write("中文日志 ⏭️\n");
  const frame = serialize({ type: "test:pass" });
  stdout.write(frame);

  assert.deepEqual(stdout.chunks, [frame], "stdout 只剩协议帧");
  assert.deepEqual(stderr.chunks, ["中文日志 ⏭️\n"], "文本被改道到 stderr（日志不丢）");
});

test("install：写出 Buffer 文本也改道，且回调被调用", () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  install({ stdout, stderr });
  let called = 0;
  stdout.write(Buffer.from("警告：中文", "utf8"), undefined, () => { called += 1; });
  assert.deepEqual(stderr.chunks, ["警告：中文"]);
  assert.equal(called, 1, "回调必须被调用，否则 Promise 化的写入会挂住");
});

test("install：幂等（重复安装不再包裹，避免嵌套改道）", () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  assert.equal(install({ stdout, stderr }), true);
  assert.equal(install({ stdout, stderr }), false);
  stdout.write("只应改道一次");
  assert.deepEqual(stderr.chunks, ["只应改道一次"]);
});

test("isTestChild：只有运行器注入 child-v8 的子进程才算", () => {
  assert.equal(isTestChild({ NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(isTestChild({}), false);
  assert.equal(isTestChild({ NODE_TEST_CONTEXT: "other" }), false);
});

test("子进程里自动生效（--import 加载本文件）、父进程里不生效", () => {
  // 本测试文件自身就跑在测试子进程里（NODE_TEST_CONTEXT=child-v8）→ 守卫必须已安装；
  // 若没装，说明 --import 没被子进程继承，CI 会重新暴露在这个 bug 下。
  assert.equal(isTestChild(), true);
  assert.equal(installed, true);
});
