// skills 插件机制单测：SKILL.md 声明 + skill.mjs 合并 + 工具/权限/hooks/提示注入
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSkills, getSkillTools, getSkillPermission, getSkillNames,
  buildSkillHintsPrompt, callSkillTool, parseSkillMd, reloadSkills, inspectSkills,
  setActiveSkillSet,
} from "../lib/skills.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");

test("parseSkillMd：frontmatter 解析 + 正文分离；无 frontmatter 兜底", () => {
  const md = "---\nname: abc\ndescription: 说明\n---\n正文内容";
  const r = parseSkillMd(md);
  assert.equal(r.name, "abc");
  assert.equal(r.description, "说明");
  assert.equal(r.body, "正文内容");
  const plain = parseSkillMd("只有正文");
  assert.equal(plain.name, "");
  assert.equal(plain.body, "只有正文");
});

test("loadSkills：SKILL.md-only 技能注册为声明（无工具但有 hints）", async () => {
  const r = await loadSkills(FIXTURES);
  assert.ok(r.names.includes("md-only-skill"), "纯声明技能被加载");
  const md = r.hints.find((h) => h.name === "md-only-skill");
  assert.ok(md, "md-only-skill 有 hint");
  assert.ok(md.system.includes("纯声明技能"), "SKILL.md 正文进入 system 提示");
  assert.ok(!r.tools.some((t) => t.function.name.startsWith("skill__md-only-skill")), "纯声明技能无工具");
});

test("loadSkills：SKILL.md 与 skill.mjs 合并（描述/system/工具），坏 skill 隔离", async () => {
  const r = await loadSkills(FIXTURES);
  const g = r.hints.find((h) => h.name === "good-skill");
  assert.ok(g, "good-skill 有 hint");
  assert.ok(g.system.includes("good-skill 的 system 补充说明"), "skill.mjs 的 system 注入");
  assert.ok(g.system.includes("合并测试"), "SKILL.md 正文与 skill.mjs system 合并");
  assert.ok(!r.names.includes("bad-skill"), "bad-skill 抛错被隔离");
  // 工具与权限不受影响
  assert.equal(r.permMap["skill__good-skill__write_note"], "confirm");
  assert.equal(r.permMap["skill__good-skill__ping"], "auto");
});

test("skill hooks 自动注册到 hooks 系统（监听器生效）", async () => {
  // good-skill 的 after_tool hook 记录 globalThis.__goodSkillLastTool
  const { emitHook } = await import("../lib/hooks.mjs");
  await emitHook("after_tool", { toolName: "fetch_page", ok: true });
  assert.equal(globalThis.__goodSkillLastTool, "fetch_page", "skill 的 hooks 已接线");
});

test("buildSkillHintsPrompt：渲染为 system 追加文本（含技能名与说明）", async () => {
  await loadSkills(); // 生产目录（skills/github-repo 等）先加载
  const prompt = buildSkillHintsPrompt();
  assert.ok(prompt.includes("可用技能"), "包含标题");
  assert.ok(prompt.includes("github-repo"), "包含生产技能名");
});

test("getSkillTools/getSkillPermission/getSkillNames：读默认目录缓存（生产 skills/）", async () => {
  const tools = getSkillTools();
  if (tools.length) {
    assert.ok(tools.some((t) => t.function.name.startsWith("skill__")), "工具名为 skill__ 命名空间");
    assert.equal(typeof getSkillPermission(tools[0].function.name), "string");
    assert.ok(Array.isArray(getSkillNames()));
  }
});

test("callSkillTool：路由到 skill 的 run 并返回结果", async () => {
  const r = await callSkillTool("skill__good-skill__ping", { echo: "hi" }, FIXTURES);
  assert.equal(r.ok, true);
  assert.equal(r.pong, "echo:hi");
});

test("callSkillTool：未知 skill / 未知工具 / 非法名 → error", async () => {
  const r1 = await callSkillTool("skill__nope__ping", {}, FIXTURES);
  assert.ok(r1.error);
  const r2 = await callSkillTool("skill__good-skill__nope", {}, FIXTURES);
  assert.ok(r2.error);
  const r3 = await callSkillTool("not-a-skill-tool", {}, FIXTURES);
  assert.ok(r3.error);
});

test("inspectSkills：运行时概览（技能/工具/权限/hooks）", async () => {
  await loadSkills(FIXTURES);
  const r = inspectSkills(FIXTURES);
  assert.equal(r.ok, true);
  const good = r.skills.find((s) => s.name === "good-skill");
  assert.ok(good, "good-skill 在清单中");
  assert.ok(good.toolCount >= 2, "工具数正确");
  assert.ok(good.tools.some((t) => t.name === "skill__good-skill__write_note" && t.permission === "confirm"), "权限级别可见");
  assert.equal(r.totalTools >= 2, true);
});

test("reloadSkills：清缓存重扫 + hooks 不重复注册", async () => {
  await loadSkills(FIXTURES);
  // 重载前 after_tool 监听器数（good-skill 注册了 1 个）
  const { listHooks } = await import("../lib/hooks.mjs");
  const before = listHooks().find((h) => h.event === "after_tool")?.count || 0;
  const r = await reloadSkills(FIXTURES);
  assert.equal(r.ok, true);
  assert.ok(r.names.includes("good-skill"), "重载后技能仍在");
  assert.ok(r.names.includes("md-only-skill"), "重载后声明技能仍在");
  const after = listHooks().find((h) => h.event === "after_tool")?.count || 0;
  assert.equal(after, before, "重载后 hooks 不重复注册（旧监听器已清理）");
  // 重载后工具仍可调用
  const ping = await callSkillTool("skill__good-skill__ping", { echo: "re" }, FIXTURES);
  assert.equal(ping.ok, true);
});

// ---------- 场景装配（Phase P1）：only 子集加载 ----------
test("loadSkills only：只加载名单内技能（场景装配隔离）", async () => {
  const r = await loadSkills(FIXTURES, { only: ["good-skill"] });
  assert.deepEqual(r.names, ["good-skill"], "仅 good-skill 被加载");
  assert.ok(!r.names.includes("md-only-skill"), "名单外技能不加载");
  const hints = r.hints.map((h) => h.name);
  assert.deepEqual(hints, ["good-skill"], "hints 只含名单内");
  assert.ok(r.tools.every((t) => t.function.name.startsWith("skill__good-skill__")), "工具只含名单内");
});

test("setActiveSkillSet：激活集影响 getters（null=全量向后兼容）", async () => {
  // getters 固定读生产 skills/ 目录——激活集验证用生产目录（仓库内置 6 技能）
  const { SKILLS_DIR } = await import("../lib/skills.mjs");
  setActiveSkillSet(["frontend-cheatsheet"]);
  await loadSkills(SKILLS_DIR);
  assert.deepEqual(getSkillNames(), ["frontend-cheatsheet"], "激活集生效（仅子集）");
  assert.ok(getSkillTools().every((t) => t.function.name.startsWith("skill__frontend-cheatsheet__")), "tools 是子集");
  const prompt = buildSkillHintsPrompt();
  assert.ok(prompt.includes("frontend-cheatsheet") && !prompt.includes("company-intel"), "prompt 只含激活集 hints");
  // 复位全量（向后兼容：旧调用方零感知）
  setActiveSkillSet(null);
  await loadSkills(SKILLS_DIR);
  assert.ok(getSkillNames().includes("company-intel"), "复位后全量恢复");
});
