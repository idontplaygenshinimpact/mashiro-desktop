// BOSS 直聘平台（zhipin.com）：岗位搜索 / 详情 / 半自动投递（打招呼式沟通）
// 设计分层：
//   解析层（纯函数，可单测）：parseJobCards / parseJobDetail / detectBlock —— 输入 HTML，输出结构化数据
//   浏览器层（真实 Playwright）：openPage + 登录态 cookie 注入；风控/登录检测；失败返回 {ok:false} 不抛
// 登录态来源（优先级）：平台账号配置里粘贴的 Cookie 头 > Edge/Chrome 浏览器会话（readBrowserCookies）
// 投递 = 打开岗位 → 点「立即沟通」→ 发送预设招呼语（BOSS 沟通式投递）；由上层审批 + 频率限制把关
import { JSDOM } from "jsdom";
import { getAccount } from "../platform-accounts.mjs";
import { readBrowserCookies } from "../chrome-cookies.mjs";

export const platform = {
  name: "boss",
  label: "BOSS 直聘",
  authRequired: true,
  authMethods: ["cookie", "edge"],

  searchJobs,
  fetchDetail,
  prepareApply,
};

// ================= 解析层（纯函数，可测） =================

/** 从搜索页 HTML 提取岗位卡片列表（容错多选择器） */
export function parseJobCards(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const cards = doc.querySelectorAll(".job-card-wrapper, .job-list-box li, .search-job-result .job-card");
  const jobs = [];
  for (const c of cards) {
    const link = c.querySelector('a[href*="/job_detail/"]') || c.querySelector('a[href*="job_detail"]');
    const href = link ? link.getAttribute("href") : "";
    const m = String(href).match(/\/job_detail\/([\w-]+)\.html/);
    if (!m) continue;
    const title = clean(c.querySelector(".job-name, .job-title, .job-info .job-name")?.textContent);
    const company = clean(c.querySelector(".company-name, .company-info a, .boss-name")?.textContent);
    const salary = clean(c.querySelector(".salary, .red, .job-salary")?.textContent);
    const location = clean(c.querySelector(".job-area, .job-location, .location")?.textContent);
    if (!title) continue;
    jobs.push({
      id: m[1],
      title: title.slice(0, 60),
      company: (company || "未知公司").slice(0, 40),
      salary: salary.slice(0, 30),
      location: location.slice(0, 40),
      url: `https://www.zhipin.com/job_detail/${m[1]}.html`,
    });
    if (jobs.length >= 30) break;
  }
  return jobs;
}

/** 从详情页 HTML 提取岗位信息 + JD 正文 */
export function parseJobDetail(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const title = clean(doc.querySelector(".name, h1, .job-title")?.textContent);
  const company = clean(doc.querySelector(".company-name, .company-info .name, .sider-company a")?.textContent);
  const salary = clean(doc.querySelector(".salary, .red, .job-salary")?.textContent);
  const jdText = clean(doc.querySelector(".job-sec-text, .job-detail, .description, .text")?.textContent);
  const tags = [...doc.querySelectorAll(".tag-list li, .job-tags span, .labels span")]
    .map((t) => clean(t.textContent)).filter(Boolean).slice(0, 12);
  return { title, company, salary, jdText: jdText.slice(0, 4000), tags };
}

/** 风控/登录/验证码检测：命中返回原因，否则 null */
export function detectBlock(html, title = "") {
  const text = String(title) + " " + String(html || "").slice(0, 2000);
  if (/安全验证|请完成验证|访问验证|滑动验证|verify|geetest/i.test(text)) return "触发安全验证（风控），需人工处理";
  if (/扫码登录|请登录|登录后查看|登录后才能/i.test(text) && !/已登录|欢迎/.test(text)) return "未登录，请先在浏览器登录 BOSS 直聘并导入登录态";
  return null;
}

// ================= 浏览器层（真实操作） =================

function clean(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/** 解析用户粘贴的 Cookie 头（"a=b; c=d" 或 name=value 对）→ Playwright cookie 数组 */
export function parseCookieHeader(cookieStr) {
  const raw = String(cookieStr || "").trim();
  if (!raw) return [];
  return raw.split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;
      const value = pair.slice(eq + 1).trim();
      if (!value) return null; // 空值对跳过
      return { name: pair.slice(0, eq).trim(), value, domain: ".zhipin.com", path: "/" };
    })
    .filter(Boolean);
}

/** 获取 BOSS 登录态 cookie：配置的 Cookie 头优先，其次浏览器会话；无 → null */
async function resolveCookies() {
  const acc = getAccount("boss");
  if (acc?.authMethod === "cookie" && acc.cookie) {
    const parsed = parseCookieHeader(acc.cookie);
    if (parsed.length) return { source: "config-cookie", cookies: parsed };
  }
  try {
    const fromBrowser = await readBrowserCookies("%zhipin.com");
    if (fromBrowser && fromBrowser.length) {
      return {
        source: "browser-session",
        cookies: fromBrowser.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" })),
      };
    }
  } catch { /* 浏览器读取失败走无登录态 */ }
  return null;
}

/** 打开页面（SSRF 防护 + 登录态注入），返回 {page, context}；调用方 finally close */
async function openWithSession(url) {
  const { openPage } = await import("../fetch-page.mjs");
  const session = await resolveCookies();
  const opened = await openPage(url); // SSRF + 路由内网拦截 + newContext
  try {
    if (session) await opened.context.addCookies(session.cookies);
  } catch (e) {
    console.log(`[boss] cookie 注入失败: ${String(e.message).slice(0, 80)}`);
  }
  return { ...opened, session };
}

