// 统一 LLM 调用客户端：重试 + 超时 + 错误分类 + 端点 failover
// 所有模块（agent/interview/study/ai）共用，避免各自实现不一致
import { config } from "../config.mjs";
import { db } from "./db.mjs";

const DEFAULT_TIMEOUT = 120000; // 单次调用超时（流式长文保留 2 分钟）
const DEFAULT_TIMEOUT_NON_STREAM = 20000; // 非流式短任务（主端点慢/网关抖动时快速 failover）
const MAX_RETRIES = 3;

/**
 * 非流式超时选择（导出便于单测）：
 * - 长文生成（maxTokens >= 4000：复盘报告/学习清单/情报整理/批量打分）给足 120s——
 *   曾因 20s 默认值掐死复盘报告生成，用户点"结束面试"反复报 This operation was aborted
 * - 短任务（JSON 评分/追问等）保持 20s 快速 failover
 * - opts.timeout 显式指定时优先
 */
export function pickTimeoutMs({ stream, maxTokens = 0, timeout = 0 }) {
  if (timeout) return timeout;
  if (stream) return DEFAULT_TIMEOUT;
  return maxTokens >= 4000 ? 120000 : DEFAULT_TIMEOUT_NON_STREAM;
}

/** 设置中心配置的 API key（settings llm_api_key > .env/环境变量/opencode；面板可改，开源友好） */
export function getSettingsApiKey() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='llm_api_key'").get();
    return row?.value ? String(row.value).trim() : "";
  } catch {
    return "";
  }
}

/** 设置中心配置的 Base URL（settings llm_api_base_url；配了就用单端点，不盲目 fallback） */
export function getSettingsBaseUrl() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='llm_api_base_url'").get();
    return row?.value ? String(row.value).trim() : "";
  } catch {
    return "";
  }
}

/** 设置中心配置的模型名（settings llm_api_model；留空用默认） */
export function getSettingsModel() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='llm_api_model'").get();
    return row?.value ? String(row.value).trim() : "";
  } catch {
    return "";
  }
}

/** @typedef {{ role?: string, model?: string, stream?: boolean, inputTokens?: number|null, outputTokens?: number|null, durationMs?: number|null, ok?: boolean, error?: string|null, endpoint?: string|null }} LLMTraceInfo */
/** @typedef {{ content?: string, tool_calls?: Array<{ id: string, type: string, function: { name: string, arguments: string } }> }} LLMMessage */
/** @typedef {{ choices: Array<{ message: LLMMessage }>, usage?: { prompt_tokens?: number, completion_tokens?: number } }} LLMResponse */
/** @typedef {Error & { retryable?: boolean, statusCode?: number }} RetryableError */

// ---------- 评测期 LLM 指标（Phase 评测 W2：内存计数器，生产零落盘零费用） ----------
// 评测脚本 startEvalMetrics() 后，每次 llmChat 调用 push 一条 {ts,tag,ok,tokens,ms}；
// 结束 getEvalMetrics() 汇总（lib/eval-cost.mjs 做成本/延迟/分账）。不开启时无任何开销。
const evalMetrics = [];
let evalEnabled = false;
/** 开始收集（清空历史） */
export function startEvalMetrics() { evalMetrics.length = 0; evalEnabled = true; }
/** 停止收集 */
export function stopEvalMetrics() { evalEnabled = false; }
/** 取收集结果（副本防外部篡改） */
export function getEvalMetrics() { return [...evalMetrics]; }
function recordEval(entry) {
  if (evalEnabled) evalMetrics.push(entry);
}

/**
 * 带 failover 的 chat/completions 调用
 * @param {Array<{role: string, content?: string}>} messages
 * @param {Object} opts { maxTokens, temperature, tools, toolChoice, timeout, json, role }
 * @param {boolean} [stream] SSE 模式（内部读取流，返回完整文本 + onChunk 回调）
 * @param {((delta: string) => void) | null} [onChunk] 流式回调
 * @returns {Promise<LLMResponse|string>} 非流式返回完整 json；流式返回完整文本
 */
