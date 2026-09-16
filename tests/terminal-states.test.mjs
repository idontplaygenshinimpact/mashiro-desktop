// 终态补齐回归护栏（闭环清查第五批③）：
// ① schedule_events 只有写与读，没有删除入口——解析错的/已取消的邀约永远提醒、"时间待定"的永远显示
// ② job_posts 只有 new/ready/ready_bishi/done，没有终态——自动搜集进来的不感兴趣岗位无法从列表清掉
//    （生产库 233 条全 status='new'）；归档还必须避免"下次搜集又加回来"
// ③ scheduled_jobs 持久化调度层完全不可达：调度器每分钟 tick，种子任务却恒 enabled:false，
//    没有任何路由/UI 能列出或启用它们
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("terminal-states");
mockLLM();

const { db } = await import("../lib/db.mjs");
const mailApi = await import("../lib/mail.ts");
const jobsApi = await import("../lib/jobs.ts");
const { getRecommendedJobs } = await import("../lib/job-match.ts");
const { registerCoreRoutes } = await import("../lib/routes/core.mjs");

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
function mockReq(body) {
  const listeners = {};
  return {
    method: "POST", url: "/", headers: {}, destroyed: false,
    on(ev, fn) {
      listeners[ev] = fn;
      // 注册 end 监听后再回放 body（readBody 无论何时挂监听都不丢数据）
      if (ev === "end") setImmediate(() => { if (listeners.data) listeners.data(Buffer.from(body ?? "{}")); fn(); });
      return this;
    },
    destroy() {},
  };
}
async function hit(router, pathname, body, method = "POST") {
  const entry = router.resolve(pathname, method);
  assert.ok(entry, `${pathname} 应已注册`);
  const res = mockRes();
  await entry.fn(mockReq(body), res, new URL(pathname, "http://x"));
  for (let i = 0; i < 100 && !res.writableEnded; i++) await new Promise((r) => setTimeout(r, 10));
  let json = {};
  try { json = JSON.parse(res.chunks.join("")); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

// ---------- ① 日程删除终态 ----------
function seedEvent(company, interviewAt) {
  db.prepare("INSERT INTO schedule_events (company, role, interview_at, form, location, link, email_id, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(company, "前端", interviewAt, "视频面", "", "", `mail-${company}`, Date.now());
  return Number(db.prepare("SELECT id FROM schedule_events WHERE company=?").get(company).id);
}

test("日程删除：未来邀约可删（删后不再提醒、不再出现在未来日程）", async () => {
  const router = createRouter();
  registerCoreRoutes(router, {
    runtime: {
      scheduledJobsList: () => [], scheduledJobsToggle: () => null, scheduledJobsRun: async () => ({ ok: false }),
    },
  });
  const soon = Date.now() + 2 * 3600 * 1000;
  const id = seedEvent("某公司A", soon);
  assert.equal(mailApi.getSchedule().some((e) => e.id === id), true, "删除前应在未来日程里");
  assert.equal(mailApi.getUpcomingEvents({ withinDays: 3 }).some((e) => e.id === id), true, "删除前应进入提醒窗口");

  const r = await hit(router, "/api/schedule/delete", JSON.stringify({ id }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.equal(mailApi.getSchedule().some((e) => e.id === id), false, "删除后不应再出现在未来日程");
  assert.equal(mailApi.getUpcomingEvents({ withinDays: 3 }).some((e) => e.id === id), false, "删除后不应再提醒");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schedule_events WHERE id=?").get(id).n, 0, "行应真删掉");
});

test("日程删除：时间待定（interview_at 为空）的邀约同样可删——它此前永远显示且无任何办法清除", async () => {
  const router = createRouter();
  registerCoreRoutes(router, { runtime: {} });
  db.prepare("INSERT INTO schedule_events (company, role, interview_at, created_at) VALUES (?,?,NULL,?)").run("时间待定公司", "前端", Date.now());
  const id = Number(db.prepare("SELECT id FROM schedule_events WHERE company=?").get("时间待定公司").id);
  assert.equal(mailApi.getSchedule().some((e) => e.id === id), true, "空时间邀约会在未来日程里常驻");
  const r = await hit(router, "/api/schedule/delete", JSON.stringify({ id }));
  assert.equal(r.json.ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM schedule_events WHERE id=?").get(id).n, 0);
});

test("日程删除如实上报：不存在 → 404、缺 id → 400（不恒报成功）", async () => {
  const router = createRouter();
  registerCoreRoutes(router, { runtime: {} });
  const bad = await hit(router, "/api/schedule/delete", JSON.stringify({ id: 999999 }));
  assert.equal(bad.status, 404, JSON.stringify(bad.json));
  assert.equal(bad.json.ok, false);
  assert.match(String(bad.json.error), /不存在/);
  const missing = await hit(router, "/api/schedule/delete", "{}");
  assert.equal(missing.status, 400);
  assert.equal(missing.json.ok, false);
});

// ---------- ② 岗位归档终态 ----------
function seedJob(id, company, title) {
  db.prepare(`INSERT INTO job_posts (id, company, title, job_type, direction, apply_url, status, summary, found_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, company, title, "校招", "frontend", `https://x/${id}`, "new", "React 前端", Date.now(), Date.now());
}

test("岗位归档：archived 是合法终态，归档后不再出现在推荐里、且不记投递时间", () => {
  seedJob("job-1", "某公司B", "前端实习生");
  const before = getRecommendedJobs(50).some((j) => j.id === "job-1");
  assert.equal(before, true, "归档前应可能被推荐（status=new）");
  const r = jobsApi.setJobStatus("job-1", "archived");
  assert.equal(r.ok, true, `归档应成功：${JSON.stringify(r)}`);
  assert.equal(getRecommendedJobs(50).some((j) => j.id === "job-1"), false, "归档后不得再被推荐");
  const row = db.prepare("SELECT status, applied_at FROM job_posts WHERE id='job-1'").get();
  assert.equal(row.status, "archived");
  assert.equal(row.applied_at ?? null, null, "归档不是投递：不得补记 applied_at（否则统计冒出幽灵投递）");
  // 软删除而非真删：行还在，避免下次搜集又把同一岗位加回来
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM job_posts WHERE id='job-1'").get().n), 1, "归档是软删除，行必须保留（入库去重依赖它）");
  // 恢复闭环
  assert.equal(jobsApi.setJobStatus("job-1", "new").ok, true);
  assert.equal(db.prepare("SELECT status FROM job_posts WHERE id='job-1'").get().status, "new", "可恢复为未处理");
  assert.equal(jobsApi.setJobStatus("job-1", "nonsense").ok, false, "非法状态仍应被拒");
});

test("岗位归档：统计里单列 archived（否则面板看不到自己归档了多少）", () => {
  seedJob("job-2", "某公司C", "前端开发");
  jobsApi.setJobStatus("job-2", "archived");
  const stats = jobsApi.getJobStats();
  assert.equal(stats.byStatus.archived >= 1, true, `byStatus 应含 archived：${JSON.stringify(stats.byStatus)}`);
});

test("岗位列表：默认（不传 status）排除已归档——否则归档在主列表里等于没生效", () => {
  seedJob("job-3", "某公司D", "前端实习");
  assert.equal(jobsApi.getJobs().some((j) => j.id === "job-3"), true, "未归档时应在默认列表");
  jobsApi.setJobStatus("job-3", "archived");
  assert.equal(jobsApi.getJobs().some((j) => j.id === "job-3"), false, "已归档不应出现在默认列表");
  assert.equal(jobsApi.getJobs({ status: "archived" }).some((j) => j.id === "job-3"), true, "显式选「已归档」时应能查到（可恢复）");
  assert.equal(jobsApi.getJobs({ direction: "frontend" }).some((j) => j.id === "job-3"), false, "带其它筛选时也默认排除归档");
});

// ---------- ③ scheduled_jobs 可达 ----------
const fakeSchedulerRuntime = {
  scheduledJobsList: () => ([{ id: "j1", name: "自动巡检", job_type: "patrol", schedule_spec: "interval:30", enabled: false, next_run_at: null, consecutive_failures: 0, config: {} }]),
  scheduledJobsToggle: (id, enabled) => (id === "j1" ? { id, enabled: !!enabled, next_run_at: enabled ? Date.now() + 1800000 : null } : null),
  scheduledJobsRun: async (id) => (id === "j1" ? { id, ok: true } : { id, ok: false, error: `任务不存在: ${id}` }),
};

test("GET /api/scheduled-jobs：列出种子任务（此前整层调度不可达）", async () => {
  const router = createRouter();
  registerCoreRoutes(router, { runtime: fakeSchedulerRuntime });
  const r = await hit(router, "/api/scheduled-jobs", undefined, "GET");
  assert.equal(r.json.ok, true);
  assert.equal(r.json.jobs.length, 1);
  assert.equal(r.json.jobs[0].job_type, "patrol");
  // 未注入时给空列表而不是崩/假数据
  const bare = createRouter();
  registerCoreRoutes(bare, {});
  const b = await hit(bare, "/api/scheduled-jobs", undefined, "GET");
  assert.deepEqual(b.json.jobs, []);
});

test("POST /api/scheduled-jobs/toggle：启用排入下次运行；任务不存在 → 404", async () => {
  const router = createRouter();
  registerCoreRoutes(router, { runtime: fakeSchedulerRuntime });
  const on = await hit(router, "/api/scheduled-jobs/toggle", JSON.stringify({ id: "j1", enabled: true }));
  assert.equal(on.json.ok, true);
  assert.equal(on.json.job.enabled, true);
  assert.equal(Number(on.json.job.next_run_at) > Date.now(), true, "启用后必须排入下次运行（否则等于没启用）");
  const bad = await hit(router, "/api/scheduled-jobs/toggle", JSON.stringify({ id: "nope", enabled: true }));
  assert.equal(bad.status, 404, JSON.stringify(bad.json));
  assert.equal(bad.json.ok, false);
  const missing = await hit(router, "/api/scheduled-jobs/toggle", "{}");
  assert.equal(missing.status, 400);
});

test("POST /api/scheduled-jobs/run：立即运行一次；失败/无执行器如实上报（不报成功）", async () => {
  const router = createRouter();
  registerCoreRoutes(router, { runtime: fakeSchedulerRuntime });
  const ok = await hit(router, "/api/scheduled-jobs/run", JSON.stringify({ id: "j1" }));
  assert.equal(ok.json.ok, true);
  assert.equal(ok.status, 200);
  const bad = await hit(router, "/api/scheduled-jobs/run", JSON.stringify({ id: "nope" }));
  assert.equal(bad.json.ok, false);
  assert.equal(bad.status, 500);
  // 无执行器（skipped:no-executor）也算"没干活"，不得报成功
  const noExec = createRouter();
  registerCoreRoutes(noExec, { runtime: { ...fakeSchedulerRuntime, scheduledJobsRun: async (id) => ({ id, ok: false, skipped: "no-executor" }) } });
  const r = await hit(noExec, "/api/scheduled-jobs/run", JSON.stringify({ id: "j1" }));
  assert.equal(r.json.ok, false, "无执行器必须如实报失败");
  assert.match(String(r.json.error), /no-executor/);
});

test("三态 UI 与 IPC 齐备：日程删除、岗位归档/恢复、定时任务启停", async () => {
  const native = await readFile(new URL("../desktop/renderer/panel-rest.js", import.meta.url), "utf8");
  assert.match(native, /api\/schedule\/delete/, "原生日程 UI 必须调用删除路由");
  assert.match(native, /sched-del/, "原生日程每条要有删除按钮");
  const jobsJs = await readFile(new URL("../desktop/renderer/panel-jobs.js", import.meta.url), "utf8");
  assert.match(jobsJs, /data-status="archived"/, "原生岗位列表要有归档按钮（archived 终态）");
  assert.match(jobsJs, /archived: "🗄 已归档"/, "原生要有归档标签");
  const html = await readFile(new URL("../desktop/renderer/panel.html", import.meta.url), "utf8");
  assert.match(html, /data-status="archived"/, "原生筛选器要有「已归档」");
  assert.match(html, /sched-jobs-list/, "设置区要有定时任务列表容器");
  const chatJs = await readFile(new URL("../desktop/renderer/panel-chat.js", import.meta.url), "utf8");
  assert.match(chatJs, /async function loadScheduledJobs/, "设置区要有定时任务渲染函数");
  assert.match(chatJs, /scheduledJobsToggle/, "定时任务要能启停");
  assert.match(chatJs, /scheduledJobsRun/, "定时任务要能立即运行一次");
  const react = await readFile(new URL("../desktop/renderer/panel-react/src/tabs/Jobs.jsx", import.meta.url), "utf8");
  assert.match(react, /archived/, "React 版要有归档状态与入口");
  assert.match(react, /archiveJob/, "React 版归档要有二次确认封装");
  assert.match(react, /job\.status !== "archived"/, "归档行不得再给「学考点/按岗面试」（后端按 id 查岗位已排除归档 → 点了必 404）");
  const vue = await readFile(new URL("../desktop/renderer/panel-vue-review/src/tabs/Jobs.vue", import.meta.url), "utf8");
  assert.match(vue, /archived/, "Vue 版要有归档状态与入口");
  assert.match(vue, /archiveJob/, "Vue 版归档要有二次确认封装");
  assert.match(vue, /job\.status !== 'archived'/, "Vue 归档行同样不得再给「学考点/按岗面试」");
  const nativeJobs = jobsJs;
  assert.match(nativeJobs, /job\.status === "archived" \? "" :/, "原生归档行也要收起「学考点/按岗面试」");
  const preload = await readFile(new URL("../desktop/preload.js", import.meta.url), "utf8");
  for (const k of ["scheduledJobs", "scheduledJobsToggle", "scheduledJobsRun"]) {
    assert.match(preload, new RegExp(`${k}:`), `preload 必须暴露 ${k}`);
  }
  const main = await readFile(new URL("../desktop/main.ts", import.meta.url), "utf8");
  assert.match(main, /widget:scheduled-jobs/, "主进程必须有 scheduled-jobs handler");
});
