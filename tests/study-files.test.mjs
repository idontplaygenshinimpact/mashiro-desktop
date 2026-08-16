// study-files.mjs 单测：讲解文件查找/文件名安全化/规范化
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

const dbDir = setupTempDb("study-files");
const { normName, sanitizeFilename, findStudyFile, studyNotesDir } = await import("../lib/study-files.mjs");
const { config } = await import("../config.mjs");

let tmpOut = null;
beforeEach(() => {
  tmpOut = mkdtempSync(path.join(tmpdir(), "mianshi-out-"));
  config.outputDir = tmpOut;
});
after(() => { cleanupTempDb(dbDir); if (tmpOut) rmSync(tmpOut, { recursive: true, force: true }); });

test("sanitizeFilename：去掉 Windows 非法字符并截断", () => {
  assert.equal(sanitizeFilename("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij");
  assert.equal(sanitizeFilename("正常知识点"), "正常知识点");
  assert.equal(sanitizeFilename(""), "note");
});

test("normName：忽略空格/括号/下划线差异", () => {
  assert.equal(normName("事件循环 与 微任务"), normName("事件循环与微任务"));
  assert.equal(normName("HTTP（缓存）"), normName("HTTP(缓存)"));
  assert.equal(normName("React-Hooks"), normName("React_Hooks"));
});

test("findStudyFile：study_notes 按 topic 精确匹配", () => {
  const notesDir = studyNotesDir();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(path.join(notesDir, "事件循环与微任务.md"), "# 讲解", "utf8");
  assert.ok(findStudyFile({ topic: "事件循环与微任务" }));
  assert.ok(findStudyFile({ topic: "事件循环 与 微任务" }), "规范化后也能匹配");
  assert.equal(findStudyFile({ topic: "不存在的主题" }), null);
});

test("findStudyFile：产出目录按 source 模糊匹配", () => {
  mkdirSync(path.join(tmpOut, "2026-08-16_discover"), { recursive: true });
  writeFileSync(path.join(tmpOut, "2026-08-16_discover", "React 面经.md"), "# 内容", "utf8");
  const hit = findStudyFile({ source: "React 面经.md" });
  assert.ok(hit && hit.endsWith("React 面经.md"));
});
