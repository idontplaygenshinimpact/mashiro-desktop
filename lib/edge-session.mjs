// Edge 登录态会话：复制 Edge profile → launchPersistentContext（复用真实浏览器登录态）
// 绝不直接写用户 Edge profile 目录——只读复制到 data/edge-user-profile
// Cookies 在 SQLite 中加密，Edge 在 HTTP 请求时自动解密——Playwright context.cookies() 不可见
// 登录态验证通过实际访问牛客页面（非验证页 = 登录成功）
import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { config } from "../config.mjs";

let sessionCtx = null;
let sessionReady = false;
let sessionError = null;

// 打包版：MIANSHI_DATA_DIR 由主进程注入（asar 只读，Edge 登录 profile 需可写目录）
const EDGE_PROFILE_DIR = path.join(process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "data"), "edge-user-profile");

// 清理残留的 Edge 会话进程（上次崩溃/异常退出时 context.close() 没执行完会残留 msedge
// 锁住 data/edge-user-profile 的 Cookies 文件，导致下次拷贝 EBUSY）。
// 只杀命令行含 edge-user-profile 的进程，绝不影响用户正常 Edge。
function killStaleEdgeSession() {
  try {
    execFileSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -match 'edge-user-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }"],
      { windowsHide: true, timeout: 25000, stdio: "ignore" });
    console.log("[edge-session] 已清理残留 Edge 会话进程");
  } catch { /* ignore */ }
}

// ========== Profile 探测与副本 ==========
function detectEdgeProfile() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const src = path.join(localAppData, "Microsoft", "Edge", "User Data");
  if (!existsSync(src)) return null;
  const defaultDir = path.join(src, "Default");
  if (!existsSync(defaultDir)) return null;
  const networkCookies = path.join(defaultDir, "Network", "Cookies");
  const legacyCookies = path.join(defaultDir, "Cookies");
  let cookiesPath = null;
  if (existsSync(networkCookies)) cookiesPath = networkCookies;
  else if (existsSync(legacyCookies)) cookiesPath = legacyCookies;
  if (!cookiesPath) return null;
  return { src, defaultDir, cookiesPath };
}

