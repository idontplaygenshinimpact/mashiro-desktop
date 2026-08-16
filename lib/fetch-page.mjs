// 抓取模块：Playwright 打开页面 → 注入 Readability 提取正文 → 返回结构化文本
import { chromium } from "playwright";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.mjs";

// 需要 jsdom 支持 Readability 在 Node 端运行
let browserPromise = null;

/**
 * 从 HTML 提取正文（导出供 edge-session 等模块复用）
 * @param {string} html 完整页面 HTML
 * @param {string} url 页面 URL（供 Readability 相对链接解析）
 * @returns {{title: string, textContent: string}|null} Readability parse 结果或 null
 */
export function extractArticle(html, url) {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document, {
    charThreshold: 200,
    keepClasses: false,
  }).parse();
  return article;
}

async function getBrowser() {
  // 缓存 launch 的 Promise（而非 resolve 后的 browser）：并发 fetchPage 同时看到 null 时，
  // 只会触发一次 launch，避免多次 launch 泄漏 Chromium（每个数百 MB）
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      })
      .catch((e) => {
        browserPromise = null; // launch 失败清空缓存，允许下次重试
        throw e;
      });
  }
  return await browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b) await b.close().catch(() => {});
    browserPromise = null;
  }
  await closeBrowseSession();
}

// ---------- SSRF 防护（fetch-page 是抓取唯一 choke point，保护它 = 保护所有 11 个调用方） ----------
/** 判断 IP 是否私有/环回/链路本地/云元数据/未指定/共享地址（IPv4 + IPv6，含 IPv4 映射） */
export function isPrivateIP(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)             // CGNAT 100.64/10 共享地址
      || (a === 169 && b === 254)                       // 链路本地 + 云元数据 169.254.169.254
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)                         // 192.0.0.0/24
      || (a === 198 && (b === 18 || b === 19));         // 198.18/15 基准测试
  }
  if (v === 6) {
    const a = ip.toLowerCase();
    if (a === "::" || a === "::1") return true;
    // IPv4 映射（::ffff:a.b.c.d / ::ffff:xxxx:xxxx）与 NAT64（64:ff9b::/96）→ 展开检查内嵌 IPv4
    const mapped = embeddedIPv4(a);
    if (mapped) return isPrivateIP(mapped);
    const first = a.split(":")[0];
    if (first.startsWith("fc") || first.startsWith("fd")) return true; // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(first)) return true;           // fe80::/10 链路本地
    if (/^fec/.test(first)) return true;                 // fec0::/10 站点本地（弃用）
    return false;
  }
  return false;
}

