#!/usr/bin/env node
// Mashiro 秋招助手 MCP Server 入口（npm 全局安装后 `mashiro-mcp` 命令）
// 用法：任意支持 MCP 的 AI 工具（Claude Code/Cline/其他 agent）配置
//   "mcpServers": { "mashiro": { "command": "mashiro-mcp" } }
// 数据目录：默认 ~/.mashiro（data/ + output/），可用 MIANSHI_DATA_DIR/MIANSHI_OUTPUT_DIR 覆盖
// LLM Key：DEEPSEEK_API_KEY 环境变量 / .env / opencode auth.json（与桌面版同源，见 config.mjs）
import path from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

if (!process.env.MIANSHI_DATA_DIR) {
  process.env.MIANSHI_DATA_DIR = path.join(homedir(), ".mashiro", "data");
}
if (!process.env.MIANSHI_OUTPUT_DIR) {
  process.env.MIANSHI_OUTPUT_DIR = path.join(homedir(), ".mashiro", "output");
}
try { mkdirSync(process.env.MIANSHI_DATA_DIR, { recursive: true }); } catch { /* ignore */ }
try { mkdirSync(process.env.MIANSHI_OUTPUT_DIR, { recursive: true }); } catch { /* ignore */ }

// MCP server 主逻辑（stdin/stdout 协议，进程常驻等待客户端）
await import("../mcp-server.mjs");
