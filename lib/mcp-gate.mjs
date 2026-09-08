// 架构 P1-3：MCP 敏感数据读取门控 + 审计
// 背景：MCP 13 工具全只读且无 confirm 门控（mcp-server.mjs 仅 key 校验）——外部 agent
// （Claude Code/Cline 等）可无感直读简历/日程/项目档案。本模块提供可配置门控：
//   - 默认不开启（保持"数据工具零配置可用"的承诺）——环境变量 MIANSHI_MCP_GATE=on 开启
//   - 开启后：敏感工具（简历/日程/项目档案）必须在参数里显式 confirm:"yes" 才放行，
//     否则返回需确认提示（MCP 客户端会展示给用户，由其决定是否配合重试）
//   - 审计：每次敏感工具读取（含放行与拒绝）写 trace_tools（脱敏：只记参数键名）
// 纯函数设计：不 import mcp-server（避免循环依赖），可独立单测。

import { traceTool } from "./trace.mjs";

/** 敏感数据工具集（可读个人隐私/本地源码——外部 agent 无感读取需门控） */
export const SENSITIVE_MCP_TOOLS = new Set([
  "get_personal_profile",   // 简历（教育/项目/技能/求职目标）
  "get_schedule_events",    // 面试/笔试日程
  "get_project_archives",   // 本地项目源码档案
]);

/** 是否敏感数据工具 */
export function isSensitiveMcpTool(name) {
  return SENSITIVE_MCP_TOOLS.has(String(name || ""));
}

/** 门控是否开启（默认关——零配置可用承诺；env 开启） */
export function mcpReadGateEnabled() {
  return process.env.MIANSHI_MCP_GATE === "on";
}

/**
 * 门控检查：敏感工具 + 门控开启时，必须显式 confirm:"yes" 才放行
 * @param {string} name 工具名
 * @param {Record<string, unknown>} [args] 调用参数
 * @returns {{ allow: boolean, error?: string }} 放行 allow:true；拒绝 allow:false + error 提示
 */
export function checkMcpReadGate(name, args = {}) {
  if (!isSensitiveMcpTool(name)) return { allow: true };
  if (!mcpReadGateEnabled()) return { allow: true }; // 门控关闭：零配置可用
  const confirmed = args?.confirm === true || args?.confirm === "yes" || args?.confirm === "YES";
  if (!confirmed) {
    return {
      allow: false,
      error: `「${name}」读取个人敏感数据（简历/日程/项目档案）需要确认：请带参数 confirm:"yes" 重试（或由用户在 Mashiro 环境变量 MIANSHI_MCP_GATE 关闭门控）。`,
    };
  }
  return { allow: true };
}

/**
 * 审计一次 MCP 读取（放行与拒绝都记录——谁读了什么可追溯）
 * 脱敏：只记参数键名不记值（trace_tools 隐私标准，与 agent 工具一致）
 * @param {string} name 工具名
 * @param {Record<string, unknown>} [args]
 * @param {boolean} [ok] 是否放行
 */
export function recordMcpRead(name, args = {}, ok = true) {
  try {
    const keys = args && typeof args === "object" ? Object.keys(args) : [];
    traceTool({
      sessionId: "mcp",
      toolName: `mcp_read:${name}`,
      args: { _redacted: true, argKeys: keys },
      ok,
      error: ok ? null : "门控拒绝",
      durationMs: 0,
    });
  } catch { /* 审计失败不影响读取 */ }
}

/** MCP 工具 schema 里给敏感工具注入的可选 confirm 参数（server.tool 声明用） */
export const SENSITIVE_CONFIRM_FIELD = {
  confirm: {
    type: "string",
    enum: ["yes"],
    description: "确认为本人读取敏感数据——传 'yes' 才放行（门控开启时必需）",
  },
};
