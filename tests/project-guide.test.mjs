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
// 多行模块（head 截断 + export 签名测试用）
writeFileSync(path.join(projDir, "src", "core.mjs"), "// 核心模块\n".repeat(300) + "export function coreFn() { return 1; }\nexport class Core {}\n", "utf8");
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
  // mock LLM 返回（按调用顺序：子任务 1 → 子任务 2 → 主生成 7 段）
  setLlmResponses(
    // 子任务 1（src/core.mjs 摘要）
    JSON.stringify({ keyFindings: ["coreFn 是核心函数", "Core 类封装状态"], truncated: true }),
    // 子任务 2（src/main.mjs 摘要）
    JSON.stringify({ keyFindings: ["hello 是入口函数"], truncated: false }),
    // 主生成 7 段
    `## 1. 一句话定位\n这是一个 demo 项目。\n\n## 2. 技术选型理由表\n| 技术 | 理由 |\n|---|---|\n| React | package.json 依赖 |\n\n## 3. 架构地图\n- src/main.mjs：入口\n\n## 4. 核心亮点\n### 亮点 1：hello 函数\n**30 秒话术**：实现了 hello。\n**追问**：为什么用 export？\n**答案要点**：ESM 模块。\n\n## 5. 面试官问题清单\n- 基础：项目背景\n- 深挖：hello 实现\n- 边界：异常处理\n\n## 6. 追问防御\n- hello 无参数校验（源码可见）\n\n## 7. 简历 bullet 建议\n- 实现 hello 模块`
  );
  const r = await callSkillTool("skill__project-guide__generate_project_guide", { project: "demo-project" }, SKILLS_DIR);
  assert.equal(r.ok, true, `生成成功（实际 error: ${r.error || ""}）`);
  assert.ok(r.path.includes("project-guides"), "存档目录正确");
  assert.ok(existsSync(r.path), "文件已存档");
  assert.equal(r.sections.length, 7, `7 段齐全（实际 ${r.sections.length} 段）`);
  const content = readFileSync(r.path, "utf8");
  for (let i = 1; i <= 7; i++) assert.ok(content.includes(`## ${i}.`), `第 ${i} 段在存档中`);
  // 内容与真实代码一致（抽查：技术栈来自 package.json）
  assert.ok(content.includes("React"), "技术栈来自真实 package.json");
  // v2：覆盖范围段（完整/部分/未覆盖三档）+ coverage 字段
  assert.ok(content.includes("## 覆盖范围"), "覆盖范围段存在");
  assert.ok(content.includes("完整读取"), "完整读取档");
  assert.ok(content.includes("部分覆盖"), "部分覆盖档（core.mjs 截断诚实标注）");
  assert.ok(Array.isArray(r.coverage?.files) && r.coverage.files.length >= 2, "coverage.files 字段");
  const coreCov = r.coverage.files.find((c) => c.file.includes("core.mjs"));
  assert.ok(coreCov && coreCov.truncated === true, "core.mjs 截断状态如实上报");
});

test("v2 mode 三档：head（前 N 行+truncated）/ export（签名+行号）/ full（全文）", async () => {
  // head：core.mjs 302 行 > 200 → truncated:true + 只含前 200 行
  const h = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "src/core.mjs", mode: "head" }, SKILLS_DIR);
  assert.equal(h.ok, true);
  assert.equal(h.mode, "head");
  assert.equal(h.truncated, true, "head 截断标记");
  assert.ok(h.content.split("\n").length <= 200, "只读前 200 行");
  // export：签名清单 + 行号
  const e = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "src/core.mjs", mode: "export" }, SKILLS_DIR);
  assert.equal(e.ok, true);
  assert.equal(e.mode, "export");
  assert.ok(e.content.includes("coreFn"), "函数签名在清单");
  assert.ok(e.content.includes("Core"), "class 签名在清单");
  assert.ok(/\d+:/.test(e.content), "带行号");
  // full：全文 + 截断标记（302 行 < 8000 字符 → 不截断）
  const f = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "src/core.mjs", mode: "full" }, SKILLS_DIR);
  assert.equal(f.ok, true);
  assert.equal(f.mode, "full");
  assert.equal(f.truncated, false, "小文件 full 不截断");
  assert.ok(f.content.includes("coreFn"), "全文含实现");
});

test("v2 参数调整：headLines 提高后 head 读取行数变化（'读详细一点'生效）", async () => {
  const h1 = await callSkillTool("skill__project-guide__read_project_file", { project: "demo-project", file: "src/core.mjs", mode: "head" }, SKILLS_DIR);
  assert.equal(h1.content.split("\n").length, 200, "默认 200 行");
  // 直接调 readProjectFile 验证 headLines 参数（工具层默认 200；generate 层可传）
  const { readProjectFile } = await import("../skills/project-guide/skill.mjs");
  const h2 = await readProjectFile("demo-project", "src/core.mjs", "head", { headLines: 500 });
  assert.equal(h2.ok, true);
  assert.ok(h2.content.split("\n").length > 200, `headLines=500 读到更多（实际 ${h2.content.split("\n").length} 行，文件共 303 行）`);
  assert.equal(h2.truncated, false, "超过文件总行数 → 不截断");
});