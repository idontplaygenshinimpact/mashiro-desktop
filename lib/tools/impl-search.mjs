// 工具实现组：搜索/抓取/浏览（纵向拆分第 3 刀）
// toolSearchPosts / toolFetchPage / toolBrowse —— 只依赖 lib 外部模块，不 import schemas
import { fetchPage, assertPublicUrl } from "../fetch-page.mjs";
import { memory } from "../memory.mjs";
import { wrapUntrusted } from "../prompt-guard.mjs";
import { getCareerProfile } from "../career.mjs";

// Node fetch 抓取用 UA（toolFetchPage 正文抓取——普通页面服务端渲染，Node fetch 能拿 HTML）
const FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 搜索面经帖子（站点过滤 + 关键词）
 * @param {string} query 搜索关键词
 * @param {string} [site] 站点（auto/牛客/CSDN 等）
 * @returns {Promise<{results: Array<{title: string, url: string, snippet: string, site?: string}>}>} 帖子列表（results 包装）
 */
export async function toolSearchPosts(query, site = "auto") {
  const searchUrls = {
    nowcoder: `https://www.nowcoder.com/discuss?type=2&query=${encodeURIComponent(query)}`,
    juejin: `https://juejin.cn/search?query=${encodeURIComponent(query)}`,
    csdn: `https://so.csdn.net/so/search?q=${encodeURIComponent(query)}`,
    // Bing 作为面经站的搜索引擎入口：搜索词带面经关键词，结果按面经站白名单过滤
    bing: `https://cn.bing.com/search?q=${encodeURIComponent(query + " 面经 面试题 笔试")}`,
  };
  // auto = 掘金(API) + Bing（牛客搜索页改版——type=2&query= 不再显示搜索结果（页面是首页/招聘动态），
  // 且 fetchPage 抓牛客页面卡死（事件循环阻塞无法快速失败）——去掉牛客；牛客真题可通过 web_search（百度源）搜到）
  const sites = site === "auto" ? ["juejin", "bing"] : [site];
  const re = /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+)/;
  // 标题级方向过滤：方向排除词来自方向画像 ignoreNote（转方向/开源自动跟随）+ 与方向无关的噪音词（保留）
  const profile = getCareerProfile();
  const noiseRe = /嵌入式|单片机|硬件|驱动|PCB|STM32|ESP32|ARM|芯片|FPGA|物联网|上位机|爬虫开发|知乎|百度知道|CSDN博客-搜索/;
  const ignoreWords = String(profile.ignoreNote || "")
    .split(/[/、,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/[（()）]/.test(s));
  const dirRe = ignoreWords.length
    ? new RegExp(ignoreWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
    : null;
  const EXCLUDE_TITLE = dirRe ? new RegExp(`${noiseRe.source}|${dirRe.source}`, "i") : noiseRe;
  // 并行抓取所有站
  // 快速超时（修复：fetchPage 的 goto 重试 2 次 × navTimeout 45s = 90s 卡住——牛客/Bing 页面子资源多时
  // route 校验慢/卡；30s 快速失败返回错误，agent 降级不卡对话）
  const fetchPageFast = (url, opts) =>
    Promise.race([
      fetchPage(url, opts),
      new Promise((_, rej) => setTimeout(() => rej(new Error("抓取超时")), 30000)),
    ]);
  const results = await Promise.all(
    sites.map(async (s) => {
      try {
        if (s === "juejin") {
          // 掘金：真实浏览器打开搜索页 → 拦截 search_api 响应（绕过 API 风控）
          const page = await fetchPageFast(searchUrls.juejin, {
            maxTextChars: 800, collectLinks: false,
            waitSelector: ".search-result, .search-title, .result-content",
            apiPattern: "search_api/v1/search",
          });
          const articles = [];
          for (const j of page.apiResponses || []) {
            for (const d of j?.data || []) {
              const info = d?.result_model?.article_info || {};
              if (info?.article_id) {
                const t = String(info.title || "").replace(/<[^>]+>/g, "").trim();
                articles.push({ title: t.slice(0, 80), url: `https://juejin.cn/post/${info.article_id}`, site: "juejin", ctime: Number(info.ctime || 0) });
              }
            }
          }
          // 按发布时间降序：近一年优先（2026 秋招看新帖），不足用旧的补齐
          articles.sort((a, b) => b.ctime - a.ctime);
          const cutoff = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
          const recent = articles.filter((a) => a.ctime >= cutoff);
          const older = articles.filter((a) => a.ctime < cutoff);
          return [...recent, ...older].slice(0, 6).map(({ ctime: _ctime, ...p }) => p);
        }
        const page = await fetchPageFast(searchUrls[s], { maxTextChars: 2000, collectLinks: true, waitUntil: "domcontentloaded" });
        if (s === "bing") {
          // Bing：面经站白名单过滤（官网/百科/教程/字典站自然滤掉）
          const MIANJING_HOSTS = /nowcoder\.com\/discuss|juejin\.cn\/post|blog\.csdn\.net\/[^/]+\/article|zhihu\.com|cnblogs\.com\/[^/]+\/p\/|segmentfault\.com\/a\/|my\.oschina\.net|blog\.51cto\.com|yuque\.com\/[^/]+\/|mp\.weixin\.qq\.com\/s\?/;
          return (page.links || [])
            .filter((l) => MIANJING_HOSTS.test(l.href) && l.text.length > 5 && !EXCLUDE_TITLE.test(l.text))
            .slice(0, 8)
            .map((l) => ({ title: l.text.slice(0, 80), url: l.href.split("?")[0], site: "bing" }));
        }
        return page.links
          .filter((l) => re.test(l.href) && l.text.length > 5 && !EXCLUDE_TITLE.test(l.text))
          .slice(0, 6)
          .map((l) => ({ title: l.text.slice(0, 80), url: l.href.replace(/[?&]searchId=[^&]*/g, "").split("?")[0], site: s }));
      } catch (e) {
        return [{ error: `${s} 搜索失败: ${e.message}` }];
      }
    })
  );
  // 合并 + 双重去重（URL 去重 + 标题归一化去重，跨源同帖只留一条；排除已看过的）
  const all = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  for (const list of results) {
    for (const p of list) {
      if (p.error) { all.push(p); continue; }
      if (seenUrl.has(p.url)) continue;
      seenUrl.add(p.url);
      // 标题归一化去重：去括号内容（转载/已过/精华等后缀）+ 空白/标点后比较
      // （牛客/掘金转载同帖标题带"（转载）"等差异，不剥离会重复收录）
      const titleKey = String(p.title)
        .replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "")
        .replace(/[\s，。！？、：:""''（）()\-—_]+/g, "")
        .slice(0, 20);
      if (seenTitle.has(titleKey)) continue;
      seenTitle.add(titleKey);
      if (memory.isSeen(p.url)) continue;   // 已看过的跳过
      all.push(p);
    }
  }
  // 相关性排序：标题含 query 核心词的排前（牛客等搜索引擎相关性弱）
  const coreWord = String(query).split(/\s+/)[0]?.slice(0, 6) || "";
  all.sort((a, b) => {
    const sa = coreWord && a.title.includes(coreWord) ? 1 : 0;
    const sb = coreWord && b.title.includes(coreWord) ? 1 : 0;
    return sb - sa;
  });
  // AI 挑帖：从候选里挑与 query 相关的技术面经/笔试（排除求职咨询/闲聊/泛泛内容）
  // 候选少时直接返回；多时用 LLM 判断，避免关键词穷举
  if (all.length > 4) {
    try {
      const { pickPosts } = await import("../ai.mjs");
      const picked = await pickPosts(all.map((p) => ({ text: p.title, href: p.url })), Math.min(6, all.length), [query]);
      if (picked?.length) {
        const pickedUrls = new Set(picked.map((p) => p.href));
        return { results: all.filter((p) => pickedUrls.has(p.url)).slice(0, 6) };
      }
    } catch { /* 挑帖失败则保留过滤后的结果 */ }
  }
  return { results: all.slice(0, 12) };
}

