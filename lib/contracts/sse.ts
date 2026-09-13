// 契约层 · SSE 事件（Phase 2 §3.4：最易漂移的区域，单一 discriminated union）
// 三端（core.mjs / study.mjs / oj.mjs 生产 → preload streamPromise → renderer 消费）
// 全部收敛到本文件的事件形状；开发期开启 MIANSHI_SSE_STRICT=1 时 push 前校验，漂移即 console.error。
// zod 仅在此模块被运行时 import（服务端生产 push / 测试）；renderer 侧用 import type 零运行时开销。
import { z } from "zod";

/** 通用 SSE 事件（无 type 字段外的公共字段） */
export const SSEStart = z.object({ type: z.literal("start") });
export const SSEDelta = z.object({ type: z.literal("delta"), delta: z.string() });
export const SSEError = z.object({ type: z.literal("error"), error: z.string() });

/** 进度事件（oj/collect-all 等：done/total 为整数，title 展示用） */
export const SSEProgress = z.object({
  type: z.literal("progress"),
  done: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  title: z.string(),
});

/** 完成事件（按端点收敛：否认必须字段类型，允许扩展字段 strip） */
export const SSEDone = z.object({
  type: z.literal("done"),
  reply: z.string().optional(),
  saved: z.boolean().optional(),
  filePath: z.string().optional(),
  topic: z.string().optional(),
  hint: z.string().optional(),
  question: z.string().optional(),
  history: z.array(z.any()).optional(),
  clusterName: z.string().optional(),
});

/** 工具调用事件（chat-stream 专用：start/done/error 三态） */
export const SSEToolStart = z.object({ type: z.literal("tool_start"), name: z.string() });
export const SSEToolDone = z.object({ type: z.literal("tool_done"), name: z.string(), output: z.string().optional() });
export const SSEToolError = z.object({ type: z.literal("tool_error"), name: z.string(), error: z.string() });

/** agent 完成事件（chat-stream 专用） */
export const SSEAgentDone = z.object({
  type: z.literal("agent_done"),
  reply: z.string(),
  voice: z.string().optional(),
  rounds: z.number().int().nonnegative().optional(),
  interrupted: z.boolean().optional(),
});

/** 通用 SSE 事件 union（不含 chat 专用的 tool/agent 事件） */
export const SSEEvent = z.discriminatedUnion("type", [
  SSEStart,
  SSEDelta,
  SSEProgress,
  SSEDone,
  SSEError,
]);

/** 追问缓存命中事件（study-append-stream：直接复用缓存作答，不调用 LLM） */
export const SSECache = z.object({
  type: z.literal("cache"),
  hit: z.boolean(),
  similarity: z.number().optional(),
  cachedQuestion: z.string().optional(),
});

/** chat-stream 事件 union（含工具/agent 扩展） */
export const ChatStreamEvent = z.union([SSEStart, SSEDelta, SSEProgress, SSEDone, SSEError, SSEToolStart, SSEToolDone, SSEToolError, SSEAgentDone]);

/** study/review/oj 等普通流事件 union（无 chat 专用的 tool 与 agent_done 两类扩展事件） */
export const StudyStreamEvent = z.union([SSEStart, SSEDelta, SSEProgress, SSECache, SSEDone, SSEError]);
