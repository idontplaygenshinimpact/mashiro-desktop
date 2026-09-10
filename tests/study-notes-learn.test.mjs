// study-notes-learn.ts 单测：讲解存档 → 学习清单（列表/单条/全部/增量/频率 level）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("notes-learn");
process.env.MIANSHI_OUTPUT_DIR = path.join(dbDir, "output");
const notesDir = path.join(dbDir, "output", "study_notes");
mkdirSync(notesDir, { recursive: true });
const { listStudyNotes, learnOneNote, learnAllNotes, learnFromStudyNotes, listStudyNotesWithPlan } = await import("../lib/study-notes-learn.ts");
const { getPlan } = await import("../lib/study.mjs");
const { db } = await import("../lib/db.mjs");

function makeNote(name, content = "# 讲解\n" + "内容".repeat(50)) {
  writeFileSync(path.join(notesDir, name), content, "utf8");
}

beforeEach(async () => {
  await clearAllTables();
  for (const f of ["版本号比较.md", "比较版本号.md", "事件循环.md", "LRU缓存.md"]) {
    try { rmSync(path.join(notesDir, f), { force: true }); } catch { /* ignore */ }
  }
  db.prepare("DELETE FROM settings WHERE key='last_notes_learn_ts'").run();
});
after(() => { cleanupTempDb(dbDir); });

test("listStudyNotes：扫描顶层 .md（文件名即知识点）", () => {
  makeNote("事件循环.md");
  makeNote("LRU缓存.md");
  const notes = listStudyNotes();
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => n.topic === "事件循环" && n.file === "事件循环.md"));
});

test("learnOneNote：单条入清单（source=面经产出·文件名，level 按频率）", () => {
  makeNote("事件循环.md");
  const r = learnOneNote("事件循环.md");
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  const item = getPlan().items.find((i) => i.topic === "事件循环");
  assert.ok(item, "入清单");
  assert.equal(item.source, "面经产出·事件循环.md", "source 标记");
  assert.equal(item.level, "进阶", "单篇 → 进阶");
  // 幂等：再转跳过
  const r2 = learnOneNote("事件循环.md");
  assert.equal(r2.added, 0, "已转跳过");
});

test("learnOneNote：相似变体 → 必会（考点频率≥2）", () => {
  makeNote("版本号比较.md");
  makeNote("比较版本号.md");
  learnAllNotes();
  // 先入的变体保留（后入的相似跳过——防重复）；level 按频率 → 必会
  const item = getPlan().items.find((i) => i.topic === "版本号比较" || i.topic === "比较版本号");
  assert.ok(item, "变体入清单");
  assert.equal(item.level, "必会", "同考点多篇 → 必会");
  assert.equal(getPlan().items.length, 1, "相似变体不重复入清单");
});

test("learnAllNotes：全部转 + 已转标记（inPlan）", () => {
  makeNote("事件循环.md");
  makeNote("LRU缓存.md");
  const r = learnAllNotes();
  assert.equal(r.total, 2);
  assert.equal(r.added, 2);
  const withPlan = listStudyNotesWithPlan();
  assert.ok(withPlan.every((n) => n.inPlan === true), "全部已转标记");
  // 幂等
  const r2 = learnAllNotes();
  assert.equal(r2.added, 0, "已转跳过");
});

test("learnFromStudyNotes：增量（首次只推进游标，之后只转新存档）", async () => {
  makeNote("事件循环.md");
  await new Promise((r) => setTimeout(r, 20)); // 确保 mtime 远小于游标（防同毫秒误判）
  const r1 = learnFromStudyNotes();
  assert.equal(r1.added, 0, "首次不转存量（存量用按钮按需转）");
  assert.equal(getPlan().items.length, 0, "存量不自动刷爆清单");
  // 游标已推进：旧文件不再处理
  const r2 = learnFromStudyNotes();
  assert.equal(r2.scanned, 0, "无新文件");
  // 新文件（mtime 更新）→ 自动转
  makeNote("LRU缓存.md");
  await new Promise((r) => setTimeout(r, 20));
  const r3 = learnFromStudyNotes();
  assert.equal(r3.added, 1, "新讲解自动入清单");
  assert.equal(getPlan().items.length, 1);
});
