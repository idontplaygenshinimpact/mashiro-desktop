// 通用管线运行器：把多阶段流程显式化（阶段可观测/可中断/可重试/可测试）
// 设计：
//   - 阶段 = { name, run(ctx), fatal? }：run 接收共享 ctx（中间产物 + 统计）
//   - 错误处理：非 fatal 阶段失败记入 ctx.errors 继续；fatal 阶段失败中断整个管线
//   - 可观测：onStage 回调（阶段进入/完成 + 耗时），stageTimings 记录每阶段耗时
//   - 与状态机的区别：管线是无环顺序流（每阶段恰好一次）；状态机处理多态流转/回退

/**
 * @typedef {Object} PipelineStage
 * @property {string} name 阶段名（观测/日志用）
 * @property {(ctx: Object) => Promise<void>|void} run 阶段执行体
 * @property {boolean} [fatal] 失败是否中断管线（默认 false：记录后继续）
 */

/**
 * 顺序执行管线
 * @param {PipelineStage[]} stages
 * @param {Object} ctx 共享上下文（中间产物、进度、统计）
 * @param {Object} [hooks]
 * @param {(stage: string, ctx: Object, ms: number) => void} [hooks.onStage] 每阶段完成回调（stage=阶段名, ms=耗时）
 * @param {(stage: string, error: Error, ctx: Object) => void} [hooks.onError] 阶段失败回调
 * @returns {Promise<Object>} ctx（含 stageTimings / errors）
 */
export async function runPipeline(stages, ctx, { onStage, onError } = {}) {
  ctx.stageTimings = ctx.stageTimings || {};
  ctx.errors = ctx.errors || [];
  for (const s of stages) {
    const t0 = Date.now();
    try {
      await s.run(ctx);
      ctx.stageTimings[s.name] = Date.now() - t0;
      if (onStage) onStage(s.name, ctx, ctx.stageTimings[s.name]);
    } catch (e) {
      const err = new Error(`${s.name} 阶段失败: ${e.message}`);
      ctx.errors.push({ stage: s.name, error: e.message });
      ctx.stageTimings[s.name] = Date.now() - t0;
      if (onError) onError(s.name, e, ctx);
      if (s.fatal) throw err;
      console.error(`[pipeline] ${s.name} 阶段失败（继续）: ${e.message.slice(0, 100)}`);
    }
  }
  return ctx;
}

/** 汇总管线执行摘要（展示/日志用） */
export function pipelineSummary(ctx) {
  const lines = [`管线完成：${Object.keys(ctx.stageTimings || {}).length} 个阶段`];
  for (const [name, ms] of Object.entries(ctx.stageTimings || {})) {
    lines.push(`  ${name}: ${(ms / 1000).toFixed(1)}s`);
  }
  if (ctx.errors?.length) {
    lines.push(`失败 ${ctx.errors.length} 处（非致命）:`);
    for (const e of ctx.errors) lines.push(`  - ${e.stage}: ${e.error.slice(0, 80)}`);
  }
  return lines.join("\n");
}