async function copyEdgeProfile() {
  killStaleEdgeSession(); // 自愈：先清残留，再拷贝
  const profile = detectEdgeProfile();
  if (!profile) return { ok: false, reason: "未找到 Edge profile（%LOCALAPPDATA%\\Microsoft\\Edge\\User Data 不存在）" };

  const dest = EDGE_PROFILE_DIR;
  try { mkdirSync(dest, { recursive: true }); } catch { /* ignore */ }

  // 性能工单 M7：清理既有缓存的 Chromium 缓存残留（Cache_Data/GPUCache 等——不复制缓存，
  // 但历史遗留可能占数百 MB——复制前清掉，防磁盘无限膨胀）
  try {
    for (const c of ["Cache_Data", "GPUCache", "GrShaderCache", "DawnCache", "Code Cache", "ShaderCache"]) {
      const p = path.join(dest, c);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* 清理失败不阻塞 */ }

  // 1. Local State（cookie 加密 key 必需）
  const localStateSrc = path.join(profile.src, "Local State");
  if (!existsSync(localStateSrc)) return { ok: false, reason: "缺少 Local State 文件" };
  try { copyFileSync(localStateSrc, path.join(dest, "Local State")); } catch (e) {
    return { ok: false, reason: `Local State 拷贝失败: ${e.message}` };
  }

  // 2. Cookies 数据库（WAL 模式：主文件 + wal 一起拷，保证最近未 checkpoint 的写入不丢；
  //    不拷 shm——SQLite 打开时检测到 shm 缺失会自动重建，拷贝损坏的 shm 反而会出问题）
  const defaultDest = path.join(dest, "Default");
  try { mkdirSync(defaultDest, { recursive: true }); } catch { /* ignore */ }

  const cookiesSrc = profile.cookiesPath;
  const relCookies = path.relative(profile.defaultDir, cookiesSrc);
  const cookiesDestDir = path.join(defaultDest, path.dirname(relCookies));
  try { mkdirSync(cookiesDestDir, { recursive: true }); } catch { /* ignore */ }
  const cookiesDest = path.join(defaultDest, relCookies);

  // 实测：Edge 运行中文件为共享读锁，copyFileSync 可直接拷贝（无需关闭 Edge）。
  // 保留重试兜底独占锁场景（残留进程被杀后句柄释放有延迟/用户 Edge 独占打开时）。
  // 全部失败但已有缓存 profile → 用缓存（登录态 cookie 有效期长，通常仍有效）
  const filesToCopy = [cookiesSrc];
  if (existsSync(cookiesSrc + "-wal")) filesToCopy.push(cookiesSrc + "-wal");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      for (const f of filesToCopy) {
        copyFileSync(f, cookiesDest + f.slice(cookiesSrc.length));
      }
      break;
    } catch (e) {
      if (attempt === 4) {
        if (existsSync(cookiesDest)) {
          console.log("[edge-session] Cookies 拷贝失败（Edge 独占锁），使用上次缓存登录态");
          return { ok: true, stale: true };
        }
        return { ok: false, reason: `Cookies 文件被独占锁（罕见），请稍后重试: ${e.message}` };
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }

  // 安全工单 S9：只保留牛客域 cookie（不再整库复制 532MB——删非目标域行 + VACUUM 缩体积）。
  // cookie 值是加密的（Edge 用 Local State key 自动解密）——删行保留加密值即可；
  // 过滤失败不影响登录态（保留全量——登录态优先）
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const cdb = new DatabaseSync(cookiesDest);
    try { cdb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch { /* wal 不存在忽略 */ }
    cdb.prepare("DELETE FROM cookies WHERE host_key NOT LIKE '%nowcoder.com%'").run();
    cdb.prepare("VACUUM").run();
    cdb.close();
    console.log("[edge-session] Cookies 已过滤（仅保留牛客域）");
  } catch (e) {
    console.log(`[edge-session] Cookies 过滤失败（保留全量）: ${String(e?.message || e).slice(0, 80)}`);
  }

  // 3. Preferences（从真实 profile 拷贝，不能为空 {}——Edge 需要正确初始化）
  const prefsSrc = path.join(profile.defaultDir, "Preferences");
  const prefsDest = path.join(defaultDest, "Preferences");
  if (existsSync(prefsSrc)) {
    try { copyFileSync(prefsSrc, prefsDest); } catch { /* ignore */ }
  } else {
    try { writeFileSync(prefsDest, "{}", "utf8"); } catch { /* ignore */ }
  }

  // 4. Sentinel 文件
  try { writeFileSync(path.join(dest, "First Run"), "", "utf8"); } catch { /* ignore */ }
  const lastVersionSrc = path.join(profile.src, "Last Version");
  if (existsSync(lastVersionSrc)) {
    try { copyFileSync(lastVersionSrc, path.join(dest, "Last Version")); } catch { /* ignore */ }
  }

  return { ok: true };
}

// ========== 会话初始化 ==========
async function initSession() {
  if (sessionReady) return { ok: true };
  if (sessionError) return { ok: false, reason: sessionError };

  const copyResult = await copyEdgeProfile();
  if (!copyResult.ok) {
    sessionError = copyResult.reason;
    return { ok: false, reason: copyResult.reason };
  }

  try {
    sessionCtx = await chromium.launchPersistentContext(EDGE_PROFILE_DIR, {
      channel: "msedge",
      headless: true, // 无窗口（真实 Edge 内核 + 登录态，headless 也能过牛客风控——已实测）
      viewport: { width: 1366, height: 900 },
      locale: "zh-CN",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=TranslateUI",
      ],
    });

    await sessionCtx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // 验证登录态：实际访问牛客讨论页，检查是否被重定向到登录页/验证页
    const testPage = await sessionCtx.newPage();
    try {
      await testPage.goto("https://www.nowcoder.com/discuss", { waitUntil: "domcontentloaded", timeout: 30000 });
      await testPage.waitForTimeout(2000);
      const testTitle = await testPage.title();
      const isLoginPage = /登录|login|signin/i.test(testTitle) && await testPage.url().includes("login");
      const isCaptcha = /安全验证|Security Verification/i.test(testTitle);

      if (isLoginPage) {
        sessionError = "Edge profile 中牛客登录态已失效（访问牛客被重定向到登录页）";
        await sessionCtx.close(); sessionCtx = null;
        return { ok: false, reason: sessionError };
      }
      if (isCaptcha) {
        sessionError = "Edge 会话触发牛客安全验证（可能登录态异常）";
        await sessionCtx.close(); sessionCtx = null;
        return { ok: false, reason: sessionError };
      }
    } finally {
      await testPage.close();
    }

    sessionReady = true;
    console.log("[edge-session] 已初始化，牛客登录态验证通过");
    return { ok: true };
  } catch (e) {
    sessionError = `Edge 会话启动失败: ${e.message}`;
    if (sessionCtx) { try { await sessionCtx.close(); } catch { /* ignore */ } sessionCtx = null; }
    return { ok: false, reason: sessionError };
  }
}