// 从 IPv4 映射/NAT64 IPv6 提取内嵌 IPv4（点分十进制或十六进制双组），无则返回 null
function embeddedIPv4(ipv6) {
  const a = ipv6.toLowerCase();
  let rest = null;
  if (a.startsWith("::ffff:")) rest = a.slice(7);
  else if (a.startsWith("64:ff9b::")) rest = a.slice(9);
  if (rest === null) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest; // 127.0.0.1
  const parts = rest.split(":");
  if (parts.length === 2 && /^[0-9a-f]{1,4}$/i.test(parts[0]) && /^[0-9a-f]{1,4}$/i.test(parts[1])) {
    const hi = parseInt(parts[0], 16);
    const lo = parseInt(parts[1], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

// 内部域名黑名单（无需 DNS）：localhost / .local / .internal / .lan / .home.arpa 等
const BLOCKED_DOMAIN_RE = /(^|\.)(localhost|local|internal|lan|home\.arpa|corp|intranet)$/i;

function stripHostBrackets(h) {
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h;
}

/** 静态（无需 DNS）判断 hostname 是否指向内网：IP 字面量 + 内部域名黑名单 */
export function isPrivateHostname(hostname) {
  const h = stripHostBrackets(String(hostname || "")).replace(/\.+$/, "").toLowerCase();
  if (!h) return true;
  const v = isIP(h);
  if (v === 4 || v === 6) return isPrivateIP(h);
  return BLOCKED_DOMAIN_RE.test(h);
}

/** 完整 SSRF 校验（含 DNS 解析，拦截 DNS-rebinding/nip.io 类域名）：指向内网抛错 */
export async function assertPublicHostname(hostname) {
  const h = stripHostBrackets(String(hostname || "")).replace(/\.+$/, "").toLowerCase();
  if (!h) throw new Error("URL 无效");
  const v = isIP(h);
  if (v === 4 || v === 6) {
    if (isPrivateIP(h)) throw new Error("拒绝访问内网/本机地址（SSRF 防护）");
    return;
  }
  if (BLOCKED_DOMAIN_RE.test(h)) throw new Error("拒绝访问内网/本机地址（SSRF 防护）");
  let addrs;
  try {
    // all: 解析全部 A/AAAA 记录；任一解析到内网即拒绝（防 DNS-rebinding）
    addrs = await lookup(h, { all: true });
  } catch {
    throw new Error(`域名解析失败（SSRF 防护）: ${h}`);
  }
  for (const { address } of addrs) {
    if (isPrivateIP(address)) throw new Error("拒绝访问内网/本机地址（SSRF 防护）");
  }
}

/** 校验 URL：仅 http/https + 非内网（解析 host + DNS 校验） */
export async function assertPublicUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error("URL 无效");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }
  await assertPublicHostname(u.hostname);
  return u;
}

// 常用伪装 headers，降低被识别为爬虫的概率
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 抓取单个 URL，返回 { url, title, text, links }
 * text: 提取后的正文（纯文本，去导航/广告/评论区）
 * links: 页面内所有 <a> 链接（供"顺藤摸瓜"用）
 * 反爬/SPA 增强：
 *   waitUntil: "networkidle" 等网络空闲（SPA 数据加载完，掘金文章正文等）
 *   waitSelector: 等特定 DOM 出现（搜索结果容器）
 *   apiPattern: 拦截匹配的 XHR 响应（掘金搜索走 API，绕过风控）→ apiResponses
 */
export async function fetchPage(url, { maxTextChars = 60000, collectLinks = false, waitUntil = "domcontentloaded", waitSelector = null, apiPattern = null, waitMs = 800, rawText = false } = {}) {
  // SSRF 防护（唯一 choke point）：仅 http/https + 拒绝内网/环回/链路本地（含 DNS 解析，防 DNS-rebinding）
  await assertPublicUrl(url);
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: UA,
    locale: "zh-CN",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  try {
    // 阻止导航/子资源访问内网（302 重定向到内网会在路由层被拦下，而非 goto 完成后才发现）
    await page.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      const doc = route.request().resourceType() === "document";
      try {
        const u = new URL(reqUrl);
        if (u.protocol === "http:" || u.protocol === "https:") {
          if (doc) await assertPublicHostname(u.hostname); // 主文档/重定向：完整 DNS 校验
          else if (isPrivateHostname(u.hostname)) throw new Error("private"); // 子资源：静态快速校验
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    // 拦截 API 响应（真实浏览器执行请求 → 过风控 → 我们拿 JSON）
    const apiResponses = [];
    if (apiPattern) {
      page.on("response", async (resp) => {
        try {
          if (resp.url().includes(apiPattern)) {
            const ct = resp.headers()["content-type"] || "";
            if (ct.includes("json")) apiResponses.push(await resp.json());
          }
        } catch { /* ignore */ }
      });
    }
    // goto 失败自动重试一次（网络抖动/瞬时风控），二次失败才抛（调用方已有降级保护）
    let gotoErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(url, { waitUntil, timeout: config.navTimeout });
        gotoErr = null;
        break;
      } catch (e) {
        gotoErr = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (gotoErr) throw gotoErr;
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 12000 }).catch(() => {});
    } else {
      await page.waitForTimeout(waitMs);
    }

    const result = await page.evaluate(
      ({ collectLinks }) => {
        const title = document.title || "";
        let links = [];
        if (collectLinks) {
          links = Array.from(document.querySelectorAll("a[href]"))
            .map((a) => ({ text: (a.textContent || "").trim().slice(0, 80), href: /** @type {HTMLAnchorElement} */ (a).href }))
            .filter((l) => l.text && /^https?:/.test(l.href))
            .slice(0, 300);
        }
        return { title, html: document.documentElement.outerHTML, links };
      },
      { collectLinks }
    );

    // Readability 在 Node 端解析：去掉 script/style 再提正文
    const article = extractArticle(result.html, url);

    let text;
    if (rawText) {
      // 结构化页面（版本列表/changelog）Readability 会把列表当导航删掉 → 直接取 body innerText
      text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    } else {
      text = article?.textContent?.trim() || "";
    }
    if (text.length > maxTextChars) text = text.slice(0, maxTextChars);

    // 安全验证页检测：标题/正文含验证特征 且 正文极短（<800字符）→ 标记无效，省掉无效 classify
    const isBlocked = /安全验证|Security Verification|请完成验证|请完成安全验证|滑块验证/i.test(
      (result.title || "") + " " + text.slice(0, 300)
    ) && text.length < 800;
    if (isBlocked) {
      return { url, title: "blocked", text, links: result.links, length: text.length, invalid: true, apiResponses };
    }

    // 无效页面检测：404 / 标题异常 / 正文过短（有 API 响应的页面不算无效——数据在 apiResponses 里）
    const is404 = /404|not found|页面不存在|访问出错/i.test(result.title) && text.length < 500;
    if ((is404 || text.length < 100) && apiResponses.length === 0) {
      return { url, title: "404", text: "", links: [], length: 0, invalid: true, apiResponses: [] };
    }

    return {
      url,
      title: article?.title || result.title || url,
      text,
      links: result.links,
      length: text.length,
      apiResponses,
    };
  } finally {
    await context.close();
  }
}

