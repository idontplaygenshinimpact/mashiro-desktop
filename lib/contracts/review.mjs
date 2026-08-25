// 契约层 · 间隔复习域
import { z } from "zod";

/** 复习卡卡片形状（FSRS 状态 + 记忆可视化字段） */
export const ReviewCard = z.object({
  id: z.string(),
  topic: z.string(),
  question: z.string(),
  answer: z.string(),
  source: z.string().optional(),
  memPct: z.number().nullable().optional(),
  stage: z.any().optional(),
  history: z.array(z.any()).default([]),
}).passthrough();

/** /api/review/add POST 入参 */
export const ReviewAddInput = z.object({
  topic: z.string().min(1).max(100),
  question: z.string().max(1000).optional().default(""),
  answer: z.string().max(1000).optional().default(""),
  source: z.string().max(100).optional().default(""),
});

/** /api/review/add POST 出参 */
export const ReviewAddOutput = z.object({
  ok: z.literal(true),
  card: ReviewCard.optional(),
});

/** /api/review/submit POST 入参 */
export const ReviewSubmitInput = z.object({
  id: z.string().min(1).max(64),
  rating: z.number().int().min(0).max(3),
});

/** /api/review/submit POST 出参（tip：学习计划即时反馈，可空） */
export const ReviewSubmitOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  card: ReviewCard.optional(),
  // nextDue 服务端是 Date 对象，JSON 序列化后为 ISO 字符串——两形态都接受（校验在序列化前发生）
  nextDue: z.union([z.date(), z.string()]).optional(),
  tip: z.string().nullable().optional(),
  emotion: z.string().nullable().optional(),
  emotionScene: z.string().optional(),
});

/** /api/review/due GET 出参 */
export const ReviewDueOutput = z.object({
  ok: z.literal(true),
  due: z.array(ReviewCard),
  stats: z.object({
    total: z.number().int().nonnegative(),
    due: z.number().int().nonnegative(),
    mastered: z.number().int().nonnegative(),
    learning: z.number().int().nonnegative(),
    todayDone: z.number().int().nonnegative(),
  }),
  trend: z.object({ trend: z.array(z.any()), streak: z.number().int().nonnegative() }),
  todayReviewed: z.array(z.object({ topic: z.string(), id: z.string() })),
});