/** 搜索岗位 */
export async function searchJobs(keyword, { limit = 15, city = "100010000" } = {}) {
  const url = `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}&city=${city}`;
  const opened = await openWithSession(url);
  try {
    const { page } = opened;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // 等列表渲染（卡片或空结果提示）
    try {
      await page.waitForSelector(".job-card-wrapper, .job-list-box li, .search-job-result, .job-empty, .no-result", { timeout: 15000 });
    } catch { /* 超时继续，走文本提取 */ }
    const html = await page.content();
    const blocked = detectBlock(html, await page.title());
    if (blocked) return { ok: false, error: blocked, needLogin: blocked.includes("未登录") };
    const jobs = parseJobCards(html).slice(0, limit);
    if (!jobs.length) {
      const empty = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || "");
      return { ok: false, error: `未解析到岗位（页面可能改版或无结果）：${String(empty).slice(0, 120)}` };
    }
    return { ok: true, jobs, source: opened.session?.source || "no-session" };
  } catch (e) {
    return { ok: false, error: `搜索失败: ${String(e?.message || e).slice(0, 150)}` };
  } finally {
    await opened.context.close().catch(() => {});
  }
}

/** 抓取岗位详情 */
export async function fetchDetail(url) {
  const opened = await openWithSession(String(url));
  try {
    const { page } = opened;
    await page.goto(String(url), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1200);
    const html = await page.content();
    const blocked = detectBlock(html, await page.title());
    if (blocked) return { ok: false, error: blocked, needLogin: blocked.includes("未登录") };
    const detail = parseJobDetail(html);
    if (!detail.title && !detail.jdText) return { ok: false, error: "详情解析失败（页面可能改版或岗位已下架）" };
    return { ok: true, ...detail };
  } catch (e) {
    return { ok: false, error: `详情抓取失败: ${String(e?.message || e).slice(0, 150)}` };
  } finally {
    await opened.context.close().catch(() => {});
  }
}

/** 半自动投递：点「立即沟通」→ 发招呼语。调用方（agent/面板）必须先过审批 + 频率限制 */
export async function prepareApply(url, { greeting = "" } = {}) {
  const opened = await openWithSession(String(url));
  const msg = String(greeting || getAccount("boss")?.greeting || "").trim();
  try {
    const { page } = opened;
    await page.goto(String(url), { waitUntil: "domcontentloaded", timeout: 45000 });
    // 等按钮渲染
    try {
      await page.waitForSelector(".btn-startchat, .op-btn, button", { timeout: 12000 });
    } catch { /* 超时继续 */ }
    const html = await page.content();
    const blocked = detectBlock(html, await page.title());
    if (blocked) return { ok: false, error: blocked, needLogin: blocked.includes("未登录") };
    // 已沟通检测：页面出现"已沟通"标记 → 不重复投递
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    if (/已沟通|已打招呼/.test(bodyText.slice(0, 800))) {
      return { ok: false, error: "该岗位已沟通过，不重复投递" };
    }
    // 找「立即沟通」按钮：类名多候选 + 文本兜底
    let clicked = false;
    for (const sel of [".btn-startchat", ".op-btn", ".btn.btn-startchat"]) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        try {
          await btn.click({ timeout: 8000 });
          clicked = true;
        } catch {
          // 修复：点击失败不再吞掉假装成功 → 如实上报，提示人工处理
          return { ok: false, error: "发送失败: 点击「立即沟通」按钮失败，请手动投递", needManual: true };
        }
        break;
      }
    }
    if (!clicked) {
      const byText = page.getByText("立即沟通", { exact: true }).first();
      if (await byText.count()) {
        try {
          await byText.click({ timeout: 8000 });
          clicked = true;
        } catch {
          return { ok: false, error: "发送失败: 点击「立即沟通」按钮失败，请手动投递", needManual: true };
        }
      }
    }
    if (!clicked) return { ok: false, error: "未找到「立即沟通」按钮（岗位可能已下架或需登录）" };
    await page.waitForTimeout(1500);
    // 登录弹窗检测（点击后弹出登录框）
    const after = await page.evaluate(() => document.body?.innerText?.slice(0, 400) || "");
    if (/扫码登录|手机号登录|验证码登录/.test(after)) {
      return { ok: false, error: "点击沟通后弹出登录框，登录态失效，请重新导入", needLogin: true };
    }
    // 找聊天输入框并发送招呼语
    if (msg) {
      const input = page.locator(".chat-input textarea, textarea[placeholder*='输入'], .chat-area textarea").first();
      if (await input.count()) {
        try {
          await input.fill(msg, { timeout: 8000 });
        } catch {
          // 修复：填充/发送失败不再吞掉假装 sent:true → 如实上报，提示人工处理
          return { ok: false, error: "发送失败: 招呼语填充消息输入框失败，请手动发送", needManual: true };
        }
        try {
          await page.keyboard.press("Enter");
        } catch {
          return { ok: false, error: "发送失败: 招呼语发送失败（回车未生效），请手动发送", needManual: true };
        }
        await page.waitForTimeout(1200);
        return { ok: true, detail: "已发送沟通消息（打招呼），对话已在 BOSS 中建立", sent: true };
      }
      // 输入框未找到但按钮点开了：如实说明（可能弹的是窗口/需继续点）
      return { ok: true, detail: "已点击「立即沟通」，但未找到消息输入框（可能已建立会话，请在 BOSS 中确认）", sent: false };
    }
    return { ok: true, detail: "已点击「立即沟通」（未配置招呼语，未发送消息）", sent: false };
  } catch (e) {
    return { ok: false, error: `投递执行失败: ${String(e?.message || e).slice(0, 150)}` };
  } finally {
    await opened.context.close().catch(() => {});
  }
}
