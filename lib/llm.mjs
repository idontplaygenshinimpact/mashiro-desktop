// 统一 LLM 调用客户端：重试 + 超时 + 错误分类
// 所有模块（agent/interview/study/ai）共用，避免各自实现不一致
import { config } from "../config.mjs";

const DEFAULT_TIMEOUT = 120000; // 单次调用超时 2 分钟
const MAX_RETRIES = 3;

/**
 * 调用 chat/completions
 * @param {Array} messages
 * @param {Object} opts { maxTokens, temperature, tools, toolChoice }
 */
export async function llmChat(messages, opts = {}) {
  const { maxTokens = 4000, temperature = 0.4, tools, toolChoice } = opts;
  const body = {
    model: config.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (tools?.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeout || DEFAULT_TIMEOUT);
      let res;
      try {
        res = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`LLM ${res.status}`);
        err.retryable = true;
        throw err;
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`);
        err.retryable = false;
        throw err;
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
      throw e;
    }
  }
  throw lastErr;
}

/** 取回复文本 */
export function getReplyText(data) {
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * 流式调用 chat/completions（SSE）
 * @param {Array} messages
 * @param {Object} opts { maxTokens, temperature }
 * @param {(delta: string) => void} onChunk 每收到一段文本回调
 * @returns {Promise<string>} 完整文本
 */
export async function llmChatStream(messages, opts = {}, onChunk) {
  const { maxTokens = 4000, temperature = 0.4 } = opts;
  const body = {
    model: config.model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || DEFAULT_TIMEOUT);
  let full = "";
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`);
    }
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      // 网关不支持流式：一次性返回
      const data = await res.json();
      full = getReplyText(data);
      if (onChunk) onChunk(full);
      return full;
    }
    // 读 SSE 流
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // 按 \n\n 切事件
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
  } finally {
    clearTimeout(timer);
  }
}

/** 取工具调用列表 */
export function getToolCalls(data) {
  return data?.choices?.[0]?.message?.tool_calls ?? [];
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
