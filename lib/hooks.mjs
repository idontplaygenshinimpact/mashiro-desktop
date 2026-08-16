// 轻量 Hooks 事件系统（对标 Claude Code hooks：PreToolUse / PostToolUse / Notification）
// 机制：注册表 + 异步 emit；监听器失败隔离（永不阻断主流程）
// 事件（阶段 1）：
//   before_tool  {toolName, args}            工具执行前（监听器可返回 {deny, reason} 拦截）
//   after_tool   {toolName, args, ok, error, durationMs}  工具执行后
//   llm_done     {role, ok, error, durationMs}  LLM 调用后
//   chat_done    {userMsg, reply}             一次对话完成后
// 用途：工具策略插件、通知、可观测性扩展——skills 插件机制的地基
const listeners = new Map(); // event -> Set<fn>

/**
 * 注册监听器，返回取消函数
 * @param {string} event
 * @param {(payload: any) => any | Promise<any>} fn
 */
export function onHook(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => { listeners.get(event)?.delete(fn); };
}

/**
 * 触发事件：串行执行所有监听器，收集返回值（before_tool 拦截语义靠返回值）
 * 监听器抛错只记日志，不影响其他监听器与主流程
 * @param {string} event
 * @param {object} [payload]
 * @returns {Promise<Array<any>>} 各监听器返回值（无监听器返回 []）
 */
export async function emitHook(event, payload = {}) {
  const set = listeners.get(event);
  if (!set || !set.size) return [];
  const results = [];
  for (const fn of [...set]) {
    try {
      results.push(await fn({ ...payload, event }));
    } catch (e) {
      console.log(`[hooks] ${event} 监听器异常: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  return results;
}

/** 当前注册概览（调试/面板展示） */
export function listHooks() {
  return [...listeners.entries()].map(([event, set]) => ({ event, count: set.size }));
}

/** 清除全部监听器（测试隔离用） */
export function clearHooks() {
  listeners.clear();
}
