// 权限审批模块（human-in-the-loop，对标 Claude Code permission 简化版）
// 工具分级：auto（自动执行）/ confirm（每次调用需用户批准，带超时）
// 会话级 auto-approve：一次允许后，本次会话同类工具不再询问（对标 CC 的 auto-approve-until-session-end）
// 设计要点：
//   - 审批请求挂起对应工具调用（Promise），面板决定后 resolve
//   - 超时（APPROVAL_TIMEOUT_MS）默认拒绝（deny-first 原则）
//   - 同一工具并发的多个请求合并为一次询问（避免刷屏）

const APPROVAL_TIMEOUT_MS = 60000; // 审批等待超时（默认拒绝）
const pending = new Map();          // toolName -> { promise, resolve, timer, args, reason, requestedAt }
const sessionApproved = new Set();  // 会话级已批准的工具（本进程生命周期）

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
    resolveFn({ allow: false, reason: "审批超时（默认拒绝）" });
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

/** 用户决策：allow=true 允许（session=true 则本会话不再询问）；false 拒绝 */
export function resolveApproval(toolName, { allow, session = false }) {
  const entry = pending.get(toolName);
  if (!entry) return { ok: false, error: `没有待审批的 ${toolName} 请求` };
  if (allow && session) sessionApproved.add(toolName);
  entry.resolve({ allow: !!allow, sessionApproved: session });
  return { ok: true };
}

/** 会话级已批准清单（调试/展示用） */
export function getSessionApproved() {
  return [...sessionApproved];
}
