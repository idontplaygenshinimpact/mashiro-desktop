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