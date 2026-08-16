// 投递优势招呼语生成器测试：简历亮点提取 / 规则版文案拼装 / 无简历兜底 / 精修回退
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("greeting");
const g = await import("../lib/greeting.mjs");
const { db } = await import("../lib/db.mjs");

const RESUME = `张三 前端工程师 ｜ 男 · 22 岁 ｜ 211 计算机本科
武汉大学计算机科学与技术专业大三在读，具备 Vue3 / React / TypeScript 开发经验。
实习经历 杭州某某科技有限公司（XX）｜前端开发实习生 2026.3-至今
参与 img2code 数据生产项目开发
项目经历 CareerPilot｜Next.js 15 + TypeScript + Zustand
独立开发，已部署，配套 158 单测 + 59 E2E，首屏 313kB 降至 147kB`;

beforeEach(async () => {
  await clearAllTables();
});

test("extractResumeHighlights：学校(211)/实习公司/项目/量化 提取", () => {
  const hl = g.extractResumeHighlights(RESUME);
  assert.equal(hl.school, "武汉大学（211）");
  assert.equal(hl.internCompany, "杭州某某科技有限公司");
  assert.equal(hl.project, "CareerPilot");
  assert.ok(hl.quant.includes("158"), `量化含单测: ${hl.quant}`);
  // 空原文安全
  assert.deepEqual(g.extractResumeHighlights(""), { school: "", internCompany: "", project: "", quant: "" });
  assert.deepEqual(g.extractResumeHighlights(null), { school: "", internCompany: "", project: "", quant: "" });
});

test("buildGreeting：展示学校/实习/技能/项目优势 + 点名岗位", () => {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('resume_skills', ?, ?)")
    .run(JSON.stringify({ skills: ["Vue3", "React", "TypeScript"], directions: ["frontend", "agent"] }), Date.now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('resume_raw', ?, ?)")
    .run(JSON.stringify({ text: RESUME }), Date.now());
  const text = g.buildGreeting({ company: "字节跳动", title: "前端实习生" });
  assert.ok(text.includes("武汉大学（211）"), "含学校+211");
  assert.ok(text.includes("杭州某某科技有限公司"), "含实习公司");
  assert.ok(text.includes("Vue3 / React / TypeScript"), "含技能");
  assert.ok(text.includes("CareerPilot"), "含项目");
  assert.ok(text.includes("158 单测"), "含量化亮点");
  assert.ok(text.includes("字节跳动") && text.includes("前端实习生"), "点名岗位");
  assert.ok(text.length >= 60 && text.length <= 250, `长度合适（${text.length}）`);
});

test("buildGreeting：无简历 → 简洁兜底", () => {
  const text = g.buildGreeting({ title: "前端" });
  assert.ok(text.includes("前端"), "兜底文案含方向");
  assert.ok(text.length < 80, "兜底文案简短");
});

test("polishGreeting：无简历/LLM 失败时退回规则版", async () => {
  // 无简历：精修退回兜底文案
  const t1 = await g.polishGreeting({ title: "前端" });
  assert.ok(typeof t1 === "string" && t1.length > 0, "精修不崩");
});

cleanupTempDb(dbDir);
