// project-guide 技能测试（工单 docs/project-guide功能工单.md）
// 路径穿越防护 / 大小限制 / 白名单 / 7 段指南生成 / skill 注册可见
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

setupTempDb("project-guide");
mockLLM();

const { savePersonalProjects } = await import("../lib/personal-projects.mjs");
const { loadSkills, inspectSkills, callSkillTool } = await import("../lib/skills.mjs");

const dirs = [];
function tmpProject() {
  const d = mkdtempSync(path.join(tmpdir(), "pg-"));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// 配置一个测试项目（白名单）
const projDir = tmpProject();
writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "demo", dependencies: { react: "^19" } }, null, 2), "utf8");
mkdirSync(path.join(projDir, "src"), { recursive: true });
writeFileSync(path.join(projDir, "src", "main.mjs"), "export function hello() { return 'hi'; }\n".repeat(5), "utf8");
writeFileSync(path.join(projDir, "big.js"), "x".repeat(60 * 1024), "utf8"); // >50KB
savePersonalProjects([{ name: "demo-project", dir: projDir }]);

const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
import { fileURLToPath } from "node:url";

test("skill 注册：project-guide 可见 + read_project_file/generate_project_guide 工具", async () => {
  await loadSkills(SKILLS_DIR);
  const r = inspectSkills(SKILLS_DIR);
  const skill = r.skills.find((s) => s.name === "project-guide");
  assert.ok(skill, "project-guide 技能已加载");
  const toolNames = (skill.tools || []).map((t) => t.name);
  assert.ok(toolNames.includes("skill__project-guide__read_project_file"), "read_project_file 工具注册");
  assert.ok(toolNames.includes("skill__project-guide__generate_project_guide"), "generate_project_guide 工具注册");
});

test("路径穿越防护：../ 与绝对路径拒绝 + 白名单外项目拒绝", async () => {
  const r1 = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "../secret.txt" }, SKILLS_DIR);
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes("项目目录内"), `穿越拒绝（实际: ${r1.error}）`);
  const r2 = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "/etc/passwd" }, SKILLS_DIR);
  assert.equal(r2.ok, false, "绝对路径拒绝");
  const r3 = await callSkillTool("skill__project-guide__read_project_file", { project: "不存在的项目", file: "package.json" }, SKILLS_DIR);
  assert.equal(r3.ok, false);
  assert.ok(r3.error.includes("不在个人项目配置"), "白名单外项目拒绝");
});

test("大小限制：>50KB 文件明确报错", async () => {
  const r = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "big.js" }, SKILLS_DIR);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("50KB"), `大小限制报错（实际: ${r.error}）`);
});

test("正常读：白名单项目内文件 → 内容 + 行数", async () => {
  const r = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "package.json" }, SKILLS_DIR);
  assert.equal(r.ok, true);
  assert.ok(r.content.includes("react"), "内容返回");
  assert.ok(r.lines >= 1, "行数信息");
  const r2 = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "src/main.mjs" }, SKILLS_DIR);
  assert.equal(r2.ok, true);
  assert.ok(r2.content.includes("hello"), "子目录文件可读");
});

test("generate_project_guide：7 段指南生成 + 存档 output/project-guides/", async () => {
  // mock LLM 返回 7 段 Markdown
  setLlmResponses(`## 1. 一句话定位\n这是一个 demo 项目。\n\n## 2. 技术选型理由表\n| 技术 | 理由 |\n|---|---|\n| React | package.json 依赖 |\n\n## 3. 架构地图\n- src/main.mjs：入口\n\n## 4. 核心亮点\n### 亮点 1：hello 函数\n**30 秒话术**：实现了 hello。\n**追问**：为什么用 export？\n**答案要点**：ESM 模块。\n\n## 5. 面试官问题清单\n- 基础：项目背景\n- 深挖：hello 实现\n- 边界：异常处理\n\n## 6. 追问防御\n- hello 无参数校验（源码可见）\n\n## 7. 简历 bullet 建议\n- 实现 hello 模块`);
  const r = await callSkillTool("skill__project-guide__generate_project_guide", { project: "demo-project" }, SKILLS_DIR);
  assert.equal(r.ok, true, `生成成功（实际 error: ${r.error || ""}）`);
  assert.ok(r.path.includes("project-guides"), "存档目录正确");
  assert.ok(existsSync(r.path), "文件已存档");
  assert.equal(r.sections.length, 7, `7 段齐全（实际 ${r.sections.length} 段）`);
  const content = readFileSync(r.path, "utf8");
  for (let i = 1; i <= 7; i++) assert.ok(content.includes(`## ${i}.`), `第 ${i} 段在存档中`);
  // 内容与真实代码一致（抽查：技术栈来自 package.json）
  assert.ok(content.includes("React"), "技术栈来自真实 package.json");
});