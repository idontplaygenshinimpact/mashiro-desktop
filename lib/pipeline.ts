// 通用管线运行器：把多阶段流程显式化（阶段可观测/可中断/可重试/可测试）
// 设计：
//   - 阶段 = { name, run(ctx), fatal? }：run 接收共享 ctx（中间产物 + 统计）
//   - 错误处理：非 fatal 阶段失败记入 ctx.errors 继续；fatal 阶段失败中断整个管线
//   - 可观测：onStage 回调（阶段进入/完成 + 耗时），stageTimings 记录每阶段耗时
//   - 与状态机的区别：管线是无环顺序流（每阶段恰好一次）；状态机处理多态流转/回退

/** 管线阶段：{ name, run(ctx), fatal? }——run 接收共享 ctx（中间产物 + 统计） */
export interface PipelineStage<Ctx = Record<string, unknown>> {
  name: string;
  run: (ctx: Ctx) => Promise<void> | void;
  /** 失败是否中断管线（默认 false：记录后继续） */
  fatal?: boolean;
}

/** 观测钩子：onStage（阶段完成 + 耗时）/ onError（阶段失败）——回调异常不影响管线 */
export interface PipelineHooks<Ctx = Record<string, unknown>> {
  onStage?: (stage: string, ctx: Ctx, ms: number) => void;
  onError?: (stage: string, error: unknown, ctx: Ctx) => void;
}

/** runPipeline 注入/累积的字段（stageTimings 每阶段耗时；errors 非致命失败明细） */
export interface PipelineRunResult {
  stageTimings: Record<string, number>;
  errors: Array<{ stage: string; error: string }>;
}

/**
 * 顺序执行管线
 * @returns ctx（含 stageTimings / errors）
 */
export async function runPipeline<Ctx extends object>(
  stages: PipelineStage<Ctx>[],
  ctx: Ctx & Partial<PipelineRunResult>,
  hooks: PipelineHooks<Ctx> = {},
): Promise<Ctx & Partial<PipelineRunResult>> {
  const { onStage, onError } = hooks;
  const stageTimings: Record<string, number> = (ctx.stageTimings as Record<string, number> | undefined) ?? {};
  const errors: Array<{ stage: string; error: string }> = (ctx.errors as Array<{ stage: string; error: string }> | undefined) ?? [];
  ctx.stageTimings = stageTimings;
  ctx.errors = errors;
  for (const s of stages) {
    const t0 = Date.now();
    // 观察者回调（onStage/onError）失败不应影响阶段结果：移出 try，单独保护
    let stageError: unknown = null;
    try {
      await s.run(ctx);
    } catch (e) {
      stageError = e;
    }
    const ms = Date.now() - t0;
    stageTimings[s.name] = ms;
    if (stageError) {
      const msg = stageError instanceof Error ? stageError.message : String(stageError);
      errors.push({ stage: s.name, error: msg });
      try { if (onError) onError(s.name, stageError, ctx); } catch { /* observer 异常不影响管线 */ }
      if (s.fatal) throw new Error(`${s.name} 阶段失败: ${msg}`);
      console.error(`[pipeline] ${s.name} 阶段失败（继续）: ${msg.slice(0, 100)}`);
    } else {
      try { if (onStage) onStage(s.name, ctx, ms); } catch { /* observer 异常不影响管线 */ }
    }
  }
  return ctx;
}

/** 汇总管线执行摘要（展示/日志用） */
export function pipelineSummary(ctx: Partial<PipelineRunResult>): string {
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
