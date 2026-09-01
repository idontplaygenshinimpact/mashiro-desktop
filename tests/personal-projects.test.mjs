// tests/personal-projects.test.mjs —— 个人项目档案上下文注入单测
// 背景：清单"简历项目"条目讲解时 LLM 只能看到 topic 名称 → 讲解空泛；
//       getProjectArchiveContext 按 topic/来源匹配项目档案注入真实代码
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses, getLastMessages } from "./helpers.mjs";

const dbDir = setupTempDb("personal-proj");
const { savePersonalProjects, getProjectArchiveContext } = await import("../lib/personal-projects.mjs");

let projDir = null;
beforeEach(async () => {
  await clearAllTables();
  projDir = mkdtempSync(path.join(tmpdir(), "pp-"));
  mkdirSync(path.join(projDir, "src"), { recursive: true });
  writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "lowcode-platform", dependencies: { react: "^18", express: "^4" }, description: "低代码拖拽平台" }));
  // 源码内容要足够厚：buildProjectArchive 要求档案文本 >=200 字符才入库/注入，
  // 且档案长度受临时目录路径长度影响（CI 的 /tmp 路径比 Windows Temp 短约 25 字符）——多写几行代码保证任何平台都达标
  writeFileSync(path.join(projDir, "src", "engine.js"), [
    "// 拖拽引擎：节点图模型 + 撤销重做栈",
    "export class DragEngine {",
    "  constructor() {",
    "    this.nodes = [];",
    "    this.edges = [];",
    "    this.undoStack = [];",
    "  }",
    "  addNode(type, props = {}) {",
    "    const id = `n${this.nodes.length + 1}`;",
    "    this.nodes.push({ id, type, props, x: 0, y: 0 });",
    "    return id;",
    "  }",
    "  connect(from, to) { this.edges.push({ from, to }); }",
    "  undo() { return this.undoStack.pop() || null; }",
    "  serialize() { return JSON.stringify({ nodes: this.nodes, edges: this.edges }); }",
    "}",
    "",
  ].join("\n"));
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

test("项目档案进知识库：开启 RAG 后 searchKnowledge 可检索到（对话/复习可引用）", async () => {
  // 开启 RAG（searchKnowledge 受 rag_enabled 控制）
  const { db } = await import("../lib/db.mjs");
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('rag_enabled', '1', ?)").run(Date.now());
  // 索引项目档案 → knowledge_items/knowledge_fts（personal-projects 自建，不依赖 rag rebuild）
  const { indexPersonalProjects } = await import("../lib/personal-projects.mjs");
  const idx = await indexPersonalProjects(); // async（并行开发改造——await 修复测试回归）
  assert.ok(idx.ok >= 1, "项目档案已入库");
  // 检索：对话/复习搜索源码标识应命中项目档案（kind=project；查询词用档案真实内容）
  const { searchKnowledge } = await import("../lib/rag.mjs");
  const hits = await searchKnowledge("DragEngine", 3);
  assert.ok(hits.length > 0, "检索有结果");
  assert.ok(hits.some((h) => String(h.title).includes("低代码平台") || String(h.kind) === "project"), "命中项目档案");
});

test("全量重建（rebuildKnowledgeBase）后项目档案仍在（不丢失/可恢复）", async () => {
  const { db } = await import("../lib/db.mjs");
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('rag_enabled', '1', ?)").run(Date.now());
  const { rebuildKnowledgeBase, incrementalRebuild } = await import("../lib/rag.mjs");
  const r = await rebuildKnowledgeBase();
  assert.ok(r.items >= 1, "全量重建完成");
  const rows = db.prepare("SELECT id, source, kind, title FROM knowledge_items WHERE source LIKE 'project:%'").all();
  assert.ok(rows.length >= 1, "项目档案在全量重建后仍存在（rebuild 重灌 project:*）");
  assert.equal(rows[0].kind, "project");
  // 重建后再跑增量：项目档案也不被清掉
  await incrementalRebuild();
  const n = db.prepare("SELECT COUNT(*) n FROM knowledge_items WHERE source LIKE 'project:%'").get().n;
  assert.ok(n >= 1, "增量后项目档案仍在（增量白名单含 project:*）");
});