// ========== 导出 ==========
/** @returns {Promise<{ok: boolean, fetchWithEdge?: Function, reason?: string}>} */
export async function getEdgeSession() {
  const initResult = await initSession();
  if (!initResult.ok) return initResult;

  return {
    ok: true,
    /** @param {string} url @param {any} [opts] */
    fetchWithEdge: async (url, opts = {}) => {
      // SSRF 防护（修复：此前直接 page.goto 任意 URL——绕过 fetch-page 的"唯一 choke point"；
      // 复用同一套 assertPublicUrl：仅 http/https + 拒绝内网/环回/私有网段含 DNS 解析）
      const { assertPublicUrl } = await import("./fetch-page.mjs");
      await assertPublicUrl(url);
      const { maxTextChars = 60000, collectLinks = false, waitUntil = "domcontentloaded", waitMs = 1500 } = opts;
      const page = await sessionCtx.newPage();
      try {
        await page.goto(url, { waitUntil, timeout: config.navTimeout });
        await page.waitForTimeout(waitMs);
        const result = await page.evaluate(
          ({ collectLinks }) => {
            const title = document.title || "";
            let links = [];
            if (collectLinks) {
              links = Array.from(document.querySelectorAll("a[href]"))
                .map((a) => ({ text: (a.textContent || "").trim().slice(0, 80), href: /** @type {HTMLAnchorElement} */ (a).href }))
                .filter((l) => l.text && /^https?:/.test(l.href)).slice(0, 300);
            }
            return { title, html: document.documentElement.outerHTML, links };
          },
          { collectLinks }
        );

        const { JSDOM } = await import("jsdom");
        const { Readability } = await import("@mozilla/readability");
        const dom = new JSDOM(result.html, { url });
        const article = new Readability(dom.window.document, { charThreshold: 200, keepClasses: false }).parse();
        let text = article?.textContent?.trim() || "";
        if (text.length > maxTextChars) text = text.slice(0, maxTextChars);

        const isBlocked = /安全验证|Security Verification|请完成验证/i.test((result.title || "") + " " + text.slice(0, 300)) && text.length < 800;
        const is404 = /404|not found|页面不存在/i.test(result.title) && text.length < 500;

        if (isBlocked) return { url, title: "blocked", text, links: result.links, length: text.length, invalid: true };
        if (is404 || text.length < 100) return { url, title: "404", text: "", links: [], length: 0, invalid: true };

        return { url, title: article?.title || result.title || url, text, links: result.links, length: text.length };
      } finally {
        await page.close();
      }
    },
  };
}

export async function closeEdgeSession() {
  if (sessionCtx) { try { await sessionCtx.close(); } catch { /* ignore */ } sessionCtx = null; }
  sessionReady = false;
  sessionError = null;
}

process.on("exit", () => {
  if (sessionCtx) { try { sessionCtx.close(); } catch { /* ignore */ } }
  killStaleEdgeSession(); // 同步兜底：即使 close() 没完成，也确保 msedge 残留被清
});
