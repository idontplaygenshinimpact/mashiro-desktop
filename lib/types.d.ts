// 共享类型（TS 升级工单任务 2②）：.mjs 用 JSDoc `@typedef {import("./types.d.ts").ToolResult}` 引用
// 纯类型文件（.d.ts）——node 运行时不会解析，零运行时成本；tsc checkJs 下提供真实类型检查

/** 工具执行结果（全部 tool_* 函数统一返回形状：ok + error + 业务字段） */
export interface ToolResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** LLM 对话消息（OpenAI 协议子集） */
export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

/** llmChat/chat 调用选项 */
export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  role?: string;
  json?: boolean;
  timeout?: number;
  tools?: unknown[];
  toolChoice?: unknown;
  stream?: boolean;
  tag?: string;
}

/** 复习卡形状（review.mjs loadCards 输出） */
export interface ReviewCard {
  id: string;
  topic: string;
  question: string;
  answer: string;
  source: string;
  type: "algo" | "concept";
  priority: "必会" | "进阶" | "拓展";
  fsrs: unknown;
  memPct: number;
  stage: { key: string; label: string };
  createdAt: string;
  history: Array<{ at: string; rating: number; due: string }>;
}

/** 薄弱点形状（memory.mjs 镜像字段） */
export interface WeakPoint {
  topic: string;
  failCount: number;
  lastFailedAt?: string;
  source?: string;
  origin?: string;
  question?: string;
  answer?: string;
}

// ---------- TS 增量收益工单任务 C：T1-T4 新代码共享类型 ----------

/** 计划状态（todo.mjs PlanStore——编排能力缺口工单 T1） */
export interface PlanState {
  id: string;
  goal: string;
  steps: Array<{ title: string; done: boolean }>;
  currentStep: number;
  status: "pending" | "confirmed" | "done" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

/** 工具失败分类（agent.mjs executeTool 返回契约——编排能力缺口工单 T2） */
export type ToolErrorKind = "param" | "perm" | "transient" | "hard";

/** 审批请求/结果（permission.mjs——human-in-the-loop） */
export interface Approval {
  toolName: string;
  args?: unknown;
  allow: boolean;
  reason?: string;
  timeout?: boolean;
  autoApproved?: boolean;
}

/** 决策账本条目（trace.mjs recordDecision 入参——审计可追溯） */
export interface Decision {
  decision: "allow" | "deny" | "auto_allow" | "timeout" | "tool_error" | "injection_hit";
  toolName?: string;
  reason?: string;
  policyRef?: string;
  approvedBy?: string;
}
