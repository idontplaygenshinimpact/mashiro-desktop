// learning 模块单测：清单读取 / 版本检测（mock fetch-page + 临时 DB）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockFetchPage, setMockPages } from "./helpers.mjs";

const dbDir = setupTempDb("learning");
mockFetchPage();
const { getLearningDocs, checkDocVersions } = await import("../lib/learning.mjs");

beforeEach(() => { setMockPages([]); });
after(() => { cleanupTempDb(dbDir); });

test("getLearningDocs 读三类清单（前端/AI/Agent）", () => {
  const docs = getLearningDocs();
  assert.ok(docs.categories.length >= 3, "三类文档");
  const cats = docs.categories.map((c) => c.category);
  assert.ok(cats.includes("前端") && cats.includes("AI") && cats.includes("Agent"), "分类齐全");
  const all = docs.categories.flatMap((c) => c.sites);
  assert.ok(all.length >= 15, "清单条目足够");
  for (const s of all) {
    assert.ok(s.name && s.official.startsWith("http"), `条目完整: ${s.name}`);
    assert.ok("check" in s, "check 字段存在");
  }
});

test("checkDocVersions 提取版本号/日期并写缓存", async () => {
  setMockPages([
    { text: "React 19.2.3 已发布\n2026-08-01 更新日志" },
    { text: "TypeScript 5.8.2 release notes\n2026年7月" },
  ]);
  const r = await checkDocVersions(["React", "TypeScript"]);
  assert.equal(r.React.version, "19.2.3", "提取版本号");
  assert.equal(r.React.date, "2026-08-01", "提取 ISO 日期");
  assert.equal(r.React.ok, true);
  assert.equal(r.TypeScript.version, "5.8.2");
  assert.ok(r.TypeScript.date.startsWith("2026"), "中文日期格式");
  assert.ok(r._lastCheck, "记录检查时间");
});

test("checkDocVersions 页面无效时标记 ok:false 不崩", async () => {
  setMockPages([{ text: "", invalid: true }]);
  const r = await checkDocVersions(["React"]);
  assert.equal(r.React.ok, false);
  assert.ok(r.React.error);
});
