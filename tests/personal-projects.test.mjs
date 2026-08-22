// tests/personal-projects.test.mjs —— 个人项目档案上下文注入单测
// 背景：清单"简历项目"条目讲解时 LLM 只能看到 topic 名称 → 讲解空泛；
//       getProjectArchiveContext 按 topic/来源匹配项目档案注入真实代码
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("personal-proj");
const { savePersonalProjects, getProjectArchiveContext } = await import("../lib/personal-projects.mjs");

let projDir = null;
beforeEach(async () => {
  await clearAllTables();
  projDir = mkdtempSync(path.join(tmpdir(), "pp-"));
  mkdirSync(path.join(projDir, "src"), { recursive: true });
  writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "lowcode-platform", dependencies: { react: "^18", express: "^4" }, description: "低代码拖拽平台" }));
  writeFileSync(path.join(projDir, "src", "engine.js"), "export class DragEngine { constructor() { this.nodes = []; } }");
  savePersonalProjects([{ name: "低代码平台", dir: projDir }]);
});
after(() => { cleanupTempDb(dbDir); });

test("topic 匹配项目名 → 注入档案（含技术栈与源码结构）", async () => {
  const ctx = await getProjectArchiveContext("低代码平台的拖拽引擎实现", "");
  assert.ok(ctx.includes("低代码平台"), "含项目名");
  assert.ok(ctx.includes("真实代码"), "标注基于真实代码");
  assert.ok(ctx.includes("react") || ctx.includes("lowcode"), "含技术栈/目录");
  assert.ok(ctx.includes("DragEngine"), "含源码内容");
});

test("topic 无匹配 → 返回空串（普通知识点不误注入）", async () => {
  const ctx = await getProjectArchiveContext("事件循环与微任务", "产出");
  assert.equal(ctx, "", "非项目条目不注入");
});

test("source 标记简历 + topic 含项目名前缀 → 兜底匹配", async () => {
  const ctx = await getProjectArchiveContext("低代码", "简历");
  assert.ok(ctx.includes("低代码平台"), "按来源兜底匹配到项目");
});

test("未配置项目 → 返回空串不崩溃", async () => {
  savePersonalProjects([]);
  const ctx = await getProjectArchiveContext("低代码平台", "");
  assert.equal(ctx, "");
  savePersonalProjects([{ name: "低代码平台", dir: projDir }]); // 恢复
});