async function llmFetch(messages, opts = {}, stream = false, onChunk = null) {
  // 推理模型（deepseek-v4-flash 带 reasoning）每次调用有固定推理开销（~30-50 token），
  // max_tokens 太小会连推理都不够 → content 被截断为空。下限抬到 96 保证 content 有输出。
  const MIN_OUTPUT_TOKENS = 96;
  let { maxTokens = 4000, temperature = 0.4, tools, toolChoice } = opts;
  maxTokens = Math.max(maxTokens, MIN_OUTPUT_TOKENS);

  // 端点列表：多 provider 路由（config.providers，可 .env MIANSHI_PROVIDERS 配置任意 OpenAI 兼容端点）
  // 默认 = [主端点(OpenCode Go), 备用(官方 API)]；首个端点超时快速 failover 逻辑见下方
  // 设置中心配置的 key（settings llm_api_key）全局覆盖——面板配一次即可，无需改 .env
  const settingsKey = getSettingsApiKey();
  const settingsBaseUrl = getSettingsBaseUrl();
  const settingsModel = getSettingsModel();
  const endpoints = [];
  if (settingsBaseUrl) {
    // 设置中心显式指定了服务地址（如中转站/本地 ollama）：单端点、key/model 也可配。
    // 不再 fallback——地址是用户指定的，fallback 到别的服务 key 大概率不匹配且浪费超时
    endpoints.push({ url: settingsBaseUrl, key: settingsKey || config.apiKey, model: settingsModel || config.model, name: "custom" });
  } else if (config.providers?.length) {
    endpoints.push(...config.providers.map((p) => ({ url: p.baseUrl, key: settingsKey || p.apiKey, model: p.model, name: p.name })));
  }
  // 兜底：config.providers 缺失时退化为旧双端点逻辑（防旧版 config 缓存）
  if (!endpoints.length) {
    endpoints.push({ url: config.baseUrl, key: settingsKey || config.apiKey, model: config.model, name: "main" });
    if (config.fallbackBaseUrl && (settingsKey || config.fallbackApiKey)) {
      endpoints.push({ url: config.fallbackBaseUrl, key: settingsKey || config.fallbackApiKey, model: config.officialModel || config.model, name: "fallback" });
    }
  }

  let lastErr;
  const timeoutMs = pickTimeoutMs({ stream, maxTokens, timeout: opts.timeout });
  for (const ep of endpoints) {
    const body = {
      model: ep.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream,
    };
    if (tools?.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      // 超时定时器存活到整个 body 读取完成（含 json()/流读取）：网关发完 headers 后挂起也能被中止
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let delivered = false; // 流式是否已通过 onChunk 交付过内容（交付过再出错就不能重试/切端点，否则 UI 重复）
      try {
        const res = await fetch(`${ep.url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          const err = /** @type {RetryableError} */ (new Error(`LLM ${res.status}@${ep.url}`));
          err.retryable = true;
          throw err;
        }
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          const err = /** @type {RetryableError} */ (new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`));
          err.retryable = false;
          err.statusCode = res.status === 401 || res.status === 403 ? 502 : 500; // 上游认证/鉴权失败 → 502（网关错误），其余 500
          throw err;
        }
        if (stream) {
          // SSE 流式：网关不支持流式时一次性返回
          const ctype = res.headers.get("content-type") || "";
          if (!ctype.includes("text/event-stream")) {
            const data = await res.json();
            const full = getReplyText(data);
            // 空响应（HTTP 200 + 空 content）与 SSE 零 delta 一样，都视为可重试（复用空响应重试链）
            if (!full) {
              const err = /** @type {RetryableError} */ (new Error("LLM empty response"));
              err.retryable = true;
              throw err;
            }
            if (onChunk) onChunk(full);
            return full;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buf = "";
          let full = "";
          // 流式工具调用累积（index → 分段拼接 id/name/arguments）——"流式 + 工具调用共存"核心
          const toolCalls = new Map();
          // 处理一个完整 SSE 事件（可能含多行 data:）
          const parseEvent = (eventText) => {
            for (const line of eventText.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const j = JSON.parse(data);
                const delta = j?.choices?.[0]?.delta || {};
                if (delta.content) {
                  full += delta.content;
                  delivered = true;
                  if (onChunk) onChunk(delta.content);
                }
                if (Array.isArray(delta.tool_calls)) {
                  delivered = true;
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const cur = toolCalls.get(idx) || { id: "", name: "", arguments: "" };
                    if (tc.id) cur.id += tc.id;
                    if (tc.function?.name) cur.name += tc.function.name;
                    if (tc.function?.arguments) cur.arguments += tc.function.arguments;
                    toolCalls.set(idx, cur);
                  }
                }
              } catch { /* ignore */ }
            }
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            // 兼容 LF 与 CRLF 事件分隔（\n\n 与 \r\n\r\n 都能匹配）
            const sep = /\r?\n\r?\n/;
            let m;
            while ((m = sep.exec(buf)) !== null) {
              const event = buf.slice(0, m.index);
              buf = buf.slice(m.index + m[0].length);
              parseEvent(event);
            }
          }
          // 流结束：flush 剩余缓冲区（末尾无空行的完整 data: 事件不被丢弃）
          parseEvent(buf);
          // 工具调用响应（流式累积）→ 返回与 llmChat 一致的 {choices:[{message:{content, tool_calls}}]} 结构
          if (toolCalls.size > 0) {
            const calls = [...toolCalls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, v]) => ({
                id: v.id || `call_${Date.now().toString(36)}`,
                type: "function",
                function: { name: v.name || "unknown", arguments: v.arguments || "{}" },
              }));
            return { choices: [{ message: { role: "assistant", content: full || null, tool_calls: calls } }] };
          }
          // SSE 零 delta.content → 视为可重试（与网关空响应同源问题：HTTP 200 但无有效内容）
          if (!full) {
            const err = /** @type {RetryableError} */ (new Error("LLM empty response"));
            err.retryable = true;
            throw err;
          }
          return full;
        }
        const data = await res.json();
        // 网关偶发空响应：HTTP 200 + message.content 为空且无 tool_calls → 视为可重试（走重试/failover 链）
        // 否则下游会静默拿到空回复（对话空白/讲解为空/评测 judge 全 0）
        const msg = data?.choices?.[0]?.message;
        if (msg && !msg.tool_calls?.length && (msg.content === undefined || msg.content === null || msg.content === "")) {
          const err = /** @type {RetryableError} */ (new Error("LLM empty response"));
          err.retryable = true;
          throw err;
        }
        return data;
      } catch (e) {
        lastErr = e;
        // 流式已交付部分内容后再出错：不能重试/切端点（会重复交付已显示的内容），交给上层处理
        if (stream && delivered) throw e;
        const retryable = e.retryable || e.name === "AbortError" || e.name === "TypeError" || e.message.includes("fetch failed");
        // 挂起场景快速 failover：超时（AbortError）说明网关无响应，不重试直接切备用端点
        // （重试只用于 429/5xx 瞬时错误和空响应——那可能是偶发抖动）
        if (e.name === "AbortError" && endpoints.length > 1 && ep === endpoints[0]) {
          console.log(`[llm] 主端点 ${ep.url} 超时无响应(${timeoutMs / 1000}s)，快速切换备用端点`);
          break;
        }
        if (retryable && attempt < MAX_RETRIES) {
          // 推理模型预算不足导致的空响应：自动加 max_tokens 预算再试（比盲目 failover 有效）
          if (e.message === "LLM empty response" && body.max_tokens < 4096) {
            body.max_tokens = Math.min(body.max_tokens * 2, 8192);
            console.log(`[llm] 空响应，max_tokens 翻倍至 ${body.max_tokens} 重试（推理模型预算不足？）`);
          }
          // 退避：1s/2s/3s
          await new Promise((r) => setTimeout(r, attempt * 1000));
          continue;
        }
        if (endpoints.length > 1 && ep !== endpoints[endpoints.length - 1]) {
          // 主端点失败且还有备用 → 切备用（记日志带原因）
          console.log(`[llm] 主端点 ${ep.url} 失败，降级备用端点（${String(e.message).slice(0, 120)}）`);
          break; // 进入下一个端点
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastErr;
}

/**
 * 调用 chat/completions（非流式）
 * @param {Array<{role: string, content?: string}>} messages
 * @param {Object} [opts] { maxTokens?: number, temperature?: number, json?: boolean, role?: string, tools?: Array, toolChoice?: string, timeout?: number }
 * @returns {Promise<LLMResponse>}
 */
export async function llmChat(messages, opts = {}) {
  const start = Date.now();
  try {
    const data = /** @type {LLMResponse} */ (await llmFetch(messages, opts, false));
    // 可观测性：记录调用（token 从 usage 取）
    try {
      const usage = data?.usage || {};
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({
        role: opts.role || "agent",
        model: config.model,
        inputTokens: usage.prompt_tokens ?? null,
        outputTokens: usage.completion_tokens ?? null,
        durationMs: Date.now() - start,
        ok: true,
        endpoint: config.baseUrl,
      });
    } catch { /* ignore */ }
    // 评测期计数（Phase 评测 W2：按用途 tag 分账）
    try {
      const usage = data?.usage || {};
      recordEval({
        ts: Date.now(), tag: opts.tag || "misc", ok: true,
        inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null,
        durationMs: Date.now() - start, model: config.model,
      });
    } catch { /* ignore */ }
    // Hooks：llm_done（fire-and-forget）
    try {
      const { emitHook } = await import("./hooks.mjs");
      emitHook("llm_done", { role: opts.role || "agent", ok: true, durationMs: Date.now() - start }).catch(() => {});
    } catch { /* ignore */ }
    return data;
  } catch (e) {
    // 记录失败
    try {
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({ role: opts.role || "agent", model: config.model, durationMs: Date.now() - start, ok: false, error: e.message });
    } catch { /* ignore */ }
    // 评测期计数（失败也记录：failCount 归因）
    try {
      recordEval({ ts: Date.now(), tag: opts.tag || "misc", ok: false, inputTokens: null, outputTokens: null, durationMs: Date.now() - start, model: config.model });
    } catch { /* ignore */ }
    try {
      const { emitHook } = await import("./hooks.mjs");
      emitHook("llm_done", { role: opts.role || "agent", ok: false, error: String(e.message || "").slice(0, 200), durationMs: Date.now() - start }).catch(() => {});
    } catch { /* ignore */ }
    throw e;
  }
}

/** 取回复文本
 * @param {LLMResponse|null|undefined} data
 * @returns {string}
 */
export function getReplyText(data) {
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * 流式调用 chat/completions（SSE，带 failover）
 * @param {Array} messages
 * @param {Object} opts { maxTokens, temperature }
 * @param {(delta: string) => void} onChunk 每收到一段文本回调
 * @returns {Promise<string>} 完整文本
 */
export async function llmChatStream(messages, opts = {}, onChunk) {
  const start = Date.now();
  try {
    const full = /** @type {string} */ (await llmFetch(messages, opts, true, onChunk));
    try {
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({
        role: opts.role || "agent",
        model: config.model,
        stream: true,
        outputTokens: full ? Math.round(full.length / 4) : null, // 流式无 usage，估算
        durationMs: Date.now() - start,
        ok: true,
        endpoint: config.baseUrl,
      });
    } catch { /* ignore */ }
    return full;
  } catch (e) {
    try {
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({ role: opts.role || "agent", model: config.model, stream: true, durationMs: Date.now() - start, ok: false, error: e.message });
    } catch { /* ignore */ }
    throw e;
  }
}

/** 从回复中提取 JSON（兼容代码块/前后缀） */
export function extractJson(raw) {
  if (!raw) return null;
  const text = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}
