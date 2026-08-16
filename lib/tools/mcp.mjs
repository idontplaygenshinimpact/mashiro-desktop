// lib/tools/mcp.mjs —— MCP 客户端工具接入（纵向拆分：从 lib/agent.mjs 迁出）
// 外部工具服务器：首次聊天时连接（惰性，不阻塞服务启动），工具 schema 动态合入 TOOLS
let mcpToolsCache = [];
const MCP_INIT_TIMEOUT_MS = 10000; // MCP server 连接超时（防挂起的 server 阻塞每次聊天）

export async function initMcpAgent() {
  try {
    const { initMcpClients, getMcpTools } = await import("../mcp-client.mjs");
    // 带超时：MCP server 挂起时不阻塞聊天（在 AGENT_TIMEOUT_MS 兜底之外再加一道局部护栏）
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP 初始化超时(${MCP_INIT_TIMEOUT_MS / 1000}s)`)), MCP_INIT_TIMEOUT_MS);
    });
    try {
      await Promise.race([initMcpClients(), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
    mcpToolsCache = getMcpTools();
  } catch (e) {
    console.log(`[agent] MCP 初始化失败: ${e.message.slice(0, 80)}`);
  }
  return mcpToolsCache;
}

// 惰性初始化：首次聊天时连接 MCP（不阻塞服务启动）
let mcpInitPromise = null;
export function ensureMcp() {
  if (!mcpInitPromise) mcpInitPromise = initMcpAgent();
  return mcpInitPromise;
}

/** 当前已加载的 MCP 工具 schema（agent 循环拼接 fullTools 用） */
export function getMcpToolsCache() {
  return mcpToolsCache;
}