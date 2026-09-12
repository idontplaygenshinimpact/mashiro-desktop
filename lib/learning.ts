// 官方学习文档模块：前端/AI/Agent 三类官方文档清单 + 版本检测（保证"最新"）
// 清单：data/learning-sites.json（静态维护）；检测结果缓存：data/doc-versions.json（原子写）
// 全量 TS 升级工单阶段 3：lib/learning.mjs → .ts（plugins/job-hunter/routes/kb.mjs 与 tests 按 .mjs 路径加载 → 保留同名一行桶）
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJsonSafe } from "./atomic-json.ts";
import { db } from "./db.mjs";

const SITES_FILE = path.join(import.meta.dirname, "..", "data", "learning-sites.json");
const VERSIONS_FILE = path.join(import.meta.dirname, "..", "data", "doc-versions.json");

/** 单站点版本检测结果 */
export interface DocCheck {
  version: string;
  date: string;
  checkedAt: string;
  ok: boolean;
  /** 失败原因 */
  error?: string;
  /** 备注（持续更新 / registry 兜底等） */
  note?: string;
  /** 版本来源（"npm"/"pypi" = registry 兜底） */
  source?: string;
  /** 项目内实际版本（对比用） */
  localVersion?: string;
}
/** 版本检测缓存表：站点名 → 检测结果；_lastCheck = 整表最近检查时间
 * （索引签名含 string：`_lastCheck` 与站点结果同表混存，读取侧按 typeof 分流） */
export interface VersionCache {
  _lastCheck?: string;
  [site: string]: DocCheck | string | undefined;
}

/** 清单里的站点条目（data/learning-sites.json） */
export interface LearningSite {
  name: string;
  official?: unknown;
  desc: string;
  versionPage: unknown;
  registry: { type?: "npm" | "pypi"; pkg?: string } | null;
  check: DocCheck | null;
}
export interface LearningCategory { category: unknown; sites: LearningSite[] }
export interface LearningDocs { categories: LearningCategory[]; lastCheck?: string | null }

/** registry 查询函数（可注入：测试隔离网络） */
export type RegistryFetch = (pkg: string, type?: "npm" | "pypi") => Promise<{ version?: string; date?: string } | null>;

