// 契约层 · 杂项（设置/面试历史等）
import { z } from "zod";

/** /api/settings/rag POST 入参 */
export const RagSettingsInput = z.object({
  enabled: z.boolean(),
});

/** /api/settings/rag POST 出参 */
export const RagSettingsOutput = z.object({
  ok: z.boolean(),
  enabled: z.boolean().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

/** /api/interview/history GET 出参 */
export const InterviewHistoryOutput = z.object({
  ok: z.literal(true),
  history: z.array(z.any()),
});

/** /api/pet-events GET 出参（桌宠伴侣表达队列 drain：取走即清空） */
export const PetEventsOutput = z.object({
  ok: z.literal(true),
  events: z.array(z.object({
    text: z.string(),
    scene: z.string(),
    level: z.string(),
  })),
});