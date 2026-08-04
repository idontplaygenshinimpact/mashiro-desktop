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

// 配置临时 MCP server（指向测试 fixture）
import { readFileSync as readFs } from "node:fs";
const cfgFile = path.join(ROOT, "data", "mcp-servers.json");
const backupCfg = (() => { try { return readFs(cfgFile, "utf8"); } catch { return null; } })();

const { initMcpClients, getMcpTools, callMcpTool, getMcpStatus, closeMcpClients } = await import("../lib/mcp-client.mjs");
const { chatWithAgent } = await import("../lib/agent.mjs");
const { memory } = await import("../lib/memory.mjs");

before(async () => {
  mkdirSync(path.join(ROOT, "data"), { recursive: true });
  writeFileSync(cfgFile, JSON.stringify([
    { name: "test-server", command: process.execPath, args: ["tests/fixtures/test-mcp-server.mjs"], cwd: ROOT },
  ]), "utf8");
  await initMcpClients();
});
after(async () => {
  // 还原配置
  try {
    if (backupCfg !== null) writeFileSync(cfgFile, backupCfg, "utf8");
    else rmSync(cfgFile, { force: true });
  } catch { /* ignore */ }
  await closeMcpClients(); // 关闭子进程，避免测试进程挂住
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

test("callMcpTool 转发调用返回文本结果", async () => {
  const r = await callMcpTool("mcp__test-server__add", { a: 2, b: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.result, "5");
  const e = await callMcpTool("mcp__test-server__echo", { text: "你好" });
  assert.equal(e.result, "你好");
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
  const r = await chatWithAgent("帮我算 10+32");
  assert.ok(r.reply.includes("42"), "MCP 工具结果被 agent 使用");
  // trace 记录 MCP 调用
  const { getRecentTools } = await import("../lib/trace.mjs");
  const tools = getRecentTools(20);
  assert.ok(tools.some((t) => t.tool_name === "mcp__test-server__add" && t.ok), "MCP 调用写入 trace");
});
