// 统一 LLM 调用客户端：重试 + 超时 + 错误分类 + 端点 failover
// 所有模块（agent/interview/study/ai）共用，避免各自实现不一致
// 全量 TS 升级工单叶子批次 R5：原 .mjs 为 @ts-strict + typedef JSDoc，迁 .ts 后转真实接口；
// lib/llm.mjs 保留为桶（60+ 调用方与 mock.module URL 零改动）
import { config } from "../config.mjs";
import { db } from "./db.mjs";

const DEFAULT_TIMEOUT = 120000; // 单次调用超时（流式长文保留 2 分钟）
const DEFAULT_TIMEOUT_NON_STREAM = 20000; // 非流式短任务（主端点慢/网关抖动时快速 failover）
const MAX_RETRIES = 3;

/** 调用 opts（档位 role 只影响默认参数，显式传参优先） */
export interface LLMChatOpts {
  maxTokens?: number;
  temperature?: number;
  tools?: Array<{ type?: string; function?: { name: string; description?: string; parameters?: unknown } }>;
  toolChoice?: string;
  timeout?: number;
  json?: boolean;
  role?: string;
  tag?: string;
}

/** LLM 追踪/评测条目（trace.mjs 埋点 + 评测计数共用形状） */
export interface LLMTraceInfo {
  role?: string;
  model?: string;
  stream?: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  ok?: boolean;
  error?: string | null;
  endpoint?: string | null;
}

/** OpenAI 兼容消息 */
export interface LLMMessage {
  role?: string;
  content?: string;
  tool_calls?: LLMToolCall[];
}

/** 工具调用 */
export interface LLMToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/** OpenAI 兼容响应（只读字段——getReplyText/extractJson 消费） */
export interface LLMResponse {
  choices: Array<{ message: LLMMessage }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** 可重试错误（llmFetch 标记 retryable：429/5xx/空响应；statusCode 归一为网关语义） */
export interface RetryableError extends Error {
  retryable?: boolean;
  statusCode?: number;
}

/**
 * 非流式超时选择（导出便于单测）：
 * - 长文生成（maxTokens >= 4000：复盘报告/学习清单/情报整理/批量打分）给足 120s——
 *   曾因 20s 默认值掐死复盘报告生成，用户点"结束面试"反复报 This operation was aborted
 * - 短任务（JSON 评分/追问等）保持 20s 快速 failover
 * - opts.timeout 显式指定时优先
 */
export function pickTimeoutMs({ stream, maxTokens = 0, timeout = 0 }: { stream?: boolean; maxTokens?: number; timeout?: number }): number {
  if (timeout) return timeout;
  if (stream) return DEFAULT_TIMEOUT;
  return maxTokens >= 4000 ? 120000 : DEFAULT_TIMEOUT_NON_STREAM;
}

/** 设置中心配置的 API key（settings llm_api_key > .env/环境变量/opencode；面板可改，开源友好） */
export function getSettingsApiKey(): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='llm_api_key'").get();
    return row?.value ? String(row.value).trim() : "";
  } catch {
    return "";
  }
}

/** 设置中心配置的 Base URL（settings llm_api_base_url；配了就用单端点，不盲目 fallback） */
export function getSettingsBaseUrl(): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='llm_api_base_url'").get();
    return row?.value ? String(row.value).trim() : "";
  } catch {
    return "";
  }
}

/** 设置中心配置的模型名（settings llm_api_model；留空用默认） */
export function getSettingsModel(): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='llm_api_model'").get();
    return row?.value ? String(row.value).trim() : "";
  } catch {
    return "";
  }
}

/** 实际命中端点（llmFetch 写入；架构 P1-2：审计真实 failover 目标） */
interface UsedEndpoint {
  url?: string;
  model?: string;
  name?: string;
}

// ---------- 评测期 LLM 指标（Phase 评测 W2：内存计数器，生产零落盘零费用） ----------
// 评测脚本 startEvalMetrics() 后，每次 llmChat 调用 push 一条 {ts,tag,ok,tokens,ms}；
// 结束 getEvalMetrics() 汇总（lib/eval-cost.mjs 做成本/延迟/分账）。不开启时无任何开销。
interface EvalMetricEntry {
  ts: number;
  tag: string;
  ok: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  model?: string;
}

const evalMetrics: EvalMetricEntry[] = [];
let evalEnabled = false;
/** 开始收集（清空历史） */
export function startEvalMetrics(): void { evalMetrics.length = 0; evalEnabled = true; }
/** 停止收集 */
export function stopEvalMetrics(): void { evalEnabled = false; }
/** 取收集结果（副本防外部篡改） */
export function getEvalMetrics(): EvalMetricEntry[] { return [...evalMetrics]; }
function recordEval(entry: EvalMetricEntry): void {
  if (evalEnabled) evalMetrics.push(entry);
}

