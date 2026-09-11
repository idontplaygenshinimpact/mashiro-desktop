// 向用户提问服务（human-in-the-loop 询问，对标 DSH ask_user_question / Claude Code 交互式确认）
// ask_user 工具与 plan_mode 工具共用：挂起 agent → 面板展示问题+选项 → 用户选择 → resolve
// 超时（默认 120s）→ 返回 {timeout: true}，agent 自行降级（不阻塞对话）
import { randomUUID } from "node:crypto";

const ASK_TIMEOUT_MS = 120000;

/** 提问选项（label 展示；description 补充说明） */
export interface AskOption {
  label: string;
  description: string;
}

/** 提问请求（options 可传 string 或 {label, description?}——统一归一） */
export interface AskRequest {
  question: string;
  options?: Array<{ label?: string; description?: string } | string>;
  multiSelect?: boolean;
  kind?: string;
  timeoutMs?: number;
}

/** 提问结果（timeout=true 用户未答/取消；selected=选中 label 列表；reason 补充） */
export interface AskResult {
  timeout: boolean;
  selected: string[];
  reason?: string;
}

/** 待回答条目（pending Map 值） */
interface PendingAsk {
  id: string;
  question: string;
  options: AskOption[];
  multiSelect: boolean;
  kind: string;
  requestedAt: number;
  promise: Promise<AskResult>;
  resolve: (result: AskResult) => void;
  timer?: NodeJS.Timeout;
}

const pending = new Map<string, PendingAsk>(); // id -> 待回答条目

/**
 * 发起一次提问（挂起直到用户回答或超时）
 */
export function askUser({ question, options = [], multiSelect = false, kind = "question", timeoutMs = ASK_TIMEOUT_MS }: AskRequest): Promise<AskResult> {
  const id = `ask_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  let resolveFn: (result: AskResult) => void = () => {};
  const promise = new Promise<AskResult>((resolve) => { resolveFn = resolve; });
  const entry: PendingAsk = {
    id,
    question: String(question || "").slice(0, 2000),
    options: (Array.isArray(options) ? options : []).slice(0, 8).map((o) => ({
      label: String((o && typeof o === "object" ? o.label : o) ?? "").slice(0, 60),
      description: String((o && typeof o === "object" ? o.description : "") ?? "").slice(0, 200),
    })),
    multiSelect: !!multiSelect,
    kind: String(kind || "question"),
    requestedAt: Date.now(),
    promise,
    resolve: (result) => {
      clearTimeout(entry.timer);
      if (pending.get(id) === entry) pending.delete(id);
      resolveFn(result);
    },
  };
  entry.timer = setTimeout(() => {
    if (pending.get(id) === entry) pending.delete(id);
    resolveFn({ timeout: true, selected: [], reason: "提问超时（用户未在 2 分钟内回答）" });
  }, timeoutMs);
  pending.set(id, entry);
  return promise;
}

/** 面板查询：当前待回答的问题列表 */
export function getPendingAsks(): Array<{ id: string; question: string; options: AskOption[]; multiSelect: boolean; kind: string; requestedAt: number }> {
  return [...pending.values()].map((e) => ({
    id: e.id,
    question: e.question,
    options: e.options,
    multiSelect: e.multiSelect,
    kind: e.kind,
    requestedAt: e.requestedAt,
  }));
}

/** 用户回答：selected 为选项 label 列表；reason 可选补充说明 */
export function answerAsk(id: unknown, { selected = [], reason = "" }: { selected?: unknown; reason?: string } = {}): { ok: boolean; error?: string } {
  const entry = pending.get(String(id || ""));
  if (!entry) return { ok: false, error: `没有待回答的问题: ${id}` };
  const labels = (Array.isArray(selected) ? selected : [selected]).map((s) => String(s));
  entry.resolve({ timeout: false, selected: labels, reason: String(reason || "") });
  return { ok: true };
}

/** 取消提问（agent 主动放弃/超时清理） */
export function cancelAsk(id: unknown): { ok: boolean } {
  const entry = pending.get(String(id || ""));
  if (!entry) return { ok: false };
  entry.resolve({ timeout: true, selected: [], reason: "提问被取消" });
  return { ok: true };
}

/** 当前待回答数量（widget 展示用） */
export function pendingAskCount(): number {
  return pending.size;
}
