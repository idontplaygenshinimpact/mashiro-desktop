// 测试用 MCP server（stdio 传输）：暴露 add / echo / get_time 三个工具
// 供 mcp-client 单测和集成测试使用
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "test-mcp", version: "1.0.0" });

server.tool("add", "两数相加", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));

server.tool("echo", "原样返回文本", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text }] ,
}));

server.tool("get_time", "返回当前时间戳", {}, async () => ({
  content: [{ type: "text", text: String(Date.now()) }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
