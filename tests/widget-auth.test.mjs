// widget-auth.mjs 单测：token 提取 / 轮询 / 注入判断 / fetch 包装 / 健康探测 URL
// 全 fake（fsImpl / fetchImpl），无网络、无 Electron。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import {
  WIDGET_URL,
  HEALTH_PATH,
  extractToken,
  loadTokenFromFile,
  shouldInjectAuth,
  widgetFetchFactory,
  healthUrl,
} from "../lib/widget-auth.mjs";

// ---------- 常量契约 ----------
test("WIDGET_URL 固定为 127.0.0.1:8899，HEALTH_PATH 为 /api/health", () => {
  assert.equal(WIDGET_URL, "http://127.0.0.1:8899");
  assert.equal(HEALTH_PATH, "/api/health");
});

// ---------- extractToken ----------
test("extractToken: 合法 {token}", () => {
  assert.equal(extractToken('{"token":"tok-abc"}'), "tok-abc");
  assert.equal(extractToken('{"token":"tok-abc","ts":123}'), "tok-abc"); // widget.mjs 实际写 {token, ts}
});

test("extractToken: 合法 {value}", () => {
  assert.equal(extractToken('{"value":"tok-value"}'), "tok-value");
});

test("extractToken: 裸字符串", () => {
  assert.equal(extractToken("raw-token-string"), "raw-token-string"); // 非 JSON 裸字符串
  assert.equal(extractToken('"quoted-token"'), "quoted-token"); // JSON 字符串也是裸字符串
});

test("extractToken: 损坏 JSON → 空字符串", () => {
  assert.equal(extractToken('{"token": "abc"'), ""); // 截断
  assert.equal(extractToken("{broken json"), "");
  assert.equal(extractToken('["unterminated'), "");
});

test("extractToken: 空对象 / 空串 / 非对象 JSON → 空字符串", () => {
  assert.equal(extractToken("{}"), "");
  assert.equal(extractToken(""), "");
  assert.equal(extractToken("   "), "");
  assert.equal(extractToken("42"), ""); // 数字不是 token
  assert.equal(extractToken("null"), "");
});

// ---------- loadTokenFromFile ----------
test("loadTokenFromFile: 文件第 3 次轮询才出现 → 最终返回 token", async () => {
  let calls = 0;
  const fsImpl = {
    readFileSync() {
      calls++;
      if (calls >= 3) return JSON.stringify({ token: "tok-delayed" });
      throw new Error("ENOENT");
    },
  };
  const token = await loadTokenFromFile("/x/token.json", { fsImpl, pollIntervalMs: 5 });
  assert.equal(token, "tok-delayed");
  assert.ok(calls >= 3, `应至少轮询 3 次，实际 ${calls}`);
});

test("loadTokenFromFile: 文件已存在 → 首次读取即返回", async () => {
  let calls = 0;
  const fsImpl = {
    readFileSync() {
      calls++;
      return JSON.stringify({ token: "tok-immediate" });
    },
  };
  const token = await loadTokenFromFile("/x/token.json", { fsImpl, pollIntervalMs: 5 });
  assert.equal(token, "tok-immediate");
  assert.equal(calls, 1);
});

test("loadTokenFromFile: 文件永远不出现 → N 次轮询后仍未解析（不挂起测试）", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  let polls = 0;
  const fsImpl = {
    readFileSync() {
      polls++;
      throw new Error("ENOENT");
    },
  };
  let settled = false;
  loadTokenFromFile("/never/token.json", { fsImpl, pollIntervalMs: 500 }).then(() => {
    settled = true;
  });

  // 推进 10 个轮询周期（初始读取是同步的，已计 1 次）
  for (let i = 0; i < 10; i++) {
    mock.timers.tick(500);
    await Promise.resolve(); // 冲刷微任务，让 for(;;) 继续并重新注册 timer
  }
  assert.equal(settled, false, "10 次轮询后仍不应解析");
  assert.ok(polls >= 10, `应已轮询至少 10 次，实际 ${polls}`);
});

test("loadTokenFromFile: 读到 token 时回调 onLoaded", async () => {
  let loaded = null;
  const fsImpl = { readFileSync: () => JSON.stringify({ token: "tok-cb" }) };
  const token = await loadTokenFromFile("/x/token.json", {
    fsImpl,
    pollIntervalMs: 5,
    onLoaded: (t) => (loaded = t),
  });
  assert.equal(token, "tok-cb");
  assert.equal(loaded, "tok-cb");
});

// ---------- shouldInjectAuth ----------
test("shouldInjectAuth: 空 token → 不注入", () => {
  assert.equal(shouldInjectAuth("http://127.0.0.1:8899/api/x", ""), false);
  assert.equal(shouldInjectAuth("http://127.0.0.1:8899/api/x", null), false);
  assert.equal(shouldInjectAuth("http://127.0.0.1:8899/api/x", undefined), false);
});

test("shouldInjectAuth: token + 127.0.0.1:8899 URL → 注入", () => {
  assert.equal(shouldInjectAuth("http://127.0.0.1:8899/api/widget-data", "tok"), true);
});

test("shouldInjectAuth: token + localhost:8899 URL → 注入", () => {
  assert.equal(shouldInjectAuth("http://localhost:8899/api/widget-data", "tok"), true);
});

test("shouldInjectAuth: 其他端口 / 其他主机 → 不注入", () => {
  assert.equal(shouldInjectAuth("http://127.0.0.1:8890/api/x", "tok"), false);
  assert.equal(shouldInjectAuth("http://127.0.0.1:8898/api/x", "tok"), false);
  assert.equal(shouldInjectAuth("http://example.com:8899/api/x", "tok"), false);
  assert.equal(shouldInjectAuth("http://example.com/api/x", "tok"), false);
});

// ---------- widgetFetchFactory ----------
test("widgetFetchFactory: 有 token → 附 Bearer 头，保留原 headers/body/method", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  const wf = widgetFetchFactory("tok-abc", fetchImpl);
  await wf("http://127.0.0.1:8899/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });

  assert.equal(calls.length, 1);
  const { url, opts } = calls[0];
  assert.equal(url, "http://127.0.0.1:8899/api/chat");
  assert.equal(opts.method, "POST");
  assert.equal(opts.body, '{"message":"hi"}');
  assert.equal(opts.headers["Content-Type"], "application/json"); // 原头保留
  assert.equal(opts.headers["Authorization"], "Bearer tok-abc"); // 注入头
});

test("widgetFetchFactory: 空 token → 不附 Authorization 头", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {};
  };
  const wf = widgetFetchFactory("", fetchImpl);
  await wf("http://127.0.0.1:8899/api/x", { headers: { "X-Custom": "1" } });

  assert.equal(calls.length, 1);
  assert.equal("Authorization" in calls[0].opts.headers, false);
  assert.equal(calls[0].opts.headers["X-Custom"], "1"); // 原头仍保留
});

test("widgetFetchFactory: 不修改调用方传入的 headers 对象", async () => {
  const fetchImpl = async () => ({});
  const wf = widgetFetchFactory("tok", fetchImpl);
  const original = { "Content-Type": "application/json" };
  await wf("http://127.0.0.1:8899/api/x", { headers: original });
  assert.deepEqual(original, { "Content-Type": "application/json" }); // 未被污染
});

// ---------- healthUrl ----------
test("healthUrl: 返回认证豁免端点 http://127.0.0.1:8899/api/health", () => {
  assert.equal(healthUrl(), "http://127.0.0.1:8899/api/health");
});
