// 面试历史删除终态回归护栏（闭环清查 ⑦"状态机无终态"补齐）：
// 历史复盘此前"读得到、永远删不掉"（无删除函数/无路由/UI 无入口）——本测试钉死整条闭环：
// ① 写入两条 → 删除一条 → DB 与内存镜像 getInterviewHistory() 都只剩一条（镜像同步是重点，
//    只删 DB 不动 mem.interviewHistory 会让同进程读到"鬼影"旧数据）
// ② 删除不存在的 id → 404 + ok:false（不恒报成功）
// ③ 缺参数 → 缺省契约：withContract 校验失败返 400 VALIDATION_ERROR（非 404；契约写清）
// ④ 三态 UI 源码里都有删除入口（React/Vue 需在改源码后重新构建才生效，见 build 门槛）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("interview-history-delete");
mockLLM();

const { db } = await import("../lib/db.mjs");
const { memory } = await import("../lib/memory.mjs");
const { registerInterviewRoutes } = await import("../plugins/job-hunter/routes/interview.ts");

// mock res（withContract 需要 destroyed/writableEnded/writeHead/write/end）
function mockRes() {
  const chunks = [];
  return {
    chunks, destroyed: false, writableEnded: false, status: 0,
    writeHead(code) { this.status = code; return this; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; },
    on() {},
  };
}
// mock req：注册 end 监听后再回放 body（readBodyJson 无论何时挂 data+end 都不丢）
function mockReq(body) {
  const listeners = {};
  return {
    method: "POST", url: "/", headers: {}, destroyed: false,
    on(ev, fn) {
      listeners[ev] = fn;
      if (ev === "end") setImmediate(() => { if (listeners.data) listeners.data(Buffer.from(body)); fn(); });
      return this;
    },
    destroy() {},
  };
}
async function hit(router, pathname, body) {
  const entry = router.resolve(pathname, "POST");
  assert.ok(entry, `${pathname} 应已注册`);
  const req = mockReq(body);
  const res = mockRes();
  await entry.fn(req, res, new URL(pathname, "http://x"));
  for (let i = 0; i < 200 && !res.writableEnded; i++) await new Promise((r) => setTimeout(r, 10));
  let json = {};
  try { json = JSON.parse(res.chunks.join("")); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

const router = createRouter();
registerInterviewRoutes(router);

/** 按 position 反查保存后自动生成的主键 id（saveInterviewHistory 在内存镜像带 id） */
function idOf(position) {
  const rec = memory.getInterviewHistory().find((h) => h.position === position);
  return rec?.id;
}
function dbRowCount() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM interview_history").get();
  return Number(row?.n) || 0;
}

test("写两条 → 删一条 → DB 与内存镜像都只剩一条（镜像同步闭环）", async () => {
  memory.saveInterviewHistory({ date: "2026-09-01T10:00:00.000Z", position: "前端实习生", role: "技术深挖型", rounds: 5, avg: 80, report: "## 复盘A" });
  memory.saveInterviewHistory({ date: "2026-09-02T10:00:00.000Z", position: "算法工程师", role: "温和引导型", rounds: 4, avg: 75, report: "## 复盘B" });
  const before = dbRowCount();
  assert.ok(before >= 2, `应至少 2 条（实得 ${before}）`);
  const idA = idOf("前端实习生");
  assert.ok(idA, "第一条历史应带回主键 id（getInterviewHistory 需带 id 供删除）");

  const r = await hit(router, "/api/interview/history/delete", JSON.stringify({ id: idA }));
  assert.equal(r.status, 200, `删除成功应 200，实得 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(r.json.ok, true);

  // DB 实删
  const dbRow = db.prepare("SELECT COUNT(*) AS n FROM interview_history WHERE id = ?").get(idA);
  assert.equal(Number(dbRow?.n), 0, "DB 中该 id 应已删除");
  // 内存镜像也必须同步删——这是本任务最容易踩的闭环断点（只删 DB 会残留"鬼影"）
  assert.equal(memory.getInterviewHistory().some((h) => h.position === "前端实习生"), false, "内存镜像应同步删除该条");
  assert.ok(memory.getInterviewHistory().some((h) => h.position === "算法工程师"), "未被删除的条目标保留");
  // 总数从 before 减一且 <= before-1（镜像只留 20，若超过 20 会再截断，用"减一"宽松判定）
  assert.equal(dbRowCount(), before - 1, "DB 总数应恰减一条");
  assert.equal(memory.getInterviewHistory().length, before - 1, "内存镜像总数应恰减一条");
});

test("删除不存在的 id → 404 + ok:false（不恒报成功）", async () => {
  const r = await hit(router, "/api/interview/history/delete", JSON.stringify({ id: "iv_does_not_exist_000" }));
  assert.equal(r.status, 404, `不存在应 404，实得 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(r.json.ok, false);
  assert.ok(r.json.error, "应带错误原因");
});

test("缺参数（空 body / 无 id）→ 缺省契约 400 VALIDATION_ERROR", async () => {
  // 契约：id 缺失由 withContract 的 input 校验拦截，返 400 + VALIDATION_ERROR（与"目标不存在"的 404 区分）
  const r = await hit(router, "/api/interview/history/delete", JSON.stringify({}));
  assert.equal(r.status, 400, `缺参数应 400，实得 ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(r.json.error, "VALIDATION_ERROR");
  assert.ok(r.json.ok === undefined || r.json.ok === false);
});

test("三态 UI 源码里都有历史复盘删除入口（共用同一 HTTP 路由）", async () => {
  const p = (f) => new URL("../" + f, import.meta.url);
  // 原生：历史复盘回看区（panel-study.js）+ 对话/自检区（panel-chat.js）
  const study = await readFile(p("desktop/renderer/panel-study.js"), "utf8");
  assert.match(study, /\/api\/interview\/history\/delete/, "panel-study.js 应调用删除路由");
  assert.match(study, /iv-hist-del/, "panel-study.js 每条历史旁应有删除按钮");
  assert.match(study, /confirm\(/, "panel-study.js 删除前应有 confirm 二次确认");
  const chat = await readFile(p("desktop/renderer/panel-chat.js"), "utf8");
  assert.match(chat, /\/api\/interview\/history\/delete/, "panel-chat.js 应调用删除路由");
  assert.match(chat, /iv-hist-del/, "panel-chat.js 每条历史旁应有删除按钮");
  // React：面试面板在 panel.jsx（非 tabs/）
  const react = await readFile(p("desktop/renderer/panel-react/src/panel.jsx"), "utf8");
  assert.match(react, /\/api\/interview\/history\/delete/, "React 版应调用删除路由");
  assert.match(react, /onDelete/, "React 版应把删除入口接到历史列表");
  assert.match(react, /confirm/, "React 版删除前应有 confirm 二次确认");
  // Vue：状态机在 useInterview.js、模板在 tabs/Interview.vue
  const vueUi = await readFile(p("desktop/renderer/panel-vue-review/src/tabs/Interview.vue"), "utf8");
  assert.match(vueUi, /delHistory/, "Vue 版历史列表应绑定删除入口");
  const vueState = await readFile(p("desktop/renderer/panel-vue-review/src/useInterview.js"), "utf8");
  assert.match(vueState, /\/api\/interview\/history\/delete/, "Vue 版应调用删除路由");
  assert.match(vueState, /confirm/, "Vue 版删除前应有 confirm 二次确认");
});
