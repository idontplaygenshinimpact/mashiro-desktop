// MCP 客户端：让 agent 能消费外部 MCP 工具（对标 Claude Code 的 MCP 生态）
// 配置：data/mcp-servers.json = [{ "name": "server名", "command": "node", "args": ["..."] }]
// 工具命名空间：mcp__<server>__<tool>（防工具名冲突）
// 设计要点：
//   - 启动时连接全部配置 server，拉取工具列表（失败隔离：单个 server 挂了不影响主 agent）
//   - 工具转成 OpenAI function calling 格式，动态合入 agent TOOLS
//   - 调用经 MCP 协议转发，结果转文本；trace 记录
// 安全边界：外部 MCP server 视为不可信——工具描述与调用结果必须按不可信数据
// 处理（sanitizeExternal().wrapped），与 search_posts/web_search 等外部内容路径一致
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { sanitizeExternal } from "./prompt-guard.mjs";

// 测试隔离：MIANSHI_MCP_CONFIG 指向临时配置（生产不设置则用默认路径）
const CONFIG_FILE = process.env.MIANSHI_MCP_CONFIG || path.join(import.meta.dirname, "..", "data", "mcp-servers.json");
const TOOL_PREFIX = "mcp__";
// 解析 mcp__<server>__<tool>：非贪婪匹配 server（server 名可含下划线，如 my_server）
const NAME_RE = /^mcp__([\s\S]+?)__(.+)$/;

// ---------- 配置 ----------
function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) || [];
  } catch (e) {
    console.log(`[mcp-client] 配置解析失败: ${e.message}`);
    return [];
  }
}

// 宿主相关环境变量透传给 MCP 子进程（自环 server 是宿主自身——env-only 部署
// （key 只由宿主 process.env 注入）时子进程的 LLM 类工具必须能拿到配置）
function hostEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(DEEPSEEK_|MIANSHI_)/.test(k) && v !== undefined) out[k] = v;
  }
  return out;
}

// ---------- 客户端连接管理 ----------
const servers = new Map(); // serverName -> { client, transport, tools: [{name, description, inputSchema}] }
let initialized = false;

/** 连接所有配置的 MCP server 并拉取工具（幂等，失败隔离） */
export async function initMcpClients() {
  if (initialized) return getMcpTools();
  initialized = true;
  const configs = loadConfig();
  for (const cfg of configs) {
    if (!cfg?.name || !cfg?.command) continue;
    let transport = null;
    let client = null;
    try {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args || [],
        env: { ...hostEnv(), ...(cfg.env || {}) },
        cwd: cfg.cwd || undefined,
      });
      client = new Client({ name: "mashiro-desktop-client", version: "0.1.0" });
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = (listed.tools || []).map((t) => ({
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      }));
      servers.set(cfg.name, { client, transport, tools });
      console.log(`[mcp-client] 已连接 ${cfg.name}（${tools.length} 个工具）`);
    } catch (e) {
      // 失败隔离 + 子进程回收（transport.close() 会 SIGTERM→SIGKILL 子进程，防孤儿）
      try { await transport?.close(); } catch { /* ignore */ }
      try { await client?.close(); } catch { /* ignore */ }
      initialized = false; // 允许下次对话重试（慢启动/瞬时故障不永久丢失 MCP 能力）
      console.log(`[mcp-client] 连接 ${cfg.name} 失败: ${String(e?.message || e).slice(0, 80)}（已隔离，不影响主 agent）`);
    }
  }
  return getMcpTools();
}

/** 已发现的 MCP 工具（OpenAI function calling 格式；描述按不可信内容消毒+截断） */
export function getMcpTools() {
  const tools = [];
  for (const [serverName, s] of servers) {
    for (const t of s.tools) {
      tools.push({
        type: "function",
        function: {
          name: `${TOOL_PREFIX}${serverName}__${t.name}`,
          // 外部 server 提供的描述不可信：包裹为数据声明，防描述里夹带指令
          description: sanitizeExternal(`[MCP:${serverName}] ${t.description || ""}`).wrapped.slice(0, 500),
          parameters: t.inputSchema,
        },
      });
    }
  }
  return tools;
}

/** MCP 工具权限级别：server 配置 permission:"auto" 则自动执行，否则默认 confirm（deny-first）
 * 外部 MCP server 视为不可信——不声明 auto 的一律需要用户批准
 */
export function getMcpPermission(fullName) {
  const m = fullName.match(NAME_RE);
  if (!m) return "confirm";
  const cfg = loadConfig().find((c) => c.name === m[1]);
  return cfg?.permission === "auto" ? "auto" : "confirm";
}

const MCP_CALL_TIMEOUT_MS = 30000; // 单次 MCP 调用超时（防 server 挂起拖死 agent 循环）

/** 调用 MCP 工具（结果按不可信数据包裹；未连接/失败/超时返回可读错误） */
export async function callMcpTool(fullName, args) {
  const m = fullName.match(NAME_RE);
  if (!m) return { error: `非法 MCP 工具名: ${fullName}` };
  const [, serverName, toolName] = m;
  const s = servers.get(serverName);
  if (!s) return { error: `MCP server ${serverName} 未连接` };
  let timer = null;
  try {
    const result = await Promise.race([
      s.client.callTool({ name: toolName, arguments: args || {} }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP 调用超时(${MCP_CALL_TIMEOUT_MS / 1000}s)`)), MCP_CALL_TIMEOUT_MS);
      }),
    ]);
    // 结果转文本 + 不可信包裹（外部 server 输出可能夹带指令，防提示注入）
    const text = (result?.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const raw = text || JSON.stringify(result || {});
    return { ok: true, result: sanitizeExternal(raw).wrapped };
  } catch (e) {
    return { error: `MCP 工具 ${fullName} 调用失败: ${e.message}` };
  } finally {
    if (timer) clearTimeout(timer); // 防定时器堆积
  }
}

/** 已连接 server 列表（调试/面板展示） */
export function getMcpStatus() {
  return [...servers.entries()].map(([name, s]) => ({
    name,
    tools: s.tools.length,
  }));
}

/** 关闭全部 MCP 连接（测试收尾/服务关闭用，避免子进程挂住事件循环） */
export async function closeMcpClients() {
  for (const [, s] of servers) {
    try { await s.client.close(); } catch { /* ignore */ }
    try { await s.transport.close(); } catch { /* ignore */ }
  }
  servers.clear();
  initialized = false;
}
