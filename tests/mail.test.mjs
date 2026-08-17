// mail.mjs 测试：配置往返 / LLM 邀约识别（成功/失败/垃圾/默认路径）/ 入库去重 / 窗口过滤 / 流水线（DI 假 IMAP）
// 不测真实 IMAP（clientFactory 注入假 client；LLM 注入或 mockLLM）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("mail");
mockLLM();

const mail = await import("../lib/mail.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  db.exec("DELETE FROM schedule_events;");
});
after(() => { cleanupTempDb(dbDir); });

// 未来 hours 小时后的 "YYYY-MM-DD HH:mm" 字符串（测试用稳定时间）
function futureStr(hours) {
  const d = new Date(Date.now() + hours * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 假 IMAP client（clientFactory 注入，避免真实联网）
function fakeImapClient({ emails = [] } = {}) {
  return {
    connect: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    search: async () => emails.map((e) => e.uid),
    fetch: async function* () {
      for (const e of emails) {
        yield {
          uid: e.uid,
          envelope: { from: [{ address: e.from }], subject: e.subject, date: new Date(e.date || Date.now()) },
          source: Buffer.from(e.raw),
        };
      }
    },
    logout: async () => {},
  };
}

// ---------- 配置 ----------
test("getConfig/setConfig 往返 + 默认值 + 空值拒绝", () => {
  assert.deepEqual(mail.getConfig(), { email: "", authCode: "", enabled: false });
  const r = mail.setConfig({ email: " a@qq.com ", authCode: " xyz " });
  assert.equal(r.ok, true);
  assert.equal(r.email, "a@qq.com");
  const cfg = mail.getConfig();
  assert.equal(cfg.email, "a@qq.com");
  assert.equal(cfg.authCode, "xyz");
  assert.equal(cfg.enabled, true);
  // 空值拒绝
  assert.equal(mail.setConfig({ email: "", authCode: "" }).ok, false);
  assert.equal(mail.setConfig({ email: "a@qq.com", authCode: "" }).ok, false);
  assert.equal(mail.setConfig({ email: "", authCode: "x" }).ok, false);
});

// ---------- LLM 邀约识别 ----------
test("extractInterviewEvents：LLM 输出 JSON 数组 → 解析为结构化事件", async () => {
  const emails = [
    { id: "1", from: "hr@tencent.com", subject: "面试邀约", date: "", text: "腾讯 前端 面试" },
    { id: "2", from: "noreply@x.com", subject: "简历投递成功", date: "", text: "您的简历已投递" },
  ];
  const llm = async () => JSON.stringify([
    { company: "腾讯", role: "前端", interviewAt: "2026-08-20 14:00", form: "线上", location: "", link: "https://meet.tencent.com/x", emailId: "1" },
  ]);
  const events = await mail.extractInterviewEvents(emails, { llm });
  assert.equal(events.length, 1);
  assert.equal(events[0].company, "腾讯");
  assert.equal(events[0].role, "前端");
  assert.equal(events[0].interviewAt, "2026-08-20 14:00");
  assert.equal(events[0].form, "线上");
  assert.equal(events[0].link, "https://meet.tencent.com/x");
  assert.equal(events[0].emailId, "1");
});

test("extractInterviewEvents：LLM 输出含 events 包装对象 → 也能解析", async () => {
  const llm = async () => JSON.stringify({ events: [{ company: "字节", role: "", interviewAt: "", form: "", location: "", link: "", emailId: "9" }] });
  const events = await mail.extractInterviewEvents([{ id: "9", from: "hr", subject: "s", date: "", text: "t" }], { llm });
  assert.equal(events.length, 1);
  assert.equal(events[0].company, "字节");
});

test("extractInterviewEvents：无 emailId/公司 的条目被过滤", async () => {
  const llm = async () => JSON.stringify([
    { company: "腾讯", role: "前端", interviewAt: "", emailId: "" },       // 无 emailId → 过滤
    { company: "", role: "前端", interviewAt: "", emailId: "5" },          // 无公司 → 过滤
    { company: "阿里", role: "后端", interviewAt: "", emailId: "6" },      // 合法
  ]);
  const events = await mail.extractInterviewEvents([{ id: "5", from: "a", subject: "s", date: "", text: "t" }], { llm });
  assert.equal(events.length, 1);
  assert.equal(events[0].emailId, "6");
});

test("extractInterviewEvents：LLM 抛错 → 返回 []", async () => {
  const llm = async () => { throw new Error("network down"); };
  const events = await mail.extractInterviewEvents([{ id: "1", from: "a", subject: "s", date: "", text: "t" }], { llm });
  assert.deepEqual(events, []);
});

test("extractInterviewEvents：LLM 返回垃圾（非 JSON）→ 返回 []", async () => {
  const llm = async () => "这不是 JSON";
  const events = await mail.extractInterviewEvents([{ id: "1", from: "a", subject: "s", date: "", text: "t" }], { llm });
  assert.deepEqual(events, []);
});

test("extractInterviewEvents：空邮件列表 → 返回 []", async () => {
  assert.deepEqual(await mail.extractInterviewEvents([], { llm: async () => "[]" }), []);
});

test("extractInterviewEvents：默认 llm 走 ai.mjs chat（mockLLM 成功路径）", async () => {
  setLlmResponses(JSON.stringify([{ company: "字节", role: "前端", interviewAt: futureStr(24), form: "线上", location: "", link: "", emailId: "9" }]));
  const events = await mail.extractInterviewEvents([{ id: "9", from: "hr", subject: "面试", date: "", text: "字节面试" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].company, "字节");
});

// ---------- 入库去重 ----------
test("saveEvents：入库 + email_id 去重", () => {
  const events = [
    { company: "腾讯", role: "前端", interviewAt: futureStr(20), form: "线上", emailId: "e1" },
    { company: "阿里", role: "后端", interviewAt: futureStr(40), form: "线下", emailId: "e2" },
  ];
  const r1 = mail.saveEvents(events);
  assert.equal(r1.added, 2);
  assert.equal(r1.skipped, 0);
  // 相同 email_id 再存 → 全部去重
  const r2 = mail.saveEvents(events);
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 2);
  // 一条新 + 一条重复
  const r3 = mail.saveEvents([
    { company: "百度", role: "算法", interviewAt: futureStr(60), form: "线上", emailId: "e3" },
    events[0],
  ]);
  assert.equal(r3.added, 1);
  assert.equal(r3.skipped, 1);
});

test("saveEvents：interviewAt 缺失/无法解析 → 以「时间待定」入库（interview_at=NULL，不丢邀约）", () => {
  const r = mail.saveEvents([
    { company: "腾讯", role: "前端", interviewAt: "", emailId: "e1" },
    { company: "阿里", role: "后端", interviewAt: "not-a-date", emailId: "e2" },
    { company: "", role: "测试", interviewAt: futureStr(1), emailId: "e3" }, // 无公司 → 仍跳过
  ]);
  assert.equal(r.added, 2, "无时间邀约也入库（待定），不再静默丢弃");
  assert.equal(r.skipped, 1, "无公司名仍跳过");
  const rows = db.prepare("SELECT company, interview_at FROM schedule_events WHERE email_id IN ('e1','e2') ORDER BY email_id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].interview_at, null, "e1 时间待定（NULL）");
  assert.equal(rows[1].interview_at, null, "e2 无法解析时间 → NULL");
});

// ---------- 查询 / 窗口过滤 ----------
test("getUpcomingEvents：withinDays 窗口过滤 + 升序排序", () => {
  const now = Date.now();
  const ins = db.prepare("INSERT INTO schedule_events (company, role, interview_at, email_id, created_at) VALUES (?,?,?,?,?)");
  ins.run("A", "前端", now + 2 * 3600 * 1000, "e_a", now);      // 2h 后 → 含
  ins.run("B", "后端", now + 24 * 3600 * 1000, "e_b", now);     // 24h 后 → 含（≤3 天）
  ins.run("C", "算法", now + 5 * 86400e3, "e_c", now);          // 5 天后 → 排除
  ins.run("D", "测试", now - 3600 * 1000, "e_d", now);          // 过去 → 排除
  const events = mail.getUpcomingEvents({ withinDays: 3 });
  assert.deepEqual(events.map((e) => e.emailId), ["e_a", "e_b"]);
});

test("getSchedule：只返回未来 + 升序", () => {
  const now = Date.now();
  const ins = db.prepare("INSERT INTO schedule_events (company, role, interview_at, email_id, created_at) VALUES (?,?,?,?,?)");
  ins.run("A", "前端", now + 3 * 3600 * 1000, "e_a", now);
  ins.run("B", "后端", now + 3600 * 1000, "e_b", now);
  ins.run("C", "算法", now - 3600 * 1000, "e_c", now);          // 过去 → 排除
  const events = mail.getSchedule();
  assert.deepEqual(events.map((e) => e.emailId), ["e_b", "e_a"]);
});

// ---------- 完整流水线（DI 注入假 IMAP + 假 LLM） ----------
test("runMailCheck：未配置邮箱 → ok:false", async () => {
  const r = await mail.runMailCheck({ clientFactory: () => fakeImapClient(), llm: async () => "[]" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "未配置邮箱");
});

test("runMailCheck：完整流水线（假 IMAP 返回 1 封 → LLM 识别 → 入库）", async () => {
  mail.setConfig({ email: "a@qq.com", authCode: "x" });
  const at = futureStr(2);
  const client = fakeImapClient({
    emails: [{ uid: 11, from: "hr@x.com", subject: "面试邀约", raw: "Subject: 面试邀约\n\n腾讯 前端 面试 8月20日 14:00 线上" }],
  });
  const llm = async () => JSON.stringify([{ company: "腾讯", role: "前端", interviewAt: at, form: "线上", location: "", link: "", emailId: "11" }]);
  const r = await mail.runMailCheck({ clientFactory: () => client, llm });
  assert.equal(r.ok, true);
  assert.equal(r.emails, 1);
  assert.equal(r.added, 1);
  assert.equal(r.upcoming.length, 1);
  assert.equal(r.upcoming[0].company, "腾讯");
});
