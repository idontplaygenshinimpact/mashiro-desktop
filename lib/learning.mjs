// 官方学习文档模块：前端/AI/Agent 三类官方文档清单 + 版本检测（保证"最新"）
// 清单：data/learning-sites.json（静态维护）；检测结果缓存：data/doc-versions.json（原子写）
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJsonSafe } from "./atomic-json.mjs";

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
 * 检查各文档最新版本：抓 versionPage → 正则提取版本号/日期 → 原子写缓存
 * @param {string[]} [only] 只检查指定名称（空 = 全部）
 * @returns {Promise<Record<string, {version:string,date:string,checkedAt:string,ok:boolean,error?:string}>>}
 */
/**
 * 检查结果：名称 → { version, date, checkedAt, ok, error?, note? }
 * @typedef {Object} CheckResult
 * @property {string} version 最新版本号（v19.2.7 → "19.2.7"；提取不到为空）
 * @property {string} date 最近发布日期（YYYY-MM 或 YYYY-MM-DD）
 * @property {string} checkedAt 检查时间
 * @property {boolean} ok 是否提取到有效信息
 * @property {string} [error] 失败原因
 * @property {string} [note] 备注（如"持续更新"）
 */
export async function checkDocVersions(only = []) {
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
        results[s.name] = { version: "", date: "", checkedAt: lastCheck, ok: false, error: "页面无效" };
        return;
      }
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
    } catch (e) {
      results[s.name] = { version: "", date: "", checkedAt: lastCheck, ok: false, error: String(e.message).slice(0, 60) };
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
  const out = { ...results, _lastCheck: lastCheck };
  writeJsonAtomic(VERSIONS_FILE, out);
  return out;
}
