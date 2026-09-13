// lib/tools/exec-utils.ts —— 工具执行基础设施（纵向拆分：从 lib/agent.mjs 迁出）
// withRetry（Repair：失败重试+降级提示）/ isTransientError（瞬时错误分类）/
// toolResultContent（超长结果落盘 + 预览回填）

/** 瞬时错误对象（携带 retryable 标记的错误，如 llm.mjs 标记的 429/5xx/空响应） */
interface TransientErrorLike {
  retryable?: boolean;
  name?: string;
  message?: string;
}

/**
 * 瞬时错误分类：只重试网络/超时/5xx/空响应类，本地 fs/校验等永久错误不重试（避免昂贵的重复 LLM 调用）
 * @param e 错误对象（Error 或任意值）
 * @returns 是否瞬时错误（可重试）
 */
export function isTransientError(e: unknown): boolean {
  if (!e) return false;
  const err = e as TransientErrorLike;
  if (err.retryable === true) return true; // llm.mjs 标记的 429/5xx/空响应
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const msg = String(err.message || "");
  if (/fetch failed|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|socket hang up|timeout|timed out/i.test(msg)) return true;
  if (/^LLM \d{3}@/.test(msg)) return true; // 端点 429/5xx 错误（无 retryable 标记时兜底）
  return false;
}

/**
 * Repair：失败重试（带退避），仍失败返回可操作的降级信息
 * @param fn 执行函数（无参）
 * @param retries 重试次数
 * @returns 成功返回 fn 结果；失败返回 {error, hint?}
 */
export async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T | { error: string; hint?: string }> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // 非瞬时错误（本地 fs/校验等永久错误）立即放弃，不做无谓的昂贵重试
      if (!isTransientError(e)) {
        return { error: `执行失败: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  // 瞬时错误重试耗尽 → 降级提示：告诉 LLM 换个方式（换站/换关键词）
  return {
    error: `执行失败（已重试）: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    hint: "可以尝试：换一个关键词重新搜索，或换 site 参数（nowcoder/juejin/csdn）",
  };
}

/**
 * 工具结果回填：超长结果落盘 + 回填预览（替代硬截断，对标 Claude Code toolResultStorage 思路）
 * 超限结果写 data/tool_results/，回填 2KB 预览，避免塞爆上下文同时不丢信息
 * @param result 工具结果对象
 * @param toolCallId 工具调用 id（文件名后缀）
 * @returns JSON 字符串（超长时含 _truncated/_file/_preview 标记）
 */
export async function toolResultContent(result: unknown, toolCallId: string): Promise<string> {
  const json = JSON.stringify(result);
  if (json.length <= 8000) return json;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "..", "data"), "tool_results");
    mkdirSync(dir, { recursive: true });
    const fname = `${Date.now().toString(36)}_${String(toolCallId).slice(0, 8)}.json`;
    writeFileSync(path.join(dir, fname), json, "utf8");
    return JSON.stringify({ ...(result as Record<string, unknown>), _truncated: true, _file: `data/tool_results/${fname}`, _preview: json.slice(0, 2000) });
  } catch {
    return json.slice(0, 8000); // 落盘失败退回截断
  }
}
