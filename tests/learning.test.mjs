// learning 模块单测：清单读取 / 版本检测（mock fetch-page + 临时 DB）/ registry 兜底 / 项目版本对比
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setupTempDb, cleanupTempDb, mockFetchPage, setMockPages } from "./helpers.mjs";

const dbDir = setupTempDb("learning");
mockFetchPage();
const { getLearningDocs, checkDocVersions, readProjectLocalVersion } = await import("../lib/learning.mjs");
const { db } = await import("../lib/db.mjs");

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

test("checkDocVersions 页面无效且无 registry 兜底时标记 ok:false 不崩", async () => {
  setMockPages([{ text: "", invalid: true }]);
  const r = await checkDocVersions(["Node.js"]); // Node.js 无 registry 兜底
  assert.equal(r["Node.js"].ok, false);
  assert.ok(r["Node.js"].error);
});

test("checkDocVersions registry 兜底：页面失败 → npm 版本兜底", async () => {
  setMockPages([{ text: "", invalid: true }]); // React 页面无效
  const fakeRegistry = async (pkg, type) => ({ version: "19.2.0", date: "2026-08-01" });
  const r = await checkDocVersions(["React"], { registryFetch: fakeRegistry });
  assert.equal(r.React.ok, true, "兜底后 ok");
  assert.equal(r.React.version, "19.2.0", "版本来自 registry");
  assert.equal(r.React.source, "npm");
  assert.ok(String(r.React.note).includes("兜底"), "note 说明兜底来源");
});

test("checkDocVersions 页面成功时不覆盖为 registry 结果（页面优先）", async () => {
  setMockPages([{ text: "React 18.3.1 发布" }]);
  const fakeRegistry = async () => ({ version: "99.0.0" });
  const r = await checkDocVersions(["React"], { registryFetch: fakeRegistry });
  assert.equal(r.React.version, "18.3.1", "页面提取优先");
});

test("readProjectLocalVersion：读项目 package.json 依赖版本", () => {
  const proj = path.join(dbDir, "proj");
  try { mkdirSync(proj, { recursive: true }); } catch { /* ignore */ }
  const pkgFile = path.join(proj, "package.json");
  writeFileSync(pkgFile, JSON.stringify({ dependencies: { react: "^18.3.1", next: "15.1.0" }, devDependencies: { typescript: "~5.6.2" } }), "utf8");
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('docs_project', ?, ?)").run(pkgFile, Date.now());
  assert.equal(readProjectLocalVersion("react"), "18.3.1", "去掉 ^ 前缀");
  assert.equal(readProjectLocalVersion("typescript"), "5.6.2", "devDependencies 也算");
  assert.equal(readProjectLocalVersion("vue"), null, "项目里没有的包返回 null");
  // 删除 settings 后：可能命中候选路径（如真实 ai-career 项目）——只断言"返回合法版本串或 null"
  db.prepare("DELETE FROM settings WHERE key='docs_project'").run();
  const fallback = readProjectLocalVersion("react");
  assert.ok(fallback === null || /^\d/.test(fallback), `无配置时安全（${fallback}）`);
});
