// MCP 客户端测试：连接测试 server → 工具发现 → 调用 → agent 集成
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, mockFetchPage, setLlmResponses, setMockPages, resetMemoryState } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = setupTempDb("mcp-client");
mockLLM();
mockFetchPage();

// 配置临时 MCP server（独立配置文件，不碰真实 data/mcp-servers.json——避免并发测试竞态）
const cfgDir = mkdtempSync(path.join(tmpdir(), "mcp-cfg-"));
const cfgFile = path.join(cfgDir, "mcp-servers.json");
process.env.MIANSHI_MCP_CONFIG = cfgFile;

const { initMcpClients, getMcpTools, callMcpTool, getMcpStatus, closeMcpClients } = await import("../lib/mcp-client.mjs");
const { chatWithAgent } = await import("../lib/agent.mjs");
const { memory } = await import("../lib/memory.mjs");

before(async () => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(cfgFile, JSON.stringify([
    { name: "test-server", command: process.execPath, args: ["tests/fixtures/test-mcp-server.mjs"], cwd: ROOT },
  ]), "utf8");
  await initMcpClients();
});
after(async () => {
  await closeMcpClients(); // 关闭子进程，避免测试进程挂住
  rmSync(cfgDir, { recursive: true, force: true });
  cleanupTempDb(dbDir);
});

test("initMcpClients 连接测试 server 并发现工具", () => {
  const status = getMcpStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].name, "test-server");
  assert.equal(status[0].tools, 3, "发现 add/echo/get_time");
});

test("getMcpTools 转成 OpenAI function calling 格式（命名空间 mcp__server__tool）", () => {
  const tools = getMcpTools();
  assert.equal(tools.length, 3);
  const add = tools.find((t) => t.function.name === "mcp__test-server__add");
  assert.ok(add, "命名空间正确");
  assert.ok(add.function.description.includes("[MCP:test-server]"));
  assert.equal(add.function.parameters.type, "object");
  assert.ok(add.function.parameters.properties.a, "zod schema 转成 JSON schema");
});

test("callMcpTool 转发调用返回文本结果（按不可信数据包裹）", async () => {
  const r = await callMcpTool("mcp__test-server__add", { a: 2, b: 3 });
  assert.equal(r.ok, true);
  // 外部 MCP server 输出按不可信数据包裹（提示注入防护：与 search_posts/web_search 同约定）
  assert.ok(String(r.result).includes("5"), "结果文本透传");
  assert.ok(String(r.result).includes("<untrusted_data>"), "结果被不可信包裹");
  const e = await callMcpTool("mcp__test-server__echo", { text: "你好" });
  assert.ok(String(e.result).includes("你好"), "echo 透传");
});

test("callMcpTool 非法/未连接 server → 可读错误", async () => {
  const bad = await callMcpTool("mcp__nope__add", { a: 1, b: 2 });
  assert.ok(bad.error, "未连接 server 返回错误");
  const illegal = await callMcpTool("add", {});
  assert.ok(illegal.error, "非法名返回错误");
});

test("agent 集成：LLM 调 MCP 工具（mock LLM 驱动）", async () => {
  await clearAllTables();
  resetMemoryState(memory);
  setMockPages([]);
  setLlmResponses(
    'TOOLCALL:{"name":"mcp__test-server__add","arguments":"{\\"a\\":10,\\"b\\":32}"}',
    "计算结果是 42。"
  );
  // MCP 工具默认 confirm：先允许审批
  const { getPendingApprovals, resolveApproval } = await import("../lib/permission.mjs");
  const chatPromise = chatWithAgent("帮我算 10+32");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (getPendingApprovals().some((p) => p.toolName === "mcp__test-server__add")) break;
  }
  resolveApproval("mcp__test-server__add", { allow: true });
  const r = await chatPromise;
  assert.ok(r.reply.includes("42"), "MCP 工具结果被 agent 使用");
  // trace 记录 MCP 调用
  const { getRecentTools } = await import("../lib/trace.mjs");
  const tools = getRecentTools(20);
  assert.ok(tools.some((t) => t.tool_name === "mcp__test-server__add" && t.ok), "MCP 调用写入 trace");
});

test("MCP 工具默认走审批（confirm 分级，堵住绕过漏洞）", async () => {
  await clearAllTables();
  resetMemoryState(memory);
  setMockPages([]);
  // 未声明 permission:"auto" 的 server → 工具调用应触发审批
  setLlmResponses(
    'TOOLCALL:{"name":"mcp__test-server__add","arguments":"{\\"a\\":1,\\"b\\":2}"}',
    "明白，用户没批准就不执行。"
  );
  const chatPromise = chatWithAgent("帮我算 1+2");
  // 等审批出现
  const { getPendingApprovals, resolveApproval } = await import("../lib/permission.mjs");
  let pended = false;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (getPendingApprovals().some((p) => p.toolName === "mcp__test-server__add")) { pended = true; break; }
  }
  assert.ok(pended, "MCP 工具应触发审批（默认 confirm）");
  resolveApproval("mcp__test-server__add", { allow: false });
  const r = await chatPromise;
  assert.ok(r.reply.length > 0, "拒绝后 agent 正常回复");
  // trace 记录拒绝
  const { getRecentTools } = await import("../lib/trace.mjs");
  const bad = getRecentTools(20).find((t) => t.tool_name === "mcp__test-server__add");
  assert.ok(bad && !bad.ok, "拒绝记录为失败调用");
});

test("MCP server 配置 permission:auto 时免审批", async () => {
  // 临时把配置改成 auto（写独立临时配置文件）
  const { writeFileSync: wfs } = await import("node:fs");
  wfs(cfgFile, JSON.stringify([
    { name: "test-server", command: process.execPath, args: ["tests/fixtures/test-mcp-server.mjs"], cwd: ROOT, permission: "auto" },
  ]), "utf8");
  const { getMcpPermission } = await import("../lib/mcp-client.mjs");
  assert.equal(getMcpPermission("mcp__test-server__add"), "auto");
  // 恢复（无 permission → 默认 confirm）
  wfs(cfgFile, JSON.stringify([
    { name: "test-server", command: process.execPath, args: ["tests/fixtures/test-mcp-server.mjs"], cwd: ROOT },
  ]), "utf8");
  assert.equal(getMcpPermission("mcp__test-server__add"), "confirm", "默认 confirm");
});

test("read_tool_result 白名单：拒绝目录外路径", async () => {
  // 直接验证工具白名单逻辑（通过 chatWithAgent 调 read_tool_result 会被 LLM mock 挡，改测路径校验函数）
  // 用 executeTool 不可达，改通过读函数验证：临时写一个工具结果并尝试读目录外
  const { toolReadToolResult } = await import("../lib/agent.mjs");
  const deny = await toolReadToolResult("../config.mjs");
  assert.ok(deny.error && deny.error.includes("拒绝读取"), "目录外路径被拒绝");
  const missing = await toolReadToolResult("data/tool_results/nope.json");
  assert.ok(missing.error, "不存在的文件报错");
});
