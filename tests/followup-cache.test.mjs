// followup-cache.mjs 单测：追问段落解析 / 语义相似度 / 去重命中 / 前缀稳定拆分
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFollowups, normalizeQuestion, findSimilarFollowup, queryFollowupCache } from "../lib/followup-cache.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.mjs";

test("parseFollowups：提取 💬 追问段落（多段 + 边界）", () => {
  const text = `# 讲解\n\n正文…\n\n---\n\n## 💬 追问：为什么需要缓存\n\n因为…\n\n---\n\n## 💬 追问：缓存失效怎么办\n\n设置过期…\n`;
  const f = parseFollowups(text);
  assert.equal(f.length, 2);
  assert.equal(f[0].question, "为什么需要缓存");
  assert.ok(f[0].answer.includes("因为"));
  assert.equal(f[1].question, "缓存失效怎么办");
  assert.ok(f[1].answer.includes("过期"));
});

test("parseFollowups：无追问段落 → 空数组", () => {
  assert.equal(parseFollowups("# 只有讲解正文").length, 0);
  assert.equal(parseFollowups("").length, 0);
});

test("bigramJaccard + editSimilarity：相似短文本高分、无关文本低分", async () => {
  const { bigramJaccard, editSimilarity, levenshtein } = await import("../lib/followup-cache.mjs");
  assert.ok(bigramJaccard("为什么需要缓存", "为什么需要缓存") === 1);
  assert.ok(editSimilarity("为什么需要缓存", "为什么要用缓存") > 0.7, "近义高分（编辑距离）");
  assert.ok(editSimilarity("为什么需要缓存", "数据库索引原理") < 0.4, "无关低分");
  assert.ok(levenshtein("缓存", "缓存") === 0);
  assert.ok(levenshtein("缓存", "缓存失效") === 2);
});

test("normalizeQuestion：去空白标点语气", () => {
  assert.equal(normalizeQuestion(" 为什么需要缓存？ "), "为什么需要缓存");
  assert.equal(normalizeQuestion("再讲讲：宏任务 和 微任务！"), "再讲讲宏任务和微任务");
});

test("findSimilarFollowup：完全一致命中 + 子串命中 + 阈值外不命中", () => {
  const fups = [
    { question: "为什么需要缓存", answer: "A1" },
    { question: "缓存失效怎么办", answer: "A2" },
  ];
  const exact = findSimilarFollowup("为什么需要缓存？", fups);
  assert.ok(exact && exact.similarity === 1 && exact.answer === "A1");
  const sub = findSimilarFollowup("需要缓存", fups); // 子串 → 0.95
  assert.ok(sub && sub.similarity >= 0.9, "子串命中");
  assert.equal(findSimilarFollowup("数据库索引原理", fups), null, "无关不命中");
});

test("queryFollowupCache：命中返回 fromCache 标记（端到端：临时目录存档）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fup-"));
  const origOutput = config.outputDir;
  config.outputDir = dir;
  try {
    // 模拟 routes/study.mjs 存档格式（sanitizeFilename(topic).md）
    const fs = await import("node:fs");
    fs.mkdirSync(path.join(dir, "study_notes"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "study_notes", "事件循环.md"),
      `# 事件循环\n\n正文…\n\n---\n\n## 💬 追问：宏任务和微任务的执行顺序\n\n宏任务先执行，微任务在同步代码后、下一个宏任务前执行…\n`,
      "utf8"
    );
    const hit = queryFollowupCache("事件循环", "宏任务与微任务的执行顺序？");
    assert.ok(hit, "近义追问命中缓存");
    assert.equal(hit.fromCache, true);
    assert.ok(hit.answer.includes("宏任务先执行"));
    // 无关追问不命中
    assert.equal(queryFollowupCache("事件循环", "什么是防抖节流"), null);
  } finally {
    config.outputDir = origOutput;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryFollowupCache：无存档 → null（不误命中）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fup-empty-"));
  const origOutput = config.outputDir;
  config.outputDir = dir;
  try {
    assert.equal(queryFollowupCache("不存在的知识点", "随便问问"), null);
  } finally {
    config.outputDir = origOutput;
    rmSync(dir, { recursive: true, force: true });
  }
});
