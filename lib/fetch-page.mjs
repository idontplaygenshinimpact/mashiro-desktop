// 抓取模块：Playwright 打开页面 → 注入 Readability 提取正文 → 返回结构化文本
import { chromium } from "playwright";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { config } from "../config.mjs";

// 需要 jsdom 支持 Readability 在 Node 端运行
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
  }
  return browser;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

// 常用伪装 headers，降低被识别为爬虫的概率
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * 抓取单个 URL，返回 { url, title, text, links }
 * text: 提取后的正文（纯文本，去导航/广告/评论区）
 * links: 页面内所有 <a> 链接（供"顺藤摸瓜"用）
 */
export async function fetchPage(url, { maxTextChars = 60000, collectLinks = false } = {}) {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: UA,
    locale: "zh-CN",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeout });
    // 等待可能懒加载的内容（缩短：搜索页 SSR 内容即时可用）
    await page.waitForTimeout(800);

    const result = await page.evaluate(
      ({ collectLinks }) => {
        const title = document.title || "";
        let links = [];
        if (collectLinks) {
          links = Array.from(document.querySelectorAll("a[href]"))
            .map((a) => ({ text: (a.textContent || "").trim().slice(0, 80), href: a.href }))
            .filter((l) => l.text && /^https?:/.test(l.href))
            .slice(0, 300);
        }
        return { title, html: document.documentElement.outerHTML, links };
      },
      { collectLinks }
    );

    // Readability 在 Node 端解析：去掉 script/style 再提正文
    const dom = new JSDOM(result.html, { url });
    const article = new Readability(dom.window.document, {
      charThreshold: 200,
      keepClasses: false,
    }).parse();

    let text = article?.textContent?.trim() || "";
    if (text.length > maxTextChars) text = text.slice(0, maxTextChars);

    // 无效页面检测：404 / 标题异常 / 正文过短
    const is404 = /404|not found|页面不存在|访问出错/i.test(result.title) && text.length < 500;
    if (is404 || text.length < 100) {
      return { url, title: "404", text: "", links: [], length: 0, invalid: true };
    }

    return {
      url,
      title: article?.title || result.title || url,
      text,
      links: result.links,
      length: text.length,
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
