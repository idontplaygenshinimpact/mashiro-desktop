// 工单任务 1/2/4：subagent task 八股提取 + 学习文档存档（独立文件——mockLLM 必须在 import 前，
// 否则 llm.mjs 已被其他测试加载真实版，mock 不生效）
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses, getLastMessages } from "./helpers.mjs";

const dbDir = setupTempDb("pp-learn");
mockLLM(); // 必须在 import personal-projects 之前（llm.mjs 未加载时 mock 才生效）
const { savePersonalProjects, getProjectArchiveContext } = await import("../lib/personal-projects.mjs");

let projDir = null;
before(() => {
  projDir = mkdtempSync(path.join(tmpdir(), "ppl-"));
  mkdirSync(path.join(projDir, "src"), { recursive: true });
  writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "lowcode-platform", dependencies: { react: "^18" }, description: "低代码拖拽平台" }));
  writeFileSync(path.join(projDir, "src", "engine.js"), [
    "// 拖拽引擎：节点图模型 + 撤销重做栈",
    "export class DragEngine {",
    "  constructor() { this.nodes = []; this.edges = []; this.undoStack = []; }",
    "  addNode(type, props = {}) { const id = `n${this.nodes.length + 1}`; this.nodes.push({ id, type, props, x: 0, y: 0 }); return id; }",
    "  connect(from, to) { this.edges.push({ from, to }); }",
    "  undo() { return this.undoStack.pop() || null; }",
    "  serialize() { return JSON.stringify({ nodes: this.nodes, edges: this.edges }); }",
    "}",
  ].join("\n"));
  savePersonalProjects([{ name: "低代码平台", dir: projDir }]);
});
after(() => { cleanupTempDb(dbDir); });

test("subagent task 含八股提取要求 + 学习文档存档（项目概览/源码要点/八股/模拟面试问答）", async () => {
  // 响应队列：① 源码分析 subagent（含八股清单，>500 字符触发汇总）② 模拟面试问答 subagent
  setLlmResponses(
    "engine.js: 拖拽引擎（节点图模型 + 撤销重做栈）——DragEngine 类管理 nodes/edges 数组，addNode 生成节点 id 并记录坐标，connect 建立边关系，undoStack 数组实现撤销重做（undo() pop 返回最近快照），serialize 输出 JSON 序列化。核心职责：节点增删/连线/撤销/序列化。坑：undo 只存快照不存命令，内存随操作增长；节点 id 用长度+1 生成，删除节点后可能重复。\n【八股清单】\n【八股】撤销重做栈：项目里 DragEngine.undoStack 用数组实现，undo() pop 返回；追问：撤销重做怎么实现、快照 vs 命令模式、内存优化、命令模式与快照的取舍。\n【八股】节点图模型：nodes/edges 数组 + serialize JSON；追问：图遍历、序列化格式、边校验、有向图与无向图。\n【八股】类与封装：ES6 class 语法；追问：class vs 工厂函数、私有字段、原型链。\n【八股】JSON 序列化：serialize 输出 JSON；追问：循环引用、日期处理、性能。\n【八股】数组操作：push/pop 栈语义；追问：栈 vs 队列、时间复杂度。\n【八股】对象解构与默认参数：props = {} 默认值；追问：默认参数 vs 解构默认值。\n【八股】模板字符串与 id 生成：`n${this.nodes.length + 1}`；追问：唯一 id 生成、UUID、自增 vs 随机。\n【八股】ES6 模块：export class；追问：ESM vs CommonJS、tree shaking。\n【八股】状态管理：类实例字段 vs 闭包；追问：状态提升、不可变更新。",
    "Q1: 拖拽引擎的撤销重做怎么实现？\nA1: DragEngine 用 undoStack 数组存快照，undo() pop 返回。\nQ2: 节点图模型的数据结构？\nA2: nodes/edges 数组，serialize 输出 JSON。\nQ3: 为什么用快照不用命令模式？\nA3: 实现简单，但内存随操作增长。\nQ4: 节点 id 生成有什么问题？\nA4: 用长度+1，删除节点后可能重复。"
  );
  const ctx = await getProjectArchiveContext("低代码平台的拖拽引擎实现", "", true); // force=true：绕过缓存残留，验证搜集路径
  // ① subagent task 含八股提取要求（工单任务 1）
  const taskText = getLastMessages().map((m) => String(m.content || "")).join("\n");
  assert.ok(taskText.includes("八股"), "subagent task 含八股提取要求");
  // ② 学习文档存档（工单任务 2——幂等覆盖 study_notes/项目·xxx-学习文档.md）
  const { studyNotesDir } = await import("../lib/study-files.mjs");
  const docPath = path.join(studyNotesDir(), "项目·低代码平台-学习文档.md");
  assert.ok(existsSync(docPath), "学习文档已存档");
  const doc = readFileSync(docPath, "utf8");
  assert.ok(doc.includes("项目概览"), "含项目概览段");
  assert.ok(doc.includes("源码要点"), "含源码要点段");
  assert.ok(doc.includes("八股"), "含八股段");
  assert.ok(doc.includes("撤销重做栈"), "八股内容来自 subagent 提取");
  assert.ok(doc.includes("模拟面试问答"), "含模拟面试问答段");
  assert.ok(doc.includes("Q1"), "问答内容生成");
  // ③ 讲解注入仍工作（工单任务 3——不破坏现有）
  assert.ok(ctx.includes("全部源码要点汇总"), "讲解注入仍工作");
});

