// widget 鉴权核心逻辑（纯 Node，无 Electron 依赖，可单测）
// 从 desktop/main.mjs 抽取：token 轮询 / 注入判断 / fetch 包装 / 健康探测 URL。
//
// 生产事故教训（对应历史故障点）：
//  1. 主进程 fetch 不经过 webRequest 的 onBeforeSendHeaders 注入，必须显式带 Bearer 头，
//     否则面板所有请求 401（loadWidgetToken / widgetFetch 一度零测试覆盖）。
//  2. 健康探测必须用认证豁免端点 /api/health；探测需要鉴权的 /api/refresh 会被 401 误判
//     widget 未启动 → 疯狂重复 spawn（无限重启循环事故）。
import { readFileSync } from "node:fs";

/** widget 数据服务地址（端口固定，勿改——widget.mjs 监听同一端口） */
export const WIDGET_URL = "http://127.0.0.1:8899";

/**
 * 健康探测路径：/api/health 是 widget 侧认证豁免端点（合同约定）。
 * 探测它不会触发 401，从而避免误判 widget 未启动导致的无限 respawn 循环。
 */
export const HEALTH_PATH = "/api/health";

// 默认 fs 实现（真实 node:fs.readFileSync）；测试注入 fake fs 模拟"文件延迟出现"
const nodeFs = { readFileSync };

/**
 * 从 token 文件原文提取 token。
 * 支持三种合法格式：
 *   - JSON 对象 { token } 或 { value }（widget.mjs 写 { token, ts }）
 *   - 裸字符串（旧版 widget 直接写 token，或 JSON 字符串 "..."）
 * 损坏 JSON（以 { / [ / " 开头却解析失败）与空对象等垃圾 → 返回 ""。
 */
export function extractToken(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON：以 JSON 结构字符开头视为损坏 JSON → ""；否则视为裸字符串 token
    const c0 = text[0];
    if (c0 === "{" || c0 === "[" || c0 === '"') return "";
    return text;
  }
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const t = parsed.token || parsed.value || "";
    return typeof t === "string" ? t : "";
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 持续轮询 token 文件，直到读到 token 才返回（forever 语义）。
 * widget 冷启动要 15-30s 才写 data/widget-token.json → 不能 10s 放弃，
 * 否则面板所有请求永远 401。
 *
 * 参数：
 *   fsImpl        注入的文件读取实现（默认 node:fs 的 readFileSync）
 *   pollIntervalMs 轮询间隔（默认 500ms）
 *   onLoaded       token 成功读取后的回调（可选，便于测试/埋点）
 */
export async function loadTokenFromFile(
  tokenFile,
  { pollIntervalMs = 500, fsImpl = nodeFs, onLoaded = null } = {}
) {
  for (;;) {
    let token = "";
    try {
      token = extractToken(String(fsImpl.readFileSync(tokenFile, "utf8") ?? ""));
    } catch {
      // 文件尚未生成 / 读取失败 → 继续轮询
    }
    if (token) {
      if (typeof onLoaded === "function") onLoaded(token);
      return token;
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * 判断是否应对某请求注入 Authorization 头。
 * 仅当 token 非空 且 url 指向 8899 的 widget 服务（127.0.0.1 或 localhost）时才注入。
 */
export function shouldInjectAuth(url, token) {
  if (!token) return false;
  const u = String(url || "");
  return u.startsWith(WIDGET_URL) || u.startsWith("http://localhost:8899");
}

/**
 * 生成主进程 fetch 包装：自动附 Bearer token。
 * 关键：主进程 fetch 不经过 webRequest 注入 → 必须显式带 header，否则全部 401。
 * 纯函数：注入 fake fetchImpl 即可捕获 header 断言。
 */
export function widgetFetchFactory(token, fetchImpl) {
  return (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetchImpl(url, { ...opts, headers });
  };
}

/** 健康探测完整 URL（认证豁免端点，避免 401 误判 → 无限 respawn） */
export function healthUrl() {
  return WIDGET_URL + HEALTH_PATH;
}
