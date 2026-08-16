// career.mjs 单测：方向画像（讲解/面试/提炼链路的方向参数，默认前端）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("career");
const { getCareerProfile, saveCareerProfile, resetCareerProfile, invalidateCareerProfile, CAREER_FIELDS } = await import("../lib/career.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  invalidateCareerProfile(); // 清画像缓存（settings 清了但内存缓存残留）
});
after(() => { cleanupTempDb(dbDir); });

test("默认画像：前端秋招参数齐全", () => {
  const p = getCareerProfile();
  assert.equal(p.roleLabel, "资深前端面试辅导老师");
  assert.ok(p.scopeNote.includes("前端"));
  assert.equal(p.codeLang, "JavaScript/TypeScript");
  assert.equal(p.positionDefault, "前端实习生");
  assert.equal(p.examNote, "秋招");
  assert.equal(p.direction, null, "未设置目标方向时为 null");
});

test("保存画像：白名单字段生效并可读回", () => {
  const r = saveCareerProfile({
    roleLabel: "资深后端开发面试辅导老师",
    scopeNote: "后端 / 微服务 / 数据库",
    ignoreNote: "前端/算法岗等其他方向",
    codeLang: "Python / Go",
    positionDefault: "后端开发实习生",
    examNote: "社招",
  });
  assert.equal(r.ok, true);
  const p = getCareerProfile();
  assert.equal(p.roleLabel, "资深后端开发面试辅导老师");
  assert.equal(p.codeLang, "Python / Go");
  assert.equal(p.positionDefault, "后端开发实习生");
});

test("白名单防护：非白名单字段与空值不写入", () => {
  saveCareerProfile({ malicious: "x", roleLabel: "   ", codeLang: "Rust" });
  const p = getCareerProfile();
  assert.equal(p.malicious, undefined, "非法字段被忽略");
  assert.equal(p.roleLabel, "资深前端面试辅导老师", "空字符串不覆盖默认值");
  assert.equal(p.codeLang, "Rust", "合法字段正常写入");
  assert.deepEqual(CAREER_FIELDS, ["roleLabel", "scopeNote", "ignoreNote", "codeLang", "positionDefault", "examNote", "techKeywords"]);
  assert.ok(p.techKeywords.includes("React"), "默认技术栈关键词存在");
});

test("direction 复用 target_direction（单一事实源）", () => {
  // 直接写 target_direction（jobs.mjs 同款格式）——绕过 saveCareerProfile，需手动失效缓存
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run("target_direction", JSON.stringify({ direction: "backend", updatedAt: Date.now() }), Date.now());
  invalidateCareerProfile();
  const p = getCareerProfile();
  assert.equal(p.direction, "backend", "方向从目标方向读取");
});

test("techKeywords：保存后 extractTechKeywords 跟随（转后端）", async () => {
  saveCareerProfile({ techKeywords: "Go,MySQL,Redis,Kafka,Docker,微服务" });
  const { extractTechKeywords } = await import("../lib/loop.mjs");
  const hits = extractTechKeywords("任职要求：熟悉 Go 与 MySQL，有微服务经验，会用 Redis 缓存");
  assert.ok(hits.includes("Go") && hits.includes("MySQL") && hits.includes("微服务"));
  assert.ok(!hits.includes("React"), "前端关键词已替换");
});

test("reset 恢复默认画像", () => {
  saveCareerProfile({ codeLang: "Go" });
  const r = resetCareerProfile();
  assert.equal(r.ok, true);
  const p = getCareerProfile();
  assert.equal(p.codeLang, "JavaScript/TypeScript");
  assert.equal(p.roleLabel, "资深前端面试辅导老师");
});

// ---------- 集成：画像驱动讲解/面试默认值 ----------
test("interview.mjs 默认岗位跟随画像（转后端后默认岗位变化）", async () => {
  saveCareerProfile({ positionDefault: "后端开发实习生" });
  const { startInterview } = await import("../lib/interview.mjs");
  const { memory } = await import("../lib/memory.mjs");
  // mock LLM 返回合法首问
  const { mockLLM, setLlmResponses } = await import("./helpers.mjs");
  setLlmResponses('{"question":"讲讲数据库索引","basis":"开场","dimension":"原理","criteria":"B+树","boundary":"不涉及"}}');
  const r = await startInterview({}); // 不传 position
  assert.equal(r.ok, true);
  assert.equal(memory.getInterview().position, "后端开发实习生", "默认岗位来自画像");
  memory.clearInterview();
  resetCareerProfile();
});
