// 渲染层统一 API client（Phase 2 §3.5）：收编 120 处硬编码 8899 直连的基址单一来源。
// 用法：api("/api/study-plan") 或 api("/api/xxx", { method: "POST", body: { ... } })。
// 返回解析后的 JSON；HTTP 错误（500/503）抛 Error（调用方按现有 catch 处理）。
const BASE_URL = "http://127.0.0.1:8899";
export const getApiBase = () => BASE_URL;

/**
 * @param {string} pathname 以 / 开头的 API 路径
 * @param {{ method?: string, body?: any, headers?: Record<string, string> }} [opts]
 * @returns {Promise<any>}
 */
export async function api(pathname, { method = "GET", body = undefined, headers = {} } = {}) {
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