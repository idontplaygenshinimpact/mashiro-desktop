// 契约层 · 学习清单域
import { z } from "zod";

/** /api/study-plan GET 出参（items 宽松：字段随功能演进，契约守住骨架） */
export const StudyPlanOutput = z.object({
  ok: z.literal(true),
  plan: z.object({
    date: z.string(),
    items: z.array(z.any()),
  }),
});

/** /api/study-check POST（query 驱动）入参 */
export const StudyCheckInput = z.object({
  id: z.string().min(1).max(64),
  done: z.union([z.literal("1"), z.literal("0")]).optional(),
});

/** /api/study-check POST 出参（情感反馈随勾选状态变化） */
export const StudyCheckOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  item: z.any().optional(),
  emotion: z.string().nullable().optional(),
  emotionScene: z.string().nullable().optional(),
});