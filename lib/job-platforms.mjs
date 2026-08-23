// 求职平台注册表：统一接口，平台可插拔（BOSS 直聘 → 后续拉勾/智联/猎聘）
// 平台模块约定导出：
//   export const platform = {
//     name: "boss",                 // 唯一 id（小写）
//     label: "BOSS 直聘",
//     authRequired: true,           // 是否需要登录态
//     authMethods: ["cookie", "edge"],  // 支持的登录态方式
//     searchJobs(keyword, opts)     // -> {ok, jobs:[{title,company,salary,location,url,id}]} 
//     fetchDetail(url)              // -> {ok, title, company, jdText, salary, tags}
//     prepareApply(url, {greeting}) // 半自动投递 -> {ok, detail, needManual?}
//   }
// 注册表职责：路由、状态汇总、失败隔离（单平台异常不影响其他平台）
import { getAccount, isPlatformEnabled } from "./platform-accounts.mjs";
import { db } from "./db.mjs";

const registry = new Map(); // name -> platform 模块

let ensurePromise = null;
/** 惰性加载内置平台（BOSS 等），失败隔离不影响注册表本身 */
export function ensurePlatforms() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      try {
        const boss = await import("./platforms/boss.mjs");
        registerPlatform(boss);
      } catch (e) {
        console.log(`[platforms] boss 平台加载失败（隔离）: ${String(e?.message || e).slice(0, 120)}`);
      }
    })();
  }
  return ensurePromise;
}

/** 注册平台（模块加载时调用） */
export function registerPlatform(mod) {
  const p = mod?.platform || mod;
  if (!p || typeof p.name !== "string" || typeof p.searchJobs !== "function") {
    throw new Error(`非法平台模块: ${mod?.name || "unknown"}`);
  }
  registry.set(p.name, p);
  return p;
}

/** 获取平台（未注册返回 null） */
export function getPlatform(name) {
  return registry.get(String(name || "")) || null;
}

/** 平台列表（含账号状态汇总，供面板展示） */
export function listPlatforms() {
  return [...registry.values()].map((p) => {
    const acc = getAccount(p.name);
    return {
      name: p.name,
      label: p.label || p.name,
      authRequired: !!p.authRequired,
      authMethods: p.authMethods || [],
      enabled: !!(acc && acc.enabled),
      authStatus: acc ? (acc.authMethod === "cookie" && acc.cookie ? "cookie" : acc.authMethod === "edge" ? "edge" : "none") : "none",
      applyToday: acc ? Number(acc.applyCountToday) || 0 : 0,
      applyDailyLimit: acc ? Number(acc.applyDailyLimit) || 10 : 10,
      greeting: acc?.greeting || "",
    };
  });
}

/** 搜索岗位（平台启用检查 + 路由；单平台失败返回 error 不抛） */
export async function searchJobsOnPlatform(name, keyword, opts = {}) {
  const p = getPlatform(name);
  if (!p) return { error: `未知平台: ${name}（已注册: ${[...registry.keys()].join(", ") || "无"}）` };
  if (!isPlatformEnabled(name)) {
    return { error: `平台 ${p.label || name} 未启用，请先在面板「校招 → 平台账号」配置并启用` };
  }
  if (!keyword || !String(keyword).trim()) return { error: "搜索关键词不能为空" };
  try {
    return await p.searchJobs(String(keyword).trim(), opts);
  } catch (e) {
    return { error: `${p.label || name} 搜索失败: ${String(e?.message || e).slice(0, 150)}` };
  }
}

/** 从岗位标题/JD 简单推断方向（平台搜索结果无 direction 字段；关键词命中即归类） */
function inferJobDirection(text) {
  const s = String(text || "").toLowerCase();
  if (/前端|vue|react|h5|web/.test(s)) return "frontend";
  // ASCII 关键词加词边界：避免 java→javascript / go→google / ai→mail 等子串误判
  if (/\bagent\b|\bai\b|\bllm\b|大模型/.test(s)) return "agent";
  if (/后端|\bjava\b|golang|\bgo\b|服务端/.test(s)) return "backend";
  if (/算法|算法工程师/.test(s)) return "algorithm";
  return "other";
}