/**
 * 带 failover 的 chat/completions 调用
 * @returns 非流式返回完整 json；流式返回完整文本（SSE 内部读取）
 */
async function llmFetch(messages: LLMMessage[], opts: LLMChatOpts = {}, stream = false, onChunk: ((delta: string) => void) | null = null, usedEp: UsedEndpoint | null = null): Promise<LLMResponse | string> {
  // 测试专用 mock（MIANSHI_MOCK_LLM=1）：集成测试 spawn widget 时启用——
  // CI 无真实 LLM（dummy key），LLM 路由测试需要稳定响应（如 study-append 的 saved:false 分支）
  // MIANSHI_MOCK_LLM=hang（流式链路故障注入工单任务 1）：返回永不 resolve 的 Promise——
  // 模拟 LLM 挂起，让路由的 withLLMTimeout 超时分支真实触发（此前超时路径永远测不到）
  if (process.env.MIANSHI_MOCK_LLM === "hang") {
    return new Promise(() => {}); // 永不 resolve/ reject——LLM 挂起
  }
  if (process.env.MIANSHI_MOCK_LLM === "1") {
    const mockText = "（mock LLM 响应）这是测试环境的固定回答内容，用于验证路由逻辑。";
    if (stream) {
      if (onChunk) onChunk(mockText);
      return mockText;
    }
    return { choices: [{ message: { role: "assistant", content: mockText } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  }
  // 推理模型（deepseek-v4-flash 带 reasoning）每次调用有固定推理开销（~30-50 token），
  // max_tokens 太小会连推理都不够 → content 被截断为空。下限抬到 96 保证 content 有输出。
  const MIN_OUTPUT_TOKENS = 96;
  // 编排能力缺口工单 T3：模型路由——按 role 分档（小任务便宜档 vs 大任务完整档）
  // 档位只影响默认参数（maxTokens/temperature 收紧），显式传参优先；端点尝试顺序不变（与 failover 兼容）
  const ROLE_TIER: Record<string, { maxTokens: number; temperature: number }> = {
    classify: { maxTokens: 800, temperature: 0.2 },  // 页面分类/挑帖
    refine: { maxTokens: 300, temperature: 0.3 },    // 自主精炼文案
    detect: { maxTokens: 800, temperature: 0.2 },    // 题目检测
    judge: { maxTokens: 500, temperature: 0 },      // 评测判官
    outline: { maxTokens: 1500, temperature: 0.3 },  // 讲解大纲
    "self-judge": { maxTokens: 300, temperature: 0 }, // 讲解自评
    // 完整档（默认 4000/0.4）：agent/solve/interview/review/loop/subagent/quiz 等
  };
  let { maxTokens, temperature = 0.4, tools, toolChoice } = opts;
  const tier = opts.role ? ROLE_TIER[opts.role] : undefined;
  if (tier) {
    if (maxTokens === undefined) maxTokens = tier.maxTokens;
    temperature = tier.temperature;
  }
  if (maxTokens === undefined) maxTokens = 4000;
  maxTokens = Math.max(maxTokens, MIN_OUTPUT_TOKENS);

  // 端点列表：多 provider 路由（config.providers，可 .env MIANSHI_PROVIDERS 配置任意 OpenAI 兼容端点）
  // 默认 = [主端点(OpenCode Go), 备用(官方 API)]；首个端点超时快速 failover 逻辑见下方
  // 设置中心配置的 key（settings llm_api_key）全局覆盖——面板配一次即可，无需改 .env
  const settingsKey = getSettingsApiKey();
  const settingsBaseUrl = getSettingsBaseUrl();
  const settingsModel = getSettingsModel();
  const endpoints: Array<{ url: string; key: string; model: string; name: string }> = [];
  if (settingsBaseUrl) {
    // 设置中心显式指定了服务地址（如中转站/本地 ollama）：单端点、key/model 也可配。
    // 不再 fallback——地址是用户指定的，fallback 到别的服务 key 大概率不匹配且浪费超时
    endpoints.push({ url: settingsBaseUrl, key: settingsKey || config.apiKey, model: settingsModel || config.model, name: "custom" });
  } else if (config.providers?.length) {
    endpoints.push(...config.providers.map((p: { baseUrl: string; apiKey: string; model: string; name: string }) => ({ url: p.baseUrl, key: settingsKey || p.apiKey, model: p.model, name: p.name })));
  }
  // 兜底：config.providers 缺失时退化为旧双端点逻辑（防旧版 config 缓存）
  if (!endpoints.length) {
    endpoints.push({ url: config.baseUrl, key: settingsKey || config.apiKey, model: config.model, name: "main" });
    if (config.fallbackBaseUrl && (settingsKey || config.fallbackApiKey)) {
      endpoints.push({ url: config.fallbackBaseUrl, key: settingsKey || config.fallbackApiKey, model: config.officialModel || config.model, name: "fallback" });
    }
  }

  let lastErr: unknown;
  const timeoutMs = pickTimeoutMs({ stream, maxTokens, timeout: opts.timeout });
  // 架构 P1-2：记录实际使用的端点/模型（failover 后审计真实降级目标——而非恒记主端点）
  const markUsed = (ep: { url: string; model: string; name: string }) => {
    if (usedEp) { usedEp.url = ep.url; usedEp.model = ep.model; usedEp.name = ep.name; }
  };
  for (const ep of endpoints) {
    const body: Record<string, unknown> = {
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
          const err = new Error(`LLM ${res.status}@${ep.url}`) as RetryableError;
          err.retryable = true;
          throw err;
        }
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          const err = new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`) as RetryableError;
          err.retryable = false;
          // 上游认证/鉴权/余额不足（401/403/402）→ 502（网关错误，客户端可感知"上游拒绝"而非"服务崩溃"）；其余 500
          err.statusCode = res.status === 401 || res.status === 403 || res.status === 402 ? 502 : 500;
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
              const err = new Error("LLM empty response") as RetryableError;
              err.retryable = true;
              throw err;
            }
            if (onChunk) onChunk(full);
            markUsed(ep);
            return full;
          }
          // content-type 已确认 event-stream，body 必在（非流式一次性返回已在上方处理）
          const reader = res.body!.getReader();
          const decoder = new TextDecoder("utf-8");
          let buf = "";
          let full = "";
          // 流式工具调用累积（index → 分段拼接 id/name/arguments）——"流式 + 工具调用共存"核心
          const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
          // 处理一个完整 SSE 事件（可能含多行 data:）
          const parseEvent = (eventText: string) => {
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
            markUsed(ep);
            return { choices: [{ message: { role: "assistant", content: full || null, tool_calls: calls } }] } as LLMResponse;
          }
          // SSE 零 delta.content → 视为可重试（与网关空响应同源问题：HTTP 200 但无有效内容）
          if (!full) {
            const err = new Error("LLM empty response") as RetryableError;
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
          const err = new Error("LLM empty response") as RetryableError;
          err.retryable = true;
          throw err;
        }
        markUsed(ep);
        return data;
      } catch (e) {
        lastErr = e;
        const err = e as RetryableError;
        // 流式已交付部分内容后再出错：不能重试/切端点（会重复交付已显示的内容），交给上层处理
        if (stream && delivered) throw e;
        const retryable = err.retryable || err.name === "AbortError" || err.name === "TypeError" || err.message.includes("fetch failed");
        // 挂起场景快速 failover：超时（AbortError）说明网关无响应，不重试直接切备用端点
        // （重试只用于 429/5xx 瞬时错误和空响应——那可能是偶发抖动）
        if (e instanceof Error && e.name === "AbortError" && endpoints.length > 1 && ep === endpoints[0]) {
          console.log(`[llm] 主端点 ${ep.url} 超时无响应(${timeoutMs / 1000}s)，快速切换备用端点`);
          break;
        }
        if (retryable && attempt < MAX_RETRIES) {
          // 推理模型预算不足导致的空响应：自动加 max_tokens 预算再试（比盲目 failover 有效）
          if (err.message === "LLM empty response" && (body.max_tokens as number) < 4096) {
            body.max_tokens = Math.min((body.max_tokens as number) * 2, 8192);
            console.log(`[llm] 空响应，max_tokens 翻倍至 ${body.max_tokens} 重试（推理模型预算不足？）`);
          }
          // 退避：1s/2s/3s
          await new Promise((r) => setTimeout(r, attempt * 1000));
          continue;
        }
        if (endpoints.length > 1 && ep !== endpoints[endpoints.length - 1]) {
          // 主端点失败且还有备用 → 切备用（记日志带原因）
          console.log(`[llm] 主端点 ${ep.url} 失败，降级备用端点（${String(err.message).slice(0, 120)}）`);
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
 * @returns LLMResponse（OpenAI 兼容结构）
 */
export async function llmChat(messages: LLMMessage[], opts: LLMChatOpts = {}): Promise<LLMResponse> {
  const start = Date.now();
  const usedEp: UsedEndpoint = {}; // 架构 P1-2：实际命中端点（llmFetch 写入）——审计真实 failover 目标
  try {
    const data = (await llmFetch(messages, opts, false, null, usedEp)) as LLMResponse;
    // 可观测性：记录调用（token 从 usage 取；endpoint/model 用实际命中值——非恒记主端点）
    try {
      const usage = data?.usage || {};
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({
        role: opts.role || "agent",
        model: usedEp.model || config.model,
        inputTokens: usage.prompt_tokens ?? null,
        outputTokens: usage.completion_tokens ?? null,
        durationMs: Date.now() - start,
        ok: true,
        endpoint: usedEp.url || config.baseUrl,
      });
    } catch { /* ignore */ }
    // 评测期计数（Phase 评测 W2：按用途 tag 分账）
    try {
      const usage = data?.usage || {};
      recordEval({
        ts: Date.now(), tag: opts.tag || "misc", ok: true,
        inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null,
        durationMs: Date.now() - start, model: usedEp.model || config.model,
      });
    } catch { /* ignore */ }
    // Hooks：llm_done（fire-and-forget）
    try {
      const { emitHook } = await import("./hooks.ts");
      emitHook("llm_done", { role: opts.role || "agent", ok: true, durationMs: Date.now() - start }).catch(() => {});
    } catch { /* ignore */ }
    return data;
  } catch (e) {
    // 记录失败（endpoint 记最后尝试值——审计真实 failover 目标）
    try {
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({ role: opts.role || "agent", model: usedEp.model || config.model, durationMs: Date.now() - start, ok: false, error: e instanceof Error ? e.message : String(e), endpoint: usedEp.url || null });
    } catch { /* ignore */ }
    // 评测期计数（失败也记录：failCount 归因）
    try {
      recordEval({ ts: Date.now(), tag: opts.tag || "misc", ok: false, inputTokens: null, outputTokens: null, durationMs: Date.now() - start, model: usedEp.model || config.model });
    } catch { /* ignore */ }
    try {
      const { emitHook } = await import("./hooks.ts");
      emitHook("llm_done", { role: opts.role || "agent", ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200), durationMs: Date.now() - start }).catch(() => {});
    } catch { /* ignore */ }
    throw e;
  }
}

/** 取回复文本 */
export function getReplyText(data: LLMResponse | null | undefined): string {
  return data?.choices?.[0]?.message?.content ?? "";
}

/**
 * 流式调用 chat/completions（SSE，带 failover）
 * @returns 完整文本；流式工具调用路径返回 {choices:[{message:{content, tool_calls}}]}（与 llmChat 一致）
 */
export async function llmChatStream(messages: LLMMessage[], opts: LLMChatOpts = {}, onChunk: ((delta: string) => void) | null = null): Promise<string | LLMResponse> {
  const start = Date.now();
  const usedEp: UsedEndpoint = {}; // 架构 P1-2：实际命中端点（llmFetch 写入）——审计真实 failover 目标
  try {
    const full = (await llmFetch(messages, opts, true, onChunk, usedEp)) as string | LLMResponse;
    try {
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({
        role: opts.role || "agent",
        model: usedEp.model || config.model,
        stream: true,
        outputTokens: typeof full === "string" ? Math.round(full.length / 4) : null, // 流式无 usage，估算
        durationMs: Date.now() - start,
        ok: true,
        endpoint: usedEp.url || config.baseUrl,
      });
    } catch { /* ignore */ }
    // 架构 P1-6：流式完成也发 llm_done hook（对齐 llmChat——完成/失败都通知，观察者靠 hook 收口）
    try {
      const { emitHook } = await import("./hooks.ts");
      emitHook("llm_done", { role: opts.role || "agent", ok: true, stream: true, durationMs: Date.now() - start }).catch(() => {});
    } catch { /* ignore */ }
    return full;
  } catch (e) {
    try {
      const { traceLLM } = await import("./trace.mjs");
      traceLLM({ role: opts.role || "agent", model: usedEp.model || config.model, stream: true, durationMs: Date.now() - start, ok: false, error: e instanceof Error ? e.message : String(e), endpoint: usedEp.url || null });
    } catch { /* ignore */ }
    // 架构 P1-6：流式失败也发 llm_done hook
    try {
      const { emitHook } = await import("./hooks.ts");
      emitHook("llm_done", { role: opts.role || "agent", ok: false, stream: true, error: String(e instanceof Error ? e.message : e).slice(0, 200), durationMs: Date.now() - start }).catch(() => {});
    } catch { /* ignore */ }
    throw e;
  }
}

/** 从回复中提取 JSON（兼容代码块/前后缀）——全库唯一实现（L1：4 处重复定义统一收敛，防漂移）
 * JSON 解析边界：与 JSON.parse 同口径返回 any（原始契约即 any——调用方自行收窄校验） */
export function extractJson(raw: unknown): any {
  if (!raw) return null;
  const text = String(raw).replace(/```json|```/g, "").trim();
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
