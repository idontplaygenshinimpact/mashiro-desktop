#!/usr/bin/env node
// Mashiro 秋招助手 MCP Server 入口（npm 全局安装后 `mashiro-mcp` 命令）
// 用法：任意支持 MCP 的 AI 工具（Claude Code/Cline/其他 agent）配置
//   "mcpServers": { "mashiro": { "command": "mashiro-mcp" } }
// 数据目录：**自动探测**（修复：源码版=项目 data/、打包版=Electron userData/data、本包=~/.mashiro
//   三个位置不一致导致必须手动配置）——按优先级找"已存在的桌宠数据库"命中即用，
//   已有桌宠数据的用户装包即连零配置；干净用户回落 ~/.mashiro/data（自动创建）。
// LLM Key：设置中心 settings 表（共享桌宠数据目录时自动继承）/ DEEPSEEK_API_KEY / .env / opencode auth.json
import path from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { resolveDataDir } from "../lib/data-detect.mjs";

if (!process.env.MIANSHI_DATA_DIR) {
  process.env.MIANSHI_DATA_DIR = resolveDataDir();
}
if (!process.env.MIANSHI_OUTPUT_DIR) {
  process.env.MIANSHI_OUTPUT_DIR = path.join(homedir(), ".mashiro", "output");
}
try { mkdirSync(process.env.MIANSHI_DATA_DIR, { recursive: true }); } catch { /* ignore */ }
try { mkdirSync(process.env.MIANSHI_OUTPUT_DIR, { recursive: true }); } catch { /* ignore */ }
console.error(`[mashiro-mcp] 数据目录: ${process.env.MIANSHI_DATA_DIR}`);

// MCP server 主逻辑（stdin/stdout 协议，进程常驻等待客户端）
await import("../mcp-server.mjs");
