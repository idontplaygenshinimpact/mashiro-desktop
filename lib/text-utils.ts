// 文本/异步工具收敛（技术债 L3：smartSlice/withTimeout/clean 多处重复定义——收敛单点）
// 背景：smartSlice 2 处（study-plan/study-review）、withTimeout 2 处（mail/rss）、
// clean 3 处（jobs/job-collect/zhenti）逐字相同——修复经验/口径分散，改一处漏一处。
// 全量 TS 升级工单阶段 1④：lib/text-utils.ts → .ts（叶子模块；withTimeout 泛型化保住 resolve 的值类型）

/** 智能截断：保留头部（结论/原理区）+ 尾部（最近追问/补充区），中间省略
 * 结构是"结论/原理/代码"开头 + 追问追加在尾部 → 保留头部 + 尾部，中间省略 */
export function smartSlice(text: string | null | undefined, max = 8000): string {
  if (!text) return "";
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.35);   // 头部（结论/原理区）
  const tail = max - head;               // 尾部（最近追问/补充区）
  return `${text.slice(0, head)}\n\n……（中间省略 ${text.length - max} 字）……\n\n${text.slice(-tail)}`;
}

/** 兜底超时（Promise.race 包装；onTimeout 可选——超时触发时尝试关闭底层连接防 socket 泄漏）
 * 泛型 T 让调用方拿到原 Promise 的解析类型（原 .mjs 无类型，迁移后不丢信息） */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error("超时"));
      try { onTimeout?.(); } catch { /* ignore */ }
    }, ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/** 文本清理：trim + 截断（max 默认 100） */
export function clean(s: unknown, max?: number): string { return String(s || "").trim().slice(0, max || 100); }
