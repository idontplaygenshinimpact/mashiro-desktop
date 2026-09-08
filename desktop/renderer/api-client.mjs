// 渲染层统一 API client（Phase 2 §3.5）：收编 120 处硬编码 8899 直连的基址单一来源。
// 用法：api("/api/study-plan") 或 api("/api/xxx", { method: "POST", body: { ... } })。
// 返回解析后的 JSON；HTTP 错误（500/503）抛 Error（调用方按现有 catch 处理）。
// 架构 P1-4：基址动态解析——主进程从 widget-port.json 取实际端口（端口回退 EADDRINUSE 后同步），
// 解析失败/未就绪兜底 8899。一次解析缓存，窗口生命周期内不重复 IPC。
let BASE_URL = "http://127.0.0.1:8899"; // 兜底默认
let basePromise = null;
function resolveBase() {
  if (!basePromise) {
    basePromise = (async () => {
      try {
        const r = await window.kanban?.getApiBase?.();
        if (r && typeof r.base === "string" && r.base) BASE_URL = r.base;
      } catch { /* 保持兜底 */ }
    })();
  }
  return basePromise;
}
export const getApiBase = () => { resolveBase(); return BASE_URL; };

/**
 * @param {string} pathname 以 / 开头的 API 路径
 * @param {{ method?: string, body?: any, headers?: Record<string, string> }} [opts]
 * @returns {Promise<any>}
 */
export async function api(pathname, { method = "GET", body = undefined, headers = {} } = {}) {
  await resolveBase(); // 首次调用等待端口解析（后续走缓存）
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const msg = (j && (j.error || j.message)) || `HTTP ${res.status}`;
    const err = /** @type {Error & {status?: number, body?: any}} */ (new Error(String(msg).slice(0, 160)));
    err.status = res.status;
    err.body = j;
    throw err;
  }
  return j;
}