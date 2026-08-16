// 向用户提问服务（human-in-the-loop 询问，对标 DSH ask_user_question / Claude Code 交互式确认）
// ask_user 工具与 plan_mode 工具共用：挂起 agent → 面板展示问题+选项 → 用户选择 → resolve
// 超时（默认 120s）→ 返回 {timeout: true}，agent 自行降级（不阻塞对话）
import { randomUUID } from "node:crypto";

const ASK_TIMEOUT_MS = 120000;
const pending = new Map(); // id -> {id, question, options, multiSelect, kind, requestedAt, promise, resolve, timer}

/**
 * 发起一次提问（挂起直到用户回答或超时）
 * @param {{question: string, options?: Array<{label: string, description?: string}>, multiSelect?: boolean, kind?: string, timeoutMs?: number}} req
 * @returns {Promise<{timeout: boolean, selected: string[], reason?: string}>}
 */
export function askUser({ question, options = [], multiSelect = false, kind = "question", timeoutMs = ASK_TIMEOUT_MS }) {
  const id = `ask_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const entry = {
    id,
    question: String(question || "").slice(0, 2000),
    options: (Array.isArray(options) ? options : []).slice(0, 8).map((o) => ({
      label: String(o?.label ?? o ?? "").slice(0, 60),
      description: String(o?.description ?? "").slice(0, 200),
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
export function getPendingAsks() {
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
export function answerAsk(id, { selected = [], reason = "" } = {}) {
  const entry = pending.get(String(id || ""));
  if (!entry) return { ok: false, error: `没有待回答的问题: ${id}` };
  const labels = (Array.isArray(selected) ? selected : [selected]).map((s) => String(s));
  entry.resolve({ timeout: false, selected: labels, reason: String(reason || "") });
  return { ok: true };
}

/** 取消提问（agent 主动放弃/超时清理） */
export function cancelAsk(id) {
  const entry = pending.get(String(id || ""));
  if (!entry) return { ok: false };
  entry.resolve({ timeout: true, selected: [], reason: "提问被取消" });
  return { ok: true };
}

/** 当前待回答数量（widget 展示用） */
export function pendingAskCount() {
  return pending.size;
}
