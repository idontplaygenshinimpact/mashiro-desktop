// 契约层 · 模拟面试域
import { z } from "zod";

/** 通用结果壳（interview 各接口 ok/error 统一；扩展示例字段 passthrough 保留） */
export const InterviewResult = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
}).passthrough();

/** /api/interview/start POST 入参（全可选：缺省走画像/简历自动拉取） */
export const InterviewStartInput = z.object({
  position: z.string().max(100).optional(),
  role: z.string().max(50).optional(),
  resume: z.string().max(30000).optional(),
  focus: z.string().max(100).optional(),
});

/** /api/interview/answer POST 入参 */
export const InterviewAnswerInput = z.object({
  answer: z.string().min(1).max(30000),
});

/** /api/interview/status GET 出参 */
export const InterviewStatusOutput = z.object({
  ok: z.boolean(),
  active: z.boolean(),
  round: z.number().int().nonnegative().optional(),
  roundsCount: z.number().int().nonnegative().optional(),
}).passthrough();