/** 读静态清单（带分类） */
export function getLearningDocs(): LearningDocs {
  if (!existsSync(SITES_FILE)) return { categories: [] };
  try {
    const raw = JSON.parse(readFileSync(SITES_FILE, "utf8")) as { categories?: Array<{ category?: unknown; sites?: Array<Record<string, unknown>> }> };
    // atomic-json 迁移（全量 TS 升级工单阶段 1⑤）：readJsonSafe 泛型化后 fallback 即返回类型——
    // 这里显式声明缓存表形状（此前 JSON.parse 返回 any，形状只活在注释里）
    const cached = readJsonSafe<VersionCache>(VERSIONS_FILE, {});
    const categories: LearningCategory[] = (raw.categories || []).map((cat) => ({
      category: cat.category,
      sites: (cat.sites || []).map((s) => ({
        name: String(s.name),
        official: s.official,
        desc: String(s.desc || ""),
        versionPage: s.versionPage ?? s.official, // 保留显式空串（=持续更新，跳过检测）
        registry: (s.registry as LearningSite["registry"]) || null, // {type:"npm"|"pypi", pkg} 兜底包名
        // 合并最近一次检测结果（_lastCheck 是字符串，按对象判定分流）
        check: (() => { const c = cached[String(s.name)]; return c && typeof c === "object" ? c : null; })(),
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

/** fetch-page 返回的页面（只用到这两项） */
interface PageLike { invalid?: boolean; text?: string }

/**
 * 检查各文档最新版本：versionPage 抓取 + registry 兜底（npm/pypi，快且准）
 * 抓取失败/未提取到时，若清单配置了 registry 包名 → 查 registry JSON API（毫秒级）
 * @param only 只检查指定名称（空 = 全部）
 * @param deps 可注入 registry 查询（测试隔离网络）
 */
export async function checkDocVersions(only: string[] = [], deps: { registryFetch?: RegistryFetch } = {}): Promise<VersionCache & { _lastCheck: string }> {
  const registryFetch: RegistryFetch = deps.registryFetch || fetchRegistryVersion;
  const { fetchPage } = await import("./fetch-page.mjs");
  const categories = getLearningDocs().categories;
  const sites = categories.flatMap((c) => c.sites);
  const targets = only.length ? sites.filter((s) => only.includes(s.name)) : sites;
  const lastCheck = new Date().toISOString();
  const results: Record<string, DocCheck> = {};

  // 并发抓取（限制 5 并发：19 个 context 全开会挤爆浏览器；单站失败不拖累）
  const CONCURRENCY = 5;
  let idx = 0;
  const checkOne = async (s: LearningSite): Promise<void> => {
    const fail = (error: string, note?: string): void => {
      results[s.name] = { version: "", date: "", checkedAt: lastCheck, ok: false, error, note };
    };
    // versionPage 为空 = 持续更新类（MDN 无版本号），跳过抓取直接标记
    if (!s.versionPage) {
      results[s.name] = { version: "", date: "", checkedAt: lastCheck, ok: true, note: "持续更新" };
      return;
    }
    try {
      const page = await fetchPage(String(s.versionPage), {
        maxTextChars: 4000,
        collectLinks: false,
        waitMs: 1500,
        rawText: true, // 版本列表/changelog 页：Readability 会误删列表，直接取 innerText
      }) as PageLike;
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
      fail((e instanceof Error ? e.message : String(e)).slice(0, 60));
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
  const old = readJsonSafe<Record<string, unknown>>(VERSIONS_FILE, {});
  for (const [name, v] of Object.entries(old)) {
    if (name !== "_lastCheck" && !results[name]) {
      results[name] = v as DocCheck;
    }
  }
  const out = { ...results, _lastCheck: lastCheck };
  writeJsonAtomic(VERSIONS_FILE, out);
  return out;
}

// ---------- registry 兜底（npm / pypi） ----------
/** 查包最新版本：npm registry 或 PyPI JSON API */
export async function fetchRegistryVersion(pkg: string, type: "npm" | "pypi" = "npm"): Promise<{ version: string; date: string } | null> {
  const url = type === "pypi"
    ? `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`
    : `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json() as Record<string, unknown>;
  if (type === "pypi") {
    const info = j?.info as { version?: unknown; version_time?: unknown } | undefined;
    const urls = j?.urls as Array<{ upload_time_iso_8601?: unknown }> | undefined;
    return { version: String(info?.version || ""), date: String(urls?.[0]?.upload_time_iso_8601 || info?.version_time || "").slice(0, 10) };
  }
  const time = j?.time as { version?: unknown } | undefined;
  return { version: String(j?.version || ""), date: String(time?.version || "").slice(0, 10) };
}

// ---------- 项目内版本对比 ----------
// 项目路径优先级：settings.docs_project（面板可配）> 候选常见路径（存在才用）
const PROJECT_CANDIDATES = ["D:/ai-career/package.json", "D:/novel-factory-package/package.json"];

/** 读项目 package.json 里某包的实际版本（无项目/无该包返回 null） */
export function readProjectLocalVersion(pkg: string): string | null {
  try {
    let file = "";
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='docs_project'").get() as { value?: unknown } | undefined;
      if (row && row.value) file = String(row.value);
    } catch { /* ignore */ }
    if (!file) file = PROJECT_CANDIDATES.find((c) => existsSync(c)) || "";
    if (!file || !existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf8")) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown> };
    const all: Record<string, unknown> = { ...(j.dependencies || {}), ...(j.devDependencies || {}), ...(j.peerDependencies || {}) };
    const v = all[pkg];
    return v ? String(v).replace(/^[\^~>=<*]+\s*/, "") : null;
  } catch { return null; }
}
