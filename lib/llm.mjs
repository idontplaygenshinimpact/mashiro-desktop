// 统一 LLM 调用客户端：重试 + 超时 + 错误分类 + 端点 failover
// 所有模块（agent/interview/study/ai）共用，避免各自实现不一致
import { config } from "../config.mjs";

const DEFAULT_TIMEOUT = 120000; // 单次调用超时 2 分钟
const MAX_RETRIES = 3;

/**
 * 带 failover 的 chat/completions 调用
 * @param {Array} messages
 * @param {Object} opts { maxTokens, temperature, tools, toolChoice }
 * @param {boolean} stream SSE 模式（内部读取流，返回完整文本 + onChunk 回调）
 * @param {(delta)=>void} onChunk 流式回调
 * @returns {Promise<object|string>} 非流式返回完整 json；流式返回完整文本
 */
async function llmFetch(messages, opts = {}, stream = false, onChunk = null) {
  const { maxTokens = 4000, temperature = 0.4, tools, toolChoice } = opts;
  const body = {
    model: config.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream,
  };
  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  // 端点列表：主 → 备用（failover）
  const endpoints = [{ url: config.baseUrl, key: config.apiKey }];
  if (config.fallbackBaseUrl && config.fallbackApiKey) {
    endpoints.push({ url: config.fallbackBaseUrl, key: config.fallbackApiKey });
  }

  let lastErr;
  for (const ep of endpoints) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeout || DEFAULT_TIMEOUT);
        let res;
        try {
          res = await fetch(`${ep.url}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (res.status === 429 || res.status >= 500) {
          const err = new Error(`LLM ${res.status}@${ep.url}`);
          err.retryable = true;
          throw err;
        }
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          const err = new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`);
          err.retryable = false;
          throw err;
        }
        if (stream) {
          // SSE 流式：网关不支持流式时一次性返回
          const ctype = res.headers.get("content-type") || "";
          if (!ctype.includes("text/event-stream")) {
            const data = await res.json();
            const full = getReplyText(data);
            if (onChunk) onChunk(full);
            return full;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buf = "";
          let full = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const event = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of event.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                try {
                  const j = JSON.parse(data);
                  const delta = j?.choices?.[0]?.delta?.content ?? "";
                  if (delta) { full += delta; if (onChunk) onChunk(delta); }
                } catch { /* ignore */ }
              }
            }
          }
          return full;
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        const retryable = e.retryable || e.name === "AbortError" || e.name === "TypeError" || e.message.includes("fetch failed");
        if (retryable && attempt < MAX_RETRIES) {
          // 退避：1s/2s/3s
          await new Promise((r) => setTimeout(r, attempt * 1000));
          continue;
        }
        if (endpoints.length > 1 && ep !== endpoints[endpoints.length - 1]) {
          // 主端点失败且还有备用 → 切备用（记日志）
          console.log(`[llm] 主端点 ${ep.url} 失败，降级备用端点`);
          break; // 进入下一个端点
        }
        throw e;
      }
    }
  }
  throw lastErr;
}

/**
 * 调用 chat/completions（非流式）
 * @param {Array} messages
 * @param {Object} opts { maxTokens, temperature, tools, toolChoice }
 */
export async function llmChat(messages, opts = {}) {
  const start = Date.now();
  try {
    const data = await llmFetch(messages, opts, false);
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
    return data;
  } catch (e) {
    // 记录失败
    try {
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({ role: opts.role || "agent", model: config.model, durationMs: Date.now() - start, ok: false, error: e.message });
    } catch { /* ignore */ }
    throw e;
  }
}

/** 取回复文本 */
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
    const full = await llmFetch(messages, opts, true, onChunk);
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
