// 实时网络搜索：Bing 搜索 → 提取 {title, url, snippet}，供 agent 的 web_search 工具调用
// 复用 fetch-page.mjs 的 fetchPage（与 toolSearchPosts 的 Bing 兜底同一套 Playwright 抓取逻辑），
// 不新写抓取逻辑；Bing 结果页用 rawText 取 body.innerText（比 Readability 对 SERP 列表页更稳，能拿到摘要）。
import { fetchPage } from "./fetch-page.mjs";

const BING_SEARCH_URL = "https://cn.bing.com/search";

// Bing 结果页里的内部/导航链接：过滤掉站内导航、微软自家域、搜索建议，只保留真正的外部结果
const INTERNAL_HOST_RE = /(^|\.)(bing\.com|bing\.net|bingj\.com|microsoft\.com|msn\.com|go\.microsoft\.com)$/i;
const NAV_TEXT_RE = /^(下一页|上一页|更多|图片|视频|新闻|地图|登录|签到|Sign in|Images|Videos|News|Maps|More|Next|Previous)$/i;

// 归一化标题（去空白 + 小写），用于摘要定位时的精确匹配
function norm(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

// 判断一行是否是 URL 行（完整 http 链接 或 裸域名），SERP 正文里用它分隔「标题/摘要/URL」块
function isUrlLine(line) {
  return /^https?:\/\//i.test(line) || /^\w[\w.-]*\.[a-z]{2,}(\/\S*)?$/i.test(line);
}

// 从 SERP 正文按标题定位摘要（best-effort：找不到返回空串，不阻断主流程）
// 正文结构近似：每个结果 = 标题行 → 摘要行(1-3行) → URL 行
function buildSnippets(text, titles) {
  const snippets = new Map();
  const lines = String(text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isUrlLine(line)) continue;
    // 找到与某个候选标题匹配的行（标题通常独占一行且位于结果块开头）
    const hit = titles.find((t) => norm(line).startsWith(norm(t)));
    if (!hit) continue;
    const parts = [];
    for (let j = i + 1; j < lines.length && parts.length < 3; j++) {
      const lj = lines[j];
      if (isUrlLine(lj)) break;
      // 撞到下一个结果的标题 → 结束当前摘要
      if (titles.some((t2) => t2 !== hit && norm(lj).startsWith(norm(t2)))) break;
      parts.push(lj);
    }
    const snip = parts.join(" ").replace(/\s+/g, " ").trim();
    if (snip && !snippets.has(norm(hit))) snippets.set(norm(hit), snip.slice(0, 300));
  }
  return snippets;
}

// 从抓到的页面提取结果：过滤/去重 → 截断到 limit 条 → 补摘要
function extractResults(page, limit) {
  const links = Array.isArray(page.links) ? page.links : [];
  const seen = new Set();
  const candidates = [];
  for (const l of links) {
    const title = String(l.text || "").trim();
    const url = String(l.href || "").trim();
    if (!title || title.length < 4 || !/^https?:\/\//i.test(url)) continue;
    if (NAV_TEXT_RE.test(title)) continue;
    let host;
    try { host = new URL(url).hostname; } catch { continue; } // 非法 URL：跳过该条
    if (INTERNAL_HOST_RE.test(host)) continue;
    const clean = url.split("#")[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    candidates.push({ title: title.slice(0, 120), url: clean });
    if (candidates.length >= limit * 3) break;
  }
  if (!candidates.length) return [];
  const snippets = buildSnippets(page.text || "", candidates.map((c) => c.title));
  return candidates.slice(0, limit).map((c) => ({
    title: c.title,
    url: c.url,
    snippet: snippets.get(norm(c.title)) || "",
  }));
}

/**
 * Bing 实时搜索：返回 [{title, url, snippet}]（去重、最多 limit 条）
 * 健壮性：网络失败/抓取异常一律返回 []，绝不抛错（工具层会据此降级）
 * @param {string} query 搜索关键词
 * @param {{limit?: number, fetchFn?: (url: string, opts?: any) => Promise<any>}} [options]
 *   limit  返回条数上限（默认 5，最大 10）
 *   fetchFn 可注入的抓取函数（测试 seam；默认复用 fetch-page.mjs 的 fetchPage）
 */
export async function searchWeb(query, { limit = 5, fetchFn = fetchPage } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : 5;
  try {
    const page = await fetchFn(`${BING_SEARCH_URL}?q=${encodeURIComponent(q)}`, {
      collectLinks: true,
      rawText: true,
      maxTextChars: 30000,
      waitUntil: "networkidle",
    });
    if (!page || page.invalid || !Array.isArray(page.links)) return [];
    return extractResults(page, cap);
  } catch {
    // 网络失败/抓取或解析异常：返回空数组，绝不抛错（agent 层会提示换关键词或查本地知识库）
    return [];
  }
}
