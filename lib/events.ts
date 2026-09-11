// 事件总线 + 表达队列（Phase 事件驱动内核 W1，ADDITIVE 层——叠加 hooks.ts 之上，不重写）
// 统一事件模型：{ type, source, ts, payload }
// 两类消费者：
//   1. 决策层订阅（onEventDecision → autonomy.mjs 判断要不要动）
//   2. 表达队列（enqueueExpression：需播报的入队，供主进程 /api/pet-events drain）
// 原则（对齐 hooks.ts）：监听器/决策层失败隔离，永不阻断主流程
// 全量 TS 升级工单阶段 3 批次 E3：lib/events.mjs 保留为桶（widget/routes/测试等 11+ 调用方零改动）
import { emitHook, onHook } from "./hooks.ts";

/** 统一事件（{ type, source, ts, payload }——任何事件源产出的总线形状；允许扩展字段） */
export interface UnifiedEvent {
  type: string;
  source: string;
  ts: number;
  payload: Record<string, unknown>;
  [k: string]: unknown; // hooks 生态 payload 是 Record<string, unknown>——事件本体可带扩展字段
}

/** 待播报表达（队列条目；ttl 过期丢弃） */
export interface PendingExpression {
  text: string;
  scene: string;
  level: string;
  ttl: number;
  ts: number;
}

/** 表达队列（drain 后清空；防堆积上限） */
const exprQueue: PendingExpression[] = [];
const EXPR_QUEUE_MAX = 100; // 防堆积上限（drain 不及时也不撑爆内存）

/** 决策层回调（autonomy.mjs 注册；同一时刻只有一个消费者） */
let decisionSubscriber: ((ev: UnifiedEvent) => unknown) | null = null;

/**
 * 发出一条统一事件（任何事件源：cc-watcher / agent / scheduler / 内部）
 * 转发 hooks 生态（`event:<type>` 命名空间，现有 emitHook 调用点不改）+ 通知决策层（异步失败隔离）
 * @returns 事件本体
 */
export function emitEvent({ type, source = "internal", ts = Date.now(), payload = {} }: { type: string; source?: string; ts?: number; payload?: Record<string, unknown> }): UnifiedEvent {
  const ev: UnifiedEvent = { type: String(type), source, ts, payload };
  // 1) hooks 生态兼容（新事件类型可被现有 onHook 机制消费）
  emitHook(`event:${ev.type}`, ev).catch(() => {});
  // 2) 决策层（autonomy）：异步执行，抛错只记日志
  if (decisionSubscriber) {
    Promise.resolve().then(() => decisionSubscriber!(ev)).catch((e) => {
      console.log(`[events] 决策层异常: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
    });
  }
  return ev;
}

/**
 * 注册决策层（autonomy.mjs 启动时调用）；返回取消函数
 */
export function onEventDecision(fn: (ev: UnifiedEvent) => unknown): () => void {
  decisionSubscriber = fn;
  return () => { if (decisionSubscriber === fn) decisionSubscriber = null; };
}

/**
 * 入队一条待播报表达（主进程 drain 后调 petSay）
 */
export function enqueueExpression({ text, scene = "default", level = "bubble", ttl = 60000 }: { text: string; scene?: string; level?: string; ttl?: number }): void {
  const t = String(text || "").trim().slice(0, 200);
  if (!t) return;
  exprQueue.push({ text: t, scene: String(scene || "default"), level, ttl: Number(ttl) || 60000, ts: Date.now() });
  if (exprQueue.length > EXPR_QUEUE_MAX) exprQueue.splice(0, exprQueue.length - EXPR_QUEUE_MAX);
}

/**
 * 取走即清空（drain 语义：widget /api/pet-events 用）；TTL 过期的丢弃
 */
export function drainExpressions(now = Date.now()): Array<{ text: string; scene: string; level: string }> {
  const out: Array<{ text: string; scene: string; level: string }> = [];
  for (const e of exprQueue) {
    if (now - e.ts <= e.ttl) out.push({ text: e.text, scene: e.scene, level: e.level });
  }
  exprQueue.length = 0;
  return out;
}

/** 队列长度（测试/面板用） */
export function expressionQueueLength(): number {
  return exprQueue.length;
}

/** 清空队列（测试隔离用） */
export function clearExpressions(): void {
  exprQueue.length = 0;
}

// ---------- 内部事件归一（hooks 生态 → 统一事件总线） ----------
// 现有 emitHook 调用点不改；installInternalBridge 订阅存量事件并归一为总线事件（决策层可消费）。
// 显式安装（widget 启动时调用）：不放在模块顶层——避免测试 clearHooks() 后静默失效/跨测试污染。
// 幂等实现：监听器用模块级常量引用，onHook(Set.add) 同引用天然去重；clearHooks 清掉后再次 install 可恢复。
let chatDoneBridge: ((p: Record<string, unknown>) => unknown) | null = null;
/**
 * 安装内部事件桥（幂等可重装）：chat_done 等存量 hooks 事件 → 统一事件总线
 * 方案规则表：chat_done 保持现状（不走表达队列）——归一但决策层默认不动作
 */
export function installInternalBridge(): void {
  if (!chatDoneBridge) {
    chatDoneBridge = (p) => {
      emitEvent({
        type: "chat_done", source: "agent",
        payload: { userMsg: String(p?.userMsg || "").slice(0, 100), replyLen: String(p?.reply || "").length },
      });
      return null;
    };
  }
  onHook("chat_done", chatDoneBridge);
}
