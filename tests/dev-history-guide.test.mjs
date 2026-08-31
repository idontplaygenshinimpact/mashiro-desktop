// dev-history-guide 技能测试：三源读取（git/opencode/DSH）+ 生成编排 + 红线（只读/不读凭据/截断诚实）
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockLLM, setLlmResponses } from "./helpers.mjs";
import { loadSkills, callSkillTool, inspectSkills } from "../lib/skills.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCODE_DB = path.join(process.env.USERPROFILE || "", ".local", "share", "opencode", "opencode.db");

mockLLM();
let skillTools = null;

before(async () => {
  const r = await loadSkills(path.join(ROOT, "skills"), { force: true });
  assert.ok(r.names.includes("dev-history-guide"), "dev-history-guide 技能被加载");
  const insp = inspectSkills(path.join(ROOT, "skills"));
  const s = (insp.skills || []).find((x) => x.name === "dev-history-guide");
  skillTools = s?.tools || [];
});

test("技能注册：两个工具（read_dev_history / generate_dev_history_guide）", () => {
  const names = skillTools.map((t) => t.name);
  assert.ok(names.includes("skill__dev-history-guide__read_dev_history"), "read_dev_history 工具");
  assert.ok(names.includes("skill__dev-history-guide__generate_dev_history_guide"), "generate_dev_history_guide 工具");
});

test("read_dev_history：git 源（真实仓库只读）", async () => {
  const r = await callSkillTool("skill__dev-history-guide__read_dev_history", { source: "git", limit: 5 });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.git?.commits) && r.git.commits.length > 0, "git 时间线有提交");
  const c = r.git.commits[0];
  assert.ok(c.hash && c.date && c.subject, "提交含 hash/date/subject");
});

test("read_dev_history：opencode 源（readOnly 查询，无凭据字段）", async () => {
  if (!existsSync(OPENCODE_DB)) { console.log("SKIP: opencode.db 不存在"); return; }
  const r = await callSkillTool("skill__dev-history-guide__read_dev_history", { source: "opencode", limit: 5 });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.opencode?.sessions), "会话数组");
  const json = JSON.stringify(r);
  assert.ok(!json.includes("access_token") && !json.includes("refresh_token"), "不返回凭据字段");
  assert.ok(!json.includes("credential"), "不返回 credential 表数据");
});

test("read_dev_history：截断诚实（大 limit 返回 truncated 标记）", async () => {
  const r = await callSkillTool("skill__dev-history-guide__read_dev_history", { source: "git", limit: 60 });
  assert.equal(r.ok, true);
  assert.ok("truncated" in r, "truncated 标记存在");
});

test("generate_dev_history_guide：编排生成 + 存档 + 覆盖范围段（mock LLM）", async () => {
  setLlmResponses("## 开发历程总览\n从基础架构到质量工程，再到评测体系与语音能力，项目经历了四个阶段。\n### 关键时间节点\n- 2026-08 基础架构搭建\n- 2026-08 评测体系落地\n- 2026-08 语音能力上线\n### 技术演进\n- esbuild 主面板 → Vite 双框架子项目\n- 原生渲染 → React/Vue 可替换\n### 可讲的开发故事\n- 沙箱测试补盲区发现两个真漏洞\n- 语音质量四维选优实验\n### 数据支撑\n- 提交 500+，测试 900+ 用例，评测 38 题基线");
  const r = await callSkillTool("skill__dev-history-guide__generate_dev_history_guide", { project: "mashiro-desktop" });
  assert.equal(r.ok, true);
  assert.ok(r.path && existsSync(r.path), "文档已存档");
  const content = readFileSync(r.path, "utf8");
  assert.ok(content.includes("覆盖范围"), "覆盖范围段存在");
  assert.ok(content.includes("git 时间线"), "git 覆盖标注");
  assert.ok(Array.isArray(r.sections) && r.sections.length > 0, "章节列表");
});


test("read_dev_history：codex 源（~/.codex/sessions 只读，type 序列提炼）", async () => {
  const { readDevHistory } = await import("../skills/dev-history-guide/skill.mjs");
  const r = await readDevHistory({ source: "codex", limit: 3 });
  assert.equal(r.ok, true);
  assert.ok(r.codex, "codex 字段存在");
  if (r.codex.ok) {
    assert.ok(Array.isArray(r.codex.sessions), "sessions 数组");
    for (const s of r.codex.sessions) {
      assert.ok(s.file && s.types, "file + types 字段");
    }
  }
});

test("read_dev_history：cc 源（~/.claude/projects 只读，type 序列提炼）", async () => {
  const { readDevHistory } = await import("../skills/dev-history-guide/skill.mjs");
  const r = await readDevHistory({ source: "cc", limit: 3 });
  assert.equal(r.ok, true);
  assert.ok(r.cc, "cc 字段存在");
  if (r.cc.ok) {
    assert.ok(Array.isArray(r.cc.sessions), "sessions 数组");
    for (const s of r.cc.sessions) {
      assert.ok(s.file && s.types, "file + types 字段");
    }
  }
});
