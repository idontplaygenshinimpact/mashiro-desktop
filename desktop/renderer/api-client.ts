// 渲染层统一 API client（Phase 2 §3.5）：收编 120 处硬编码 8899 直连的基址单一来源。
// 用法：api("/api/study-plan") 或 api("/api/xxx", { method: "POST", body: { ... } })。
// 返回解析后的 JSON；HTTP 错误（500/503）抛 Error（调用方按现有 catch 处理）。
// 架构 P1-4：基址动态解析——主进程从 widget-port.json 取实际端口（端口回退 EADDRINUSE 后同步），
// 解析失败/未就绪兜底 8899。一次解析缓存，窗口生命周期内不重复 IPC。
// 全量 TS 升级工单阶段 4（渲染层）：desktop/renderer/api-client.mjs → .ts
//   两个 Vite 子项目（panel-react / panel-vue-review）的 src/api.js 从 `../../api-client.mjs` 复用 →
//   保留同名 .mjs 一行桶，Vite 解析路径与 dev 的 fs.allow 边界都不变
let BASE_URL = "http://127.0.0.1:8899"; // 兜底默认
let basePromise: Promise<void> | null = null;

/** 主进程暴露的基址查询接口（preload 的 window.kanban.getApiBase） */
interface KanbanBaseBridge {
  getApiBase?: () => Promise<{ base?: string } | null | undefined>;
}

function resolveBase(): Promise<void> {
  if (!basePromise) {
    basePromise = (async () => {
      try {
        const bridge = (window as unknown as { kanban?: KanbanBaseBridge }).kanban;
        const r = await bridge?.getApiBase?.();
        if (r && typeof r.base === "string" && r.base) BASE_URL = r.base;
      } catch { /* 保持兜底 */ }
    })();
  }
  return basePromise;
}

/** 当前基址（首次调用触发异步解析，立即返回时为兜底值；后续调用拿缓存值） */
export const getApiBase = (): string => { resolveBase(); return BASE_URL; };

/** api 选项 */
export interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** api 抛出的错误（带 status / body，便于调用方区分 4xx/5xx） */
export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

/**
 * 统一 API 调用：解析基址 → fetch → 解析 JSON；非 2xx 抛带 status/body 的 Error。
 * @param pathname 以 / 开头的 API 路径
 */
export async function api(pathname: string, { method = "GET", body = undefined, headers = {} }: ApiOptions = {}): Promise<unknown> {
  await resolveBase(); // 首次调用等待端口解析（后续走缓存）
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j: unknown = null;
  try { j = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const jj = j as { error?: unknown; message?: unknown } | null;
    const msg = (jj && (jj.error || jj.message)) || `HTTP ${res.status}`;
    const err = new Error(String(msg).slice(0, 160)) as ApiError;
    err.status = res.status;
    err.body = j;
    throw err;
  }
  return j;
}