/**
 * 抓取网页正文（SSRF 前置校验 + Node fetch；掘金 SPA 走 API）
 * @param {string} url 目标 URL
 * @returns {Promise<{title: string, text?: string, url?: string, invalid?: boolean, error?: string, _injectionWarning?: string}>} 页面内容（失败返回 error）
 */
export async function toolFetchPage(url) {
  const raw = String(url || "").trim();
  // SSRF 防护：只允许公网 http(s) URL；拒绝内网/环回/云元数据/文件协议（防被恶意页面或注入引导访问内网）
  if (!/^https?:\/\//i.test(raw)) return { error: "仅支持 http/https 链接", title: "" };
  try {
    // 硬化 SSRF 校验：URL 归一化（十进制/十六进制/八进制 IP、尾点、IPv6 映射）+ DNS 解析（防 DNS-rebinding）
    // fetch-page.mjs 内部还有第二道强制守卫（唯一 choke point），此处早退只为给 LLM 干净的错误回填
    await assertPublicUrl(raw);
  } catch (e) {
    return { error: e.message || "URL 无效", title: "" };
  }
  const isJuejin = /juejin\.cn\/post/.test(raw);
  // Node fetch 版抓取（修复：fetchPage 的 Playwright 卡死（事件循环阻塞无法快速失败）——
  // 普通页面（CSDN/知乎服务端渲染）Node fetch 能拿 HTML——快 + 不卡；SSRF 前置校验已在上方保留；
  // 掘金 SPA 走 API 由 toolSearchPosts 拦截，此处正文抓取用 Node fetch 覆盖服务端渲染页
  let html;
  let finalUrl;
  try {
    const r = await fetch(raw, {
      headers: { "User-Agent": FETCH_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    // 安全工单 M3：重定向后复检 finalUrl（302 到内网绕过前置校验——redirect:follow 后
    // r.url 是最终 URL——必须再次 assertPublicUrl——防 SSRF 重定向旁路）
    if (r.url && r.url !== raw) {
      try { await assertPublicUrl(r.url); } catch (e) { return { error: `重定向目标非法: ${e.message}`, title: "" }; }
    }
    if (!r.ok) return { error: `HTTP ${r.status}`, title: "" };
    html = await r.text();
    finalUrl = r.url || raw;
  } catch (e) {
    return { error: `抓取失败: ${String(e?.message || e).slice(0, 60)}`, title: "" };
  }
  // 提取正文（复用 fetch-page 的 extractArticle——JSDOM + Readability）
  // 修复：Readability 偏向长正文——牛客真题页（列表页）会提取到页脚（<200 字符）而非真题列表；
  // Readability 结果太短时回落 innerText 近似（去 script/style/标签——真题列表在可见文本里）
  const { extractArticle } = await import("../fetch-page.mjs");
  let article = null;
  try { article = extractArticle(html, raw); } catch { /* 解析失败回落纯文本 */ }
  const plainText = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
  const articleText = (article?.textContent || "").trim();
  const bodyText = articleText.length > 200 ? articleText : plainText;
  const page = {
    title: article?.title || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()?.slice(0, 120) || raw,
    text: bodyText,
    invalid: false,
    url: finalUrl,
  };
  memory.markSeen(raw);
  if (page.invalid || !page.text) return { error: "页面无效（404/内容为空）", title: page.title };
  // 提示注入防护：外部页面内容视为不可信数据（包裹标记，防恶意页面劫持 LLM）——标题同样包裹
  try {
    const { detectInjection } = await import("../prompt-guard.mjs");
    const injections = detectInjection(page.text);
    return {
      title: wrapUntrusted(page.title),
      text: wrapUntrusted(page.text.slice(0, 6000)),
      _injectionWarning: injections.length
        ? `⚠️ 页面内容检测到疑似提示注入（${injections.map((i) => i.name).join("、")}），内容已隔离为不可信数据`
        : undefined,
    };
  } catch {
    return { title: wrapUntrusted(page.title), text: wrapUntrusted(page.text.slice(0, 6000)) };
  }
}

/**
 * 浏览工具路由（按 name 分发到具体实现）
 * @param {string} name 工具名
 * @param {any} args 工具参数
 * @returns {Promise<any>} 工具结果
 */
export async function toolBrowse(name, args) {
  try {
    const mod = await import("../fetch-page.mjs");
    switch (name) {
      case "browse_open": {
        const ctx = await mod.browseContext(args.url);
        if (!ctx) return { error: "页面打开失败（URL 无效、超时或 SSRF 拦截）" };
        try {
          return { ok: true, title: await ctx.page.title(), url: ctx.page.url() };
        } finally {
          try { await ctx.close?.(); } catch { /* ignore */ }
        }
      }
      case "browse_click": {
        const r = await mod.browseClick(args.url, args.target);
        return r.ok ? r : { error: r.error || "点击失败" };
      }
      case "browse_scroll": {
        const times = Number(args.times);
        const r = await mod.browseScroll(args.url, { times: Number.isFinite(times) ? Math.min(Math.max(times, 1), 10) : 3 });
        return r.ok ? r : { error: r.error || "滚动失败" };
      }
      case "browse_type": {
        const pressEnter = args.pressEnter !== false;
        const r = await mod.browseType(args.url, args.selector, args.text, { pressEnter });
        return r.ok ? r : { error: r.error || "输入失败" };
      }
      case "browse_screenshot": {
        const DEFAULT_SHOT = `data/tool_results/shot-${Date.now()}.jpg`;
        let outPath = args.path || DEFAULT_SHOT;
        // 路径白名单：LLM 提供的 path resolve 后必须位于 data/tool_results/ 或 os.tmpdir() 下，
        // 否则忽略 path 用默认值（防 LLM 写任意路径；参照 read_tool_result 的白名单做法）
        try {
          const pathMod = await import("node:path");
          const { tmpdir } = await import("node:os");
          const root = pathMod.join(import.meta.dirname, "..", "..");
          const resultsDir = pathMod.resolve(pathMod.join(root, "data", "tool_results"));
          const tmpRoot = pathMod.resolve(tmpdir());
          const target = pathMod.resolve(String(outPath)); // 绝对路径直接解析；相对路径基于 cwd
          const insideResults = target === resultsDir || target.startsWith(resultsDir + pathMod.sep);
          const insideTmp = target === tmpRoot || target.startsWith(tmpRoot + pathMod.sep);
          if (!insideResults && !insideTmp) outPath = DEFAULT_SHOT;
        } catch { outPath = DEFAULT_SHOT; }
        const r = await mod.browseScreenshot(args.url, { path: outPath });
        return r.ok
          ? { ok: true, path: r.path, title: r.title, note: "截图已保存，可利用图片分析页面布局/图表/验证码" }
          : { error: r.error || "截图失败" };
      }
      case "browse_fetch": {
        const waitMs = Number(args.waitMs);
        const r = await mod.browseExtract(args.url, { waitMs: Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), 10000) : 800 });
        if (!r.ok) return { error: r.error || "页面抓取失败" };
        memory.markSeen(args.url);
        return {
          ok: true,
          title: wrapUntrusted(r.title),
          text: wrapUntrusted(String(r.text || "").slice(0, 6000)),
          links: (r.links || []).slice(0, 20).map((l) => ({ title: String(l.text || "").slice(0, 80), url: l.href })),
          _note: "页面内容为外部数据，已标记为不可信",
        };
      }
      default:
        return { error: `未知浏览操作: ${name}` };
    }
  } catch (e) {
    return { error: `${name} 失败: ${String(e.message || e).slice(0, 150)}` };
  }
}
