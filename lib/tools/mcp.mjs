// lib/tools/mcp.mjs —— MCP 客户端工具接入（纵向拆分：从 lib/agent.mjs 迁出）
// 外部工具服务器：首次聊天时连接（惰性，不阻塞服务启动），工具 schema 动态合入 TOOLS
let mcpToolsCache = [];
const MCP_INIT_TIMEOUT_MS = 10000; // MCP server 连接超时（防挂起的 server 阻塞每次聊天）

/**
 * 初始化 MCP 客户端并缓存工具 schema（带超时护栏；失败抛错不缓存）
 * @returns {Promise<Array<any>>} MCP 工具 schema 列表
 */
export async function initMcpAgent() {
  try {
    const { initMcpClients, getMcpTools } = await import("../mcp-client.mjs");
    // 带超时：MCP server 挂起时不阻塞聊天（在 AGENT_TIMEOUT_MS 兜底之外再加一道局部护栏）
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP 初始化超时(${MCP_INIT_TIMEOUT_MS / 1000}s)`)), MCP_INIT_TIMEOUT_MS);
    });
    let timedOut = false;
    try {
      await Promise.race([initMcpClients(), timeoutPromise]);
    } catch {
      timedOut = true; // 超时（或底层初始化立即失败）
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      // 超时后等底层 initMcpClients settle 再刷新缓存：晚到的成功结果仍可用（不丢弃），
      // 且不会留下"半初始化"状态；底层失败由 mcp-client 内部失败隔离 settle
      await initMcpClients();
    }
    mcpToolsCache = getMcpTools();
  } catch (e) {
    console.log(`[agent] MCP 初始化失败: ${e.message.slice(0, 80)}`);
    throw e; // 失败态不缓存：ensureMcp 据此重置缓存，允许下次重试
  }
  return mcpToolsCache;
}

// 惰性初始化：首次聊天时连接 MCP（不阻塞服务启动）
// 失败/超时不记住失败态：mcpInitPromise 重置为 null，下次 ensureMcp 可重试
// （此前失败后 mcpInitPromise 保持 resolved → 一次超时/失败后后续聊天永不重连 MCP）
let mcpInitPromise = null;
/**
 * 惰性初始化 MCP（首次调用触发连接；失败/超时允许下次重试）
 * @returns {Promise<Array<any>>} MCP 工具 schema 列表
 */
export function ensureMcp() {
  if (!mcpInitPromise) {
    mcpInitPromise = initMcpAgent().catch(() => {
      mcpInitPromise = null; // 失败/超时：允许下次调用重试
      return mcpToolsCache;
    });
  }
  return mcpInitPromise;
}

/**
 * 当前已加载的 MCP 工具 schema（agent 循环拼接 fullTools 用）
 * @returns {Array<any>} 缓存的工具 schema 列表
 */
export function getMcpToolsCache() {
  return mcpToolsCache;
}