/** job_type 推断：标题/JD 含"实习" → 实习，否则校招 */
function inferJobType(text) {
  return /实习/.test(String(text || "")) ? "实习" : "校招";
}

/**
 * 搜索 + 入库（agent 工具与 widget API 共用）：平台搜索 → jobs.mjs addJob 去重入库
 * @returns {Promise<{ok?: boolean, jobs?: any[], addedCount?: number, error?: string, hint?: string, warn?: string}>}
 */
export async function searchAndStoreJobs(name, keyword, opts = {}) {
  const r = await searchJobsOnPlatform(name, keyword, opts);
  if (!r.ok) return r;
  const jobs = Array.isArray(r.jobs) ? r.jobs.slice(0, Number(opts.storeLimit) || 10) : [];
  if (!jobs.length) return { ok: true, jobs: [], addedCount: 0 };
  try {
    const { addJob } = await import("./jobs.mjs");
    const stored = jobs.map((j) => {
      // 修复：入库不再硬编码 direction='frontend'/job_type='校招'，从 title/JD 推断（不改变入参）
      const inferText = [j.title, j.jdText, j.summary].filter(Boolean).join(" ");
      const res = addJob({
        company: j.company,
        title: j.title,
        job_type: inferJobType(inferText),
        direction: inferJobDirection(inferText),
        apply_url: j.url,
        summary: [j.salary, j.location].filter(Boolean).join(" · ").slice(0, 200) || null,
        source: name,
      });
      return { ...j, id: res?.id || null, dup: !!res?.dup };
    });
    const addedCount = stored.filter((s) => !s.dup).length;
    return { ok: true, jobs: stored, addedCount, hint: `已入库 ${addedCount} 个新岗位（重复 ${stored.length - addedCount}），可在面板「校招」查看` };
  } catch (e) {
    // 入库失败不吞搜索结果（岗位列表仍可用）
    return { ok: true, jobs, addedCount: 0, warn: `入库失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

/** 抓取岗位详情 */
export async function fetchJobDetailOnPlatform(name, url) {
  const p = getPlatform(name);
  if (!p) return { error: `未知平台: ${name}` };
  try {
    return await p.fetchDetail(String(url));
  } catch (e) {
    return { error: `${p.label || name} 详情抓取失败: ${String(e?.message || e).slice(0, 150)}` };
  }
}

/**
 * 半自动投递（用户已确认）：
 * 1. 平台启用检查
 * 2. 频率限制（每日上限 + 最小间隔）
 * 3. 调平台 prepareApply 执行
 * 4. 成功后 recordApply 计数
 * @returns {Promise<{ok?: boolean, error?: string, detail?: string, needManual?: boolean}>}
 */
export async function applyJobOnPlatform(name, url, opts = {}) {
  const p = getPlatform(name);
  if (!p) return { error: `未知平台: ${name}` };
  if (!isPlatformEnabled(name)) return { error: `平台 ${p.label || name} 未启用` };
  const { checkApplyRateLimit, recordApply } = await import("./platform-accounts.mjs");
  const limit = checkApplyRateLimit(name);
  if (!limit.ok) return { ok: false, error: limit.reason };
  // 招呼语优先级：调用方显式传入 > 平台账号配置 > 自动生成（展示简历优势）
  let greeting = String(opts.greeting || "").trim();
  if (!greeting) {
    const { getAccount } = await import("./platform-accounts.mjs");
    greeting = String(getAccount(name)?.greeting || "").trim();
  }
  if (!greeting) {
    try {
      // 从 job_posts 反查岗位信息（company/title）用于点名岗位（列名是 apply_url）
      let company = "", title = "";
      try {
        const row = db.prepare("SELECT company, title FROM job_posts WHERE apply_url=?").get(String(url || ""));
        if (row) { company = String(row.company || ""); title = String(row.title || ""); }
      } catch { /* ignore */ }
      const { buildGreeting } = await import("./greeting.mjs");
      greeting = buildGreeting({ company, title });
    } catch { /* 生成失败走空（不发送） */ }
  }
  let r;
  try {
    r = await p.prepareApply(String(url), { greeting });
  } catch (e) {
    return { ok: false, error: `${p.label || name} 投递执行失败: ${String(e?.message || e).slice(0, 150)}` };
  }
  if (r && r.ok) recordApply(name);
  return r;
}
