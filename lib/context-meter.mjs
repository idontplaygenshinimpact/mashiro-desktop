// 上下文计量：对话中实时 token 用量（对标 DSH tokenMeter）
// 每轮 callLLM 前记录估算 tokens（中文 1:1 / 英文 4:1 字符粗估，与 compactMessages 同口径）
// 面板「运行监控」可看当前对话用量，避免"上下文到底还剩多少"的盲区
import { bodyTokens } from "./ai-compact.mjs";

const BUDGET = 64000; // 展示用参考窗口（deepseek-v4 系典型窗口量级；实际以模型为准）
const history = []; // 最近 N 次快照 {tokens, messages, at, rounds}

/** 记录一次快照（agent 每轮调用） */
export function recordContextUsage(messages, rounds = 0) {
  let tokens = 0;
  try { tokens = bodyTokens(messages); } catch { /* ignore */ }
  const snap = { tokens, messages: messages.length, at: Date.now(), rounds };
  history.push(snap);
  if (history.length > 50) history.shift();
  return snap;
}

/** 当前用量（最近一次快照 + 参考预算） */
export function getContextUsage() {
  const last = history[history.length - 1] || null;
  return {
    ok: true,
    budget: BUDGET,
    current: last ? last.tokens : 0,
    ratio: last ? Math.min(100, Math.round((last.tokens / BUDGET) * 100)) : 0,
    messages: last ? last.messages : 0,
    rounds: last ? last.rounds : 0,
    updatedAt: last ? last.at : null,
    history: history.slice(-10),
    hint: "token 为字符估算（中文 1:1 / 英文 4:1），达到 ~30% 触发上下文压缩",
  };
}

/** 测试隔离 */
export function resetContextMeter() {
  history.length = 0;
}
