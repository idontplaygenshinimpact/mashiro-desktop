// 抓取模块：Playwright 打开页面 → 注入 Readability 提取正文 → 返回结构化文本
import { chromium } from "playwright";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
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
    await page.goto(url, { waitUntil, timeout: config.navTimeout });
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
 * 批量抓取（串行，避免被反爬；每个之间小延迟）
 */
export async function fetchPages(urls, opts = {}) {
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetchPage(u, opts);
      out.push({ ok: true, ...r });
    } catch (e) {
      out.push({ ok: false, url: u, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return out;
}