test("学习文档缓存：已生成文档时第二次调用读缓存（不重新搜集——快）", async () => {
  // 第一次调用已生成文档（上一个测试）——第二次调用应读缓存，不消耗 LLM 队列
  setLlmResponses(); // 清空队列——若重新搜集会因队列空而失败/降级
  const ctx2 = await getProjectArchiveContext("低代码平台的拖拽引擎实现", "");
  assert.ok(ctx2.includes("学习文档缓存"), "第二次调用读缓存（标注缓存来源）");
  assert.ok(ctx2.includes("项目概览"), "缓存内容含学习文档");
  // force=true（重新生成）跳过缓存——重新搜集（消耗队列）
  setLlmResponses(
    "engine.js: 拖拽引擎（节点图模型 + 撤销重做栈）——DragEngine 类管理 nodes/edges 数组，addNode 生成节点 id 并记录坐标，connect 建立边关系，undoStack 数组实现撤销重做（undo() pop 返回最近快照），serialize 输出 JSON 序列化。核心职责：节点增删/连线/撤销/序列化。坑：undo 只存快照不存命令，内存随操作增长；节点 id 用长度+1 生成，删除节点后可能重复。\n【八股清单】\n【八股】撤销重做栈：项目里 DragEngine.undoStack 用数组实现，undo() pop 返回；追问：撤销重做怎么实现、快照 vs 命令模式、内存优化、命令模式与快照的取舍。\n【八股】节点图模型：nodes/edges 数组 + serialize JSON；追问：图遍历、序列化格式、边校验、有向图与无向图。\n【八股】类与封装：ES6 class 语法；追问：class vs 工厂函数、私有字段、原型链。\n【八股】JSON 序列化：serialize 输出 JSON；追问：循环引用、日期处理、性能。\n【八股】数组操作：push/pop 栈语义；追问：栈 vs 队列、时间复杂度。\n【八股】对象解构与默认参数：props = {} 默认值；追问：默认参数 vs 解构默认值。\n【八股】模板字符串与 id 生成：`n${this.nodes.length + 1}`；追问：唯一 id 生成、UUID、自增 vs 随机。\n【八股】ES6 模块：export class；追问：ESM vs CommonJS、tree shaking。\n【八股】状态管理：类实例字段 vs 闭包；追问：状态提升、不可变更新。",
    "Q1: 拖拽引擎的撤销重做怎么实现？\nA1: DragEngine 用 undoStack 数组存快照，undo() pop 返回。"
  );
  const ctx3 = await getProjectArchiveContext("低代码平台的拖拽引擎实现", "", true);
  assert.ok(ctx3.includes("全部源码要点汇总"), "force=true 重新搜集（不走缓存）");
});