// 官方学习文档模块：前端/AI/Agent 三类官方文档清单 + 版本检测（保证"最新"）
// 清单：data/learning-sites.json（静态维护）；检测结果缓存：data/doc-versions.json（原子写）
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJsonSafe } from "./atomic-json.mjs";
import { db } from "./db.mjs";

const SITES_FILE = path.join(import.meta.dirname, "..", "data", "learning-sites.json");
const VERSIONS_FILE = path.join(import.meta.dirname, "..", "data", "doc-versions.json");

/** 读静态清单（带分类） */
export function getLearningDocs() {
  if (!existsSync(SITES_FILE)) return { categories: [] };
  try {
    const raw = JSON.parse(readFileSync(SITES_FILE, "utf8"));
    const cached = readJsonSafe(VERSIONS_FILE, {});
    const categories = (raw.categories || []).map((cat) => ({
      category: cat.category,
      sites: (cat.sites || []).map((s) => ({
        name: s.name,
        official: s.official,
        desc: s.desc || "",
        versionPage: s.versionPage ?? s.official, // 保留显式空串（=持续更新，跳过检测）
        registry: s.registry || null,             // {type:"npm"|"pypi", pkg} 兜底包名
        // 合并最近一次检测结果
        check: cached[s.name] || null,
      })),
    }));
    return { categories, lastCheck: cached._lastCheck || null };
  } catch {
    return { categories: [] };
  }
}

// 版本提取：versionPage 通常是 changelog/releases 页，第一个版本号即最新（支持 v19.2.7 / 5.8 两位）
const VERSION_RE = /(?:^|[\s>（(])(?:v|V)?(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)/;
// 日期提取：2026-08-01 / 2026年8月 / 2026/08/01（月份 1-12 才有效，防 "2012-2019" 误配）
const DATE_RE = /(20\d{2})[-年/.](\d{1,2})(?:[-月/.](\d{1,2}))?/;

/**
 * 检查各文档最新版本：versionPage 抓取 + registry 兜底（npm/pypi，快且准）
 * 抓取失败/未提取到时，若清单配置了 registry 包名 → 查 registry JSON API（毫秒级）
 * @param {string[]} [only] 只检查指定名称（空 = 全部）
 * @param {{ registryFetch?: Function }} [deps] 可注入 registry 查询（测试隔离网络）
 * @returns {Promise<Record<string, {version:string,date:string,checkedAt:string,ok:boolean,error?:string,note?:string,source?:string,localVersion?:string}>>}
 */
export async function checkDocVersions(only = [], deps = {}) {
  const registryFetch = deps.registryFetch || fetchRegistryVersion;
  const { fetchPage } = await import("./fetch-page.mjs");
  const categories = getLearningDocs().categories;
  const sites = categories.flatMap((c) => c.sites);
  const targets = only.length ? sites.filter((s) => only.includes(s.name)) : sites;
  const lastCheck = new Date().toISOString();
  /** @type {Record<string, CheckResult>} */
  const results = {};

  // 并发抓取（限制 5 并发：19 个 context 全开会挤爆浏览器；单站失败不拖累）
  const CONCURRENCY = 5;
  let idx = 0;
  const checkOne = async (s) => {
    const fail = (error, note) => {
      results[s.name] = { version: "", date: "", checkedAt: lastCheck, ok: false, error, note };
    };
    // versionPage 为空 = 持续更新类（MDN 无版本号），跳过抓取直接标记
    if (!s.versionPage) {
      results[s.name] = { version: "", date: "", checkedAt: lastCheck, ok: true, note: "持续更新" };
      return;
    }
    try {
      const page = await fetchPage(s.versionPage, {
        maxTextChars: 4000,
        collectLinks: false,
        waitMs: 1500,
        rawText: true, // 版本列表/changelog 页：Readability 会误删列表，直接取 innerText
      });
      if (page.invalid || !page.text) {
        fail("页面无效");
      } else {
        const text = page.text;
        const vm = text.match(VERSION_RE);
        const dm = text.match(DATE_RE);
        const version = vm ? `${vm[1]}` : "";
        let date = "";
        if (dm && Number(dm[2]) >= 1 && Number(dm[2]) <= 12) {
          date = `${dm[1]}-${String(dm[2]).padStart(2, "0")}${dm[3] ? "-" + String(dm[3]).padStart(2, "0") : ""}`;
        }
        results[s.name] = {
          version,
          date,
          checkedAt: lastCheck,
          ok: !!version || !!date,
          error: !version && !date ? "未提取到版本/日期" : undefined,
        };
      }
    } catch (e) {
      fail(String(e.message).slice(0, 60));
    }
    // registry 兜底：抓取失败/未提取到 → npm/pypi 版本 API（快、准）
    if (s.registry?.pkg && (!results[s.name]?.ok || !results[s.name]?.version)) {
      try {
        const rv = await registryFetch(s.registry.pkg, s.registry.type);
        if (rv?.version) {
          results[s.name] = {
            version: rv.version,
            date: rv.date || results[s.name]?.date || "",
            checkedAt: lastCheck,
            ok: true,
            note: results[s.name]?.error ? `页面抓取失败，已用 registry 兜底（${s.registry.type}）` : "registry",
            source: s.registry.type,
            error: undefined,
          };
        }
      } catch { /* registry 不可达保持原结果 */ }
    }
    // 项目内版本对比（前端项目 package.json 依赖 vs 最新）
    if (s.registry?.pkg && results[s.name]?.version) {
      const local = readProjectLocalVersion(s.registry.pkg);
      if (local) results[s.name].localVersion = local;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (idx < targets.length) {
        const s = targets[idx++];
        await checkOne(s);
      }
    })
  );

  // 合并旧缓存（未检查的保留旧结果）
  const old = readJsonSafe(VERSIONS_FILE, {});
  for (const [name, v] of Object.entries(old)) {
    if (name !== "_lastCheck" && !results[name]) {
      /** @type {Record<string, CheckResult>} */
      const merged = results;
      merged[name] = /** @type {CheckResult} */ (v);
    }
  }
  const out = /** @type {Record<string, CheckResult> & { _lastCheck: string }} */ ({ ...results, _lastCheck: lastCheck });
  writeJsonAtomic(VERSIONS_FILE, out);
  return out;
}

