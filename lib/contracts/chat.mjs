// 契约层 · 对话域（Phase 2 §2.2 示例落地）
import { z } from "zod";

/** 对话回合（跨会话记忆/前端回传 history 用） */
export const ChatTurn = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
}).passthrough();

/** /api/chat POST 入参 */
export const ChatInput = z.object({
  message: z.string().min(1).max(20000),
  history: z.array(z.any()).max(20).optional(),
  sessionId: z.string().max(64).optional(),
});

/** /api/chat POST 出参（非流式；流式见 sse.ChatStreamEvent） */
export const ChatOutput = z.object({
  reply: z.string(),
  voice: z.string().optional(),
  history: z.array(z.any()).max(10).optional(),
});

/** /api/chat/sessions GET 出参 */
export const ChatSessionListOutput = z.object({
  ok: z.literal(true),
  sessions: z.array(z.object({
    id: z.string(),
    count: z.number().int().nonnegative(),
    updatedAt: z.number(),
    title: z.string(),
  })),
});

/** /api/chat/messages GET 出参 */
export const ChatMessagesOutput = z.object({
  ok: z.literal(true),
  messages: z.array(z.object({ role: z.string(), content: z.string(), ts: z.number() })),
});

/** /api/chat/session DELETE 入参 */
export const ChatSessionDeleteInput = z.object({ id: z.string().min(1).max(64) });

/** /api/chat/session DELETE 出参（error 可选：删除失败时返回） */
export const ChatSessionDeleteOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