/**
 * 批量抓取（4 并发提速 + 400ms 防风控小延迟；单条失败不拖累）
 */
export async function fetchPages(urls, opts = {}) {
  const out = [];
  const CONCURRENCY = 4;
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
    while (idx < urls.length) {
      const u = urls[idx++];
      try {
        const r = await fetchPage(u, opts);
        out.push({ ok: true, ...r });
      } catch (e) {
        out.push({ ok: false, url: u, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 400)); // 防风控小延迟
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- P2 浏览器交互层（browse*）：给 agent 真正的浏览能力 ----------
// 与 fetchPage 同一套 SSRF 防护 + newContext 设置；所有函数吞异常，返回 {ok, ...} 而非抛出。
// 每个函数独立 open→goto→finally 关闭 context，绝不泄漏 Chromium 资源。

/** 复用 fetchPage 的 SSRF 防护 + newContext 设置打开页面（含路由层内网拦截），失败抛错
 * 导出供平台模块（boss 等）注入登录态 cookie 后自由操作页面 */
export async function openPage(url) {
  await assertPublicUrl(url);
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: UA,
    locale: "zh-CN",
    viewport: { width: 1366, height: 900 },
  });
  let page;
  try {
    page = await context.newPage();
    await page.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      const doc = route.request().resourceType() === "document";
      try {
        const u = new URL(reqUrl);
        if (u.protocol === "http:" || u.protocol === "https:") {
          if (doc) await assertPublicHostname(u.hostname);
          else if (isPrivateHostname(u.hostname)) throw new Error("private");
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    return { page, context };
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
}

// ---------- 持久浏览会话（browse_* 跨工具共享 cookie/登录态；空闲 30 分钟回收） ----------
// 解决"会话不持久"缺陷：agent 连续 browse_open → click → type 时登录态/搜索词上下文不丢
let browseSession = null; // { context, lastUsed, timer }
const BROWSE_SESSION_IDLE_MS = 30 * 60 * 1000;

async function getBrowseSession() {
  if (browseSession) {
    browseSession.lastUsed = Date.now();
    return browseSession.context;
  }
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: UA,
    locale: "zh-CN",
    viewport: { width: 1366, height: 900 },
  });
  // 会话上下文同样挂路由层 SSRF 防护（内网拦截与独立 context 一致）
  await context.route("**/*", async (route) => {
    const reqUrl = route.request().url();
    const doc = route.request().resourceType() === "document";
    try {
      const u = new URL(reqUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        if (doc) await assertPublicHostname(u.hostname);
        else if (isPrivateHostname(u.hostname)) throw new Error("private");
      }
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
  browseSession = { context, lastUsed: Date.now(), timer: null };
  scheduleBrowseSessionReap();
  return context;
}

function scheduleBrowseSessionReap() {
  if (!browseSession) return;
  clearTimeout(browseSession.timer);
  browseSession.timer = setTimeout(async () => {
    const s = browseSession;
    if (s && Date.now() - s.lastUsed > BROWSE_SESSION_IDLE_MS) {
      browseSession = null;
      await s.context.close().catch(() => {});
      console.log("[fetch] 持久浏览会话空闲回收");
    } else if (s) {
      scheduleBrowseSessionReap(); // 未超时继续盯
    }
  }, BROWSE_SESSION_IDLE_MS);
}

/** 关闭持久浏览会话（closeBrowser 时调用；browse_* 登录态清空） */
export async function closeBrowseSession() {
  if (browseSession) {
    clearTimeout(browseSession.timer);
    await browseSession.context.close().catch(() => {});
    browseSession = null;
  }
}

/** 在持久会话中开一个新 page（带 SSRF 校验；页面用完由调用方 page.close()，会话保持） */
async function openSessionPage(url) {
  await assertPublicUrl(url);
  const context = await getBrowseSession();
  return { page: await context.newPage() };
}

/**
 * 打开一个可交互页面（带 SSRF 防护），返回 {page, context, close()} 供调用方自由操作。
 * 使用持久会话：close() 只关当前 page，跨 browse_* 调用的 cookie/登录态保持（空闲自动回收）。
 * SSRF 拦截 / 浏览器启动失败 / 导航失败 → 返回 null（不抛错）。
 */
export async function browseContext(url) {
  let opened;
  try {
    opened = await openSessionPage(url);
  } catch {
    return null;
  }
  try {
    await opened.page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
  } catch {
    await opened.page.close().catch(() => {});
    return null;
  }
  return {
    page: opened.page,
    context: null, // 会话 context 不暴露（调用方不该关它）
    close: async () => {
      await opened.page.close().catch(() => {});
    },
  };
}

/**
 * 打开页面并点击元素（CSS selector / {text} 文本 / {index} 第 N 个可点击元素），
 * 点击后短暂等待（让跳转/异步渲染生效），返回 {ok, url, title}；任何错误 → {ok:false, error}。
 */
export async function browseClick(url, target) {
  let page = null;
  try {
    const opened = await openSessionPage(url);
    page = opened.page;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
    if (typeof target === "string") {
      await page.waitForSelector(target, { timeout: 12000 });
      await page.click(target, { timeout: 12000 });
    } else if (target && typeof target === "object") {
      if (target.text !== undefined) {
        await page.getByText(String(target.text)).first().click({ timeout: 12000 });
      } else if (target.index !== undefined) {
        await page
          .locator('a, button, [role="button"], input[type="submit"]')
          .nth(Number(target.index))
          .click({ timeout: 12000 });
      } else {
        return { ok: false, error: "browseClick 需要 selector 字符串或 {text} / {index}" };
      }
    } else {
      return { ok: false, error: "browseClick 需要 selector 字符串或 {text} / {index}" };
    }
    await page.waitForTimeout(800);
    return { ok: true, url: page.url(), title: await page.title() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 打开页面并滚动到底部 N 次（触发无限滚动列表加载），返回 {ok, title, url}。
 */
export async function browseScroll(url, { times = 3, delayMs = 600 } = {}) {
  let page = null;
  try {
    const opened = await openSessionPage(url);
    page = opened.page;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
    for (let i = 0; i < times; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(delayMs);
    }
    return { ok: true, title: await page.title(), url: page.url() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 打开页面 → 填充输入框（搜索框/登录表单）→ 可选回车，返回 {ok, title, url}。
 */
export async function browseType(url, selector, text, { pressEnter = true } = {}) {
  let page = null;
  try {
    const opened = await openSessionPage(url);
    page = opened.page;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
    await page.waitForSelector(selector, { timeout: 12000 });
    await page.fill(selector, String(text));
    if (pressEnter) await page.press(selector, "Enter");
    await page.waitForTimeout(800);
    return { ok: true, title: await page.title(), url: page.url() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 打开页面截图（JPEG quality 70），保存到指定 path 或临时目录，返回 {ok, path, title}。
 * selector 可选：截取指定元素；fullPage 可选：整页截图（仅整页截图生效）。
 * 视觉能力基础：agent 后续可把 path 交给多模态模型分析页面。
 */
export async function browseScreenshot(url, { selector = null, fullPage = false, path: outPath = null } = {}) {
  let page = null;
  try {
    const opened = await openSessionPage(url);
    page = opened.page;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
    await page.waitForTimeout(900);
    const dest = outPath || path.join(tmpdir(), `mianshi-browse-${Date.now()}.jpg`);
    if (outPath) {
      const dir = path.dirname(outPath);
      if (dir) mkdirSync(dir, { recursive: true });
    }
    if (selector) {
      await page.locator(selector).first().screenshot({ type: "jpeg", quality: 70, path: dest });
    } else {
      await page.screenshot({ type: "jpeg", quality: 70, fullPage, path: dest });
    }
    return { ok: true, path: dest, title: await page.title() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * 打开页面 → 等待 → 提取标题 + 正文（Readability 同 fetchPage）+ 全部链接，
 * 返回 {ok, title, text, links}。本质是带显式等待的 fetchPage。
 */
export async function browseExtract(url, { selector = null, waitMs = 800 } = {}) {
  let page = null;
  try {
    const opened = await openSessionPage(url);
    page = opened.page;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
    if (selector) {
      await page.waitForSelector(selector, { timeout: 12000 }).catch(() => {});
    } else {
      await page.waitForTimeout(waitMs);
    }
    const result = await page.evaluate(() => {
      const title = document.title || "";
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({ text: (a.textContent || "").trim().slice(0, 80), href: /** @type {HTMLAnchorElement} */ (a).href }))
        .filter((l) => l.text && /^https?:/.test(l.href))
        .slice(0, 300);
      return { title, html: document.documentElement.outerHTML, links };
    });
    const article = extractArticle(result.html, url);
    let text = article?.textContent?.trim() || "";
    if (text.length > 60000) text = text.slice(0, 60000);
    return { ok: true, title: article?.title || result.title || url, text, links: result.links };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
