// 契约层 · 通用原语（Phase 2：API 契约层与前后端类型化）
// 唯一事实源：lib/routes（服务端）与 preload/renderer（客户端）通过 import type 消费，
// 运行时只有真正 import 运行时 schema 的端才打包 zod。
// 注意：这些 schema 同时是错误格式/分页/ID 等跨域复用的基础件。
import { z } from "zod";

/** ISO 8601 时间（带偏移或 Z）——跨端统一表示时间戳写接口 */
export const DateTimeString = z.string().datetime({ offset: true });

/** Unix 毫秒时间戳 */
export const Timestamp = z.number().int().nonnegative();

/** 通用 ID（路由/实体 id，最长 64 符——与现有 id 生成口径对齐） */
export const EntityId = z.string().min(1).max(64);

/** 分页请求（默认第 1 页 / 每页 20，上限 100） */
export const PageQuery = z.object({
  page: z.number().int().min(1).default(1),
  size: z.number().int().min(1).max(100).default(20),
});

/** 结构化的校验 issue（path 支持数组下标）——out 给 400/500 的错误体 */
export const Issue = z.object({
  path: z.array(z.string().or(z.number())),
  message: z.string(),
});

/** 统一错误体：error 为机器码，issues 为结构化明细（兼容现状 `{error}` 单字段消费方） */
export const ErrorBody = z.object({
  error: z.string(),
  issues: z.array(Issue).optional(),
});

/** 简单成功壳（无响体的 POST/action 路由用） */
export const OkBody = z.object({ ok: z.literal(true) });
