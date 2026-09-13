// misc 域「通知提醒开关」路由契约测试（TS 升级发现并修复的真实缺陷回归护栏）
// 缺陷：POST /api/settings/reminders 里 `const input = body || {}` —— readBody 给的是**原始字符串**，
// 而 Object.prototype.hasOwnProperty.call(字符串, key) 恒为 false → 两个开关静默不落库，
// 面板显示"✅ 已保存"但 GET 读回旧值（刷新即回滚）。同类缺陷见 /api/output/import（已修）。
// 本测试断言：POST 真正落库 + GET 读回一致 + 坏 JSON 走 400（不静默成功）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("misc-reminders");
mockLLM();

const { registerMiscRoutes } = await import("../plugins/job-hunter/routes/misc.mjs");
const router = createRouter();
registerMiscRoutes(router);

function mockRes() {
  const chunks = [];
  return {
    chunks,
    destroyed: false,
    writableEnded: false,
    status: 0,
    writeHead(code) { this.status = code; return this; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; },
    on() { /* no-op */ },
  };
}

// mock req：readBody 需要 data/end 事件——注册监听后触发 end（带上 body 字符串）
function mockReq(method, url, body = "") {
  const listeners = {};
  return {
    method,
    url,
    headers: {},
    destroyed: false,
    on(ev, fn) {
      listeners[ev] = fn;
      if (ev === "end") setImmediate(() => fn());
      return this;
    },
    emitBody() {
      if (body && listeners.data) listeners.data(Buffer.from(body));
      if (listeners.end) listeners.end();
    },
    destroy() { /* no-op */ },
  };
}

function parse(res) {
  const text = res.chunks.join("");
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function hit(pathname, method, body) {
  const entry = router.resolve(pathname, method);
  assert.ok(entry, `${pathname} ${method} 应已注册`);
  const req = mockReq(method, pathname, body);
  const res = mockRes();
  await entry.fn(req, res, new URL(pathname, "http://127.0.0.1"));
  if (body) req.emitBody();
  for (let i = 0; i < 200 && !res.writableEnded; i++) await new Promise((r) => setTimeout(r, 10));
  return res;
}

test("① GET 默认两个提醒都开（settings 无记录 → 缺省 1）", async () => {
  const res = await hit("/api/settings/reminders", "GET");
  assert.equal(res.status, 200);
  const j = parse(res);
  assert.equal(j.ok, true);
  assert.equal(j.reviewReminder, true);
  assert.equal(j.studyReminder, true);
});

test("② POST reviewReminder=false → 真正落库，GET 读回 false（此前静默不落库）", async () => {
  const post = await hit("/api/settings/reminders", "POST", JSON.stringify({ reviewReminder: false }));
  assert.equal(post.status, 200);
  assert.equal(parse(post).ok, true);
  const get = parse(await hit("/api/settings/reminders", "GET"));
  assert.equal(get.reviewReminder, false, "复习提醒开关必须真的关掉（曾静默失败）");
  assert.equal(get.studyReminder, true, "未提交的字段保留（不互清）");
});

test("③ POST studyReminder=false → 只改学习提醒，复习提醒保持上一步状态", async () => {
  const post = await hit("/api/settings/reminders", "POST", JSON.stringify({ studyReminder: false }));
  assert.equal(post.status, 200);
  const get = parse(await hit("/api/settings/reminders", "GET"));
  assert.equal(get.studyReminder, false, "学习提醒开关必须真的关掉");
  assert.equal(get.reviewReminder, false, "未提交的 reviewReminder 保留上一步的 false");
});

test("④ 坏 JSON → 400 明确报错（不假装 ok:true）", async () => {
  const res = await hit("/api/settings/reminders", "POST", "{oops");
  assert.equal(res.status, 400);
  assert.match(String(parse(res).error || ""), /JSON/);
});
