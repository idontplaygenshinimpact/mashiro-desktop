// 权限审批模块（human-in-the-loop，对标 Claude Code permission 简化版）
// 工具分级：auto（自动执行）/ confirm（每次调用需用户批准，带超时）
// 会话级 auto-approve：一次允许后，本次会话同类工具不再询问（对标 CC 的 auto-approve-until-session-end）
// 设计要点：
//   - 审批请求挂起对应工具调用（Promise），面板决定后 resolve
//   - 超时（APPROVAL_TIMEOUT_MS）默认拒绝（deny-first 原则）
//   - 同一工具并发的多个请求合并为一次询问（避免刷屏）

import { recordDecision } from "./trace.mjs";

const APPROVAL_TIMEOUT_MS = 60000; // 审批等待超时（默认拒绝）
const pending = new Map();          // toolName -> { promise, resolve, timer, args, reason, requestedAt }
const sessionApproved = new Set();  // 会话级已批准的工具（本进程生命周期）
const sessionDenied = new Set();    // 会话级已拒绝的工具（拒绝后本会话硬拦截，防 LLM 变参重试无限重发审批）

// 禁止会话级 auto-approve 的工具（外部副作用/不可逆操作——每次都必须用户确认）
const SESSION_APPROVE_DENIED = new Set(["job_apply"]);

/** 会话级已拒绝清单查询（checkToolPermission 命中即拒绝） */
export function isSessionDenied(toolName) {
  return sessionDenied.has(toolName);
}

/** 记录会话级拒绝（用户显式拒绝或审批超时） */
export function markSessionDenied(toolName) {
  sessionDenied.add(toolName);
}

/** 会话边界重置（新对话开始时调用）：清空已批准与已拒绝集合 */
export function resetSessionApprovals() {
  sessionApproved.clear();
  sessionDenied.clear();
}

/** 请求一次审批：挂起直到用户决定或超时。返回 { allow: true } 或 { allow: false, reason } */
export function requestApproval({ toolName, args, reason }) {
  if (sessionApproved.has(toolName)) return Promise.resolve({ allow: true, autoApproved: true });
  const existing = pending.get(toolName);
  if (existing) return existing.promise; // 同工具并发请求：共享同一个决策
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const entry = {
    args,
    reason: reason || toolName,
    requestedAt: Date.now(),
    promise,
    resolve: (result) => {
      clearTimeout(entry.timer);
      if (pending.get(toolName) === entry) pending.delete(toolName);
      resolveFn(result);
    },
  };
  entry.timer = setTimeout(() => {
    if (pending.get(toolName) === entry) pending.delete(toolName);
    resolveFn({ allow: false, reason: "审批超时（默认拒绝）", timeout: true });
  }, APPROVAL_TIMEOUT_MS);
  pending.set(toolName, entry);
  return promise;
}

/** 面板查询：当前待审批的请求列表 */
export function getPendingApprovals() {
  return [...pending.entries()].map(([toolName, e]) => ({
    toolName,
    reason: e.reason,
    args: e.args,
    requestedAt: e.requestedAt,
  }));
}

/** 用户决策：allow=true 允许（session=true 且工具不在禁用名单则本会话不再询问）；false 拒绝（记入会话级 deny） */
export function resolveApproval(toolName, { allow, session = false }) {
  const entry = pending.get(toolName);
  if (!entry) return { ok: false, error: `没有待审批的 ${toolName} 请求` };
  if (!allow) {
    markSessionDenied(toolName);
  } else if (session && !SESSION_APPROVE_DENIED.has(toolName)) {
    sessionApproved.add(toolName);
  }
  entry.resolve({ allow: !!allow, sessionApproved: session });
  return { ok: true };
}

/** 会话级已批准清单（调试/展示用） */
export function getSessionApproved() {
  return [...sessionApproved];
}

/** 将一次审批决策规范化为 'allow'/'deny' 并写入决策账本（metadata only，不存工具参数/内容）。
 *  deny-first：任何非 'allow'/true 的输入（含 'deny'/'timeout'/'tool_error'/false/未知）一律记为 'deny'。
 *  @param {Record<string, any>} proposal 审批提案元数据（toolName/sessionId/policyRef/approvedBy 等）
 *  @param {string|boolean} decision 原始决策
 *  @param {string} [reason] 决策理由
 *  @returns {'allow'|'deny'} 规范化决策
 */
export function resolveApprovalDecision(proposal, decision, reason) {
  const p = proposal || {};
  const allow = decision === "allow" || decision === true;
  const canonical = allow ? "allow" : "deny";
  try {
    recordDecision({
      sessionId: p.sessionId ?? p.session_id ?? null,
      decision: canonical,
      toolName: p.toolName ?? p.tool ?? p.name ?? null,
      reason: reason ?? p.reason ?? null,
      policyRef: p.policyRef ?? p.policy_ref ?? p.policy ?? null,
      approvedBy: canonical === "allow" ? (p.approvedBy ?? "user") : null,
    });
  } catch { /* ledger 永不阻断主流程 */ }
  return canonical;
}