/**
 * 检查结果：名称 → { version, date, checkedAt, ok, error?, note?, source?, localVersion? }
 * @typedef {Object} CheckResult
 * @property {string} version 最新版本号（提取不到为空）
 * @property {string} date 最近发布日期
 * @property {string} checkedAt 检查时间
 * @property {boolean} ok 是否提取到有效信息
 * @property {string} [error] 失败原因
 * @property {string} [note] 备注
 * @property {string} [source] 版本来源（"npm"/"pypi"= registry 兜底）
 * @property {string} [localVersion] 项目内实际版本（对比用）
 */

// ---------- registry 兜底（npm / pypi） ----------
/**
 * 查包最新版本：npm registry 或 PyPI JSON API
 * @param {string} pkg 包名
 * @param {"npm"|"pypi"} [type]
 * @returns {Promise<{version:string, date:string}|null>}
 */
export async function fetchRegistryVersion(pkg, type = "npm") {
  const url = type === "pypi"
    ? `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`
    : `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json();
  if (type === "pypi") {
    return { version: String(j?.info?.version || ""), date: String(j?.urls?.[0]?.upload_time_iso_8601 || j?.info?.version_time || "").slice(0, 10) };
  }
  return { version: String(j?.version || ""), date: String(j?.time?.version || "").slice(0, 10) };
}

// ---------- 项目内版本对比 ----------
// 项目路径优先级：settings.docs_project（面板可配）> 候选常见路径（存在才用）
const PROJECT_CANDIDATES = ["D:/ai-career/package.json", "D:/novel-factory-package/package.json"];

/** 读项目 package.json 里某包的实际版本（无项目/无该包返回 null） */
export function readProjectLocalVersion(pkg) {
  try {
    let file = "";
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='docs_project'").get();
      if (row && row.value) file = String(row.value);
    } catch { /* ignore */ }
    if (!file) file = PROJECT_CANDIDATES.find((c) => existsSync(c)) || "";
    if (!file || !existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8"));
    const all = { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.peerDependencies || {}) };
    const v = all[pkg];
    return v ? String(v).replace(/^[\^~>=<*]+\s*/, "") : null;
  } catch { return null; }
}
