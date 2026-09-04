// 实时网络搜索：Bing 搜索 → 提取 {title, url, snippet}，供 agent 的 web_search 工具调用
// 2026-08 修复：改用 Node fetch 直接抓 Bing SERP（302ms）——此前复用 fetchPage（Playwright + page.route
// 每个子资源 DNS 校验），Bing 页面广告/统计子资源多 → goto 慢/超时（45s×2 重试=90s）→ 对话搜索工具卡死。
import { fetchPage } from "./fetch-page.mjs";

const BING_SEARCH_URL = "https://cn.bing.com/search";
const BING_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Node fetch 版 Bing 抓取（快 + 不卡）：抓 SERP HTML → 解析链接（title/url）+ 提取正文文本（snippet 用）
async function fetchBingHtml(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": BING_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return { invalid: true, links: [], text: "" };
  const html = await r.text();
  const links = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && links.length < 100) {
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    if (title.length > 4 && !m[1].includes("bing.com")) links.push({ text: title.slice(0, 80), href: m[1] });
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 30000);
  return { invalid: false, links, text };
}

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

// 百度搜索（中文质量好——"美团 秋招 笔试"→ 美团笔试真题 CSDN/知乎；Bing 中文分词差"美团"→"美的/美图"）
async function fetchBaiduHtml(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": BING_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return { invalid: true, links: [], text: "" };
  const html = await r.text();
  const links = [];
  const re = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/g;
  let m;
  while ((m = re.exec(html)) && links.length < 50) {
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    if (title.length > 4) links.push({ text: title.slice(0, 80), href: m[1] });
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 30000);
  return { invalid: false, links, text };
}

/**
 * Bing 实时搜索：返回 [{title, url, snippet}]（去重、最多 limit 条）
 * 健壮性：网络失败/抓取异常一律返回 []，绝不抛错（工具层会据此降级）
 * @param {string} query 搜索关键词
 * @param {{limit?: number, fetchFn?: (url: string, opts?: any) => Promise<any>}} [options]
 *   limit  返回条数上限（默认 5，最大 10）
 *   fetchFn 可注入的抓取函数（测试 seam；默认百度优先 + Bing 兜底）
 */
/**
 * 网页搜索（默认 fetch 实现；fetchFn 可注入测试）
 * @param {string} query 搜索词
 * @param {{ limit?: number, fetchFn?: Function }} [opts] 选项
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>} 搜索结果
 */
export async function searchWeb(query, { limit = 5, fetchFn } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : 5;
  try {
    // 百度优先（中文质量好——"美团 秋招 笔试"→ 美团笔试真题；Bing 中文分词差"美团"→"美的/美图"）
    const baiduPage = await (fetchFn || fetchBaiduHtml)(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}`);
    if (baiduPage && !baiduPage.invalid && Array.isArray(baiduPage.links) && baiduPage.links.length) {
      return extractResults(baiduPage, cap);
    }
    // Bing 兜底（查询优化：前 2 词 + 核心词重搜合并——Bing 多词中文分词不稳定）
    const bingFn = fetchFn || fetchBingHtml;
    const words = q.split(/\s+/).filter(Boolean);
    const core = words[0] || q;
    const searchQ = words.length > 2 ? words.slice(0, 2).join(" ") : q;
    let page = await bingFn(`${BING_SEARCH_URL}?q=${encodeURIComponent(searchQ)}`);
    if (!page || page.invalid || !Array.isArray(page.links)) return [];
    let results = extractResults(page, cap);
    const coreHit = results.some((r) => r.title.includes(core) || r.url.toLowerCase().includes(core.toLowerCase()));
    if (!coreHit && words.length > 1) {
      const page2 = await bingFn(`${BING_SEARCH_URL}?q=${encodeURIComponent(core)}`);
      if (page2 && !page2.invalid && Array.isArray(page2.links)) {
        const r2 = extractResults(page2, cap);
        const seen = new Set(results.map((r) => r.url));
        for (const r of r2) if (!seen.has(r.url)) results.push(r);
      }
    }
    // 核心词命中的排前（合并后 slice 截断把 meituan 挤掉——"美的/美图"占满前 5 个）
    results.sort((a, b) => {
      const sa = a.title.includes(core) || a.url.toLowerCase().includes(core.toLowerCase()) ? 1 : 0;
      const sb = b.title.includes(core) || b.url.toLowerCase().includes(core.toLowerCase()) ? 1 : 0;
      return sb - sa;
    });
    return results.slice(0, cap);
  } catch {
    // 网络失败/抓取或解析异常：返回空数组，绝不抛错（agent 层会提示换关键词或查本地知识库）
    return [];
  }
}
