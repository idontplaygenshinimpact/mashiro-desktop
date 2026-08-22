// lib/plugin-admin.mjs —— 插件管理（阶段 3：管理页/启停/设置/市场安装）
// 与 plugin-loader.mjs 的分工：loader 只管"加载一个插件"，admin 管"插件生命周期状态"
//   —— 启停标记（settings 表 plg_disabled_<id>）、加载结果缓存、设置读写（plg_<id>_ 前缀）、
//      市场安装（data/plugin-market.json → 下载文件到 plugins/<id>，路径安全校验）
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.mjs";
import { discoverPlugins, loadPlugin } from "./plugin-loader.mjs";
import { readJsonSafe } from "./atomic-json.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISABLED_PREFIX = "plg_disabled_"; // 停用标记：settings key（值为 "1"）

/** 插件是否被停用（面板/设置里关了 → 下次启动跳过加载，路由不注册） */
export function isPluginDisabled(id) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(DISABLED_PREFIX + String(id));
    return row ? String(row.value) === "1" : false;
  } catch { return false; }
}

/** 启停插件（写标记；已注册的路由在当前进程仍生效，重启后按新状态加载） */
export function setPluginEnabled(id, enabled) {
  const key = DISABLED_PREFIX + String(id);
  try {
    if (enabled) db.prepare("DELETE FROM settings WHERE key=?").run(key);
    else db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)").run(key, "1", Date.now());
    return { ok: true, id: String(id), enabled: !!enabled, note: "重启后生效" };
  } catch (e) {
    return { ok: false, id: String(id), error: String(e?.message || e).slice(0, 120) };
  }
}

// 加载结果缓存（widget 启动 loadEnabledPlugins 写入；/api/plugins 与 /api/health 查询）
let lastResults = [];

/** 加载全部启用插件（跳过 plg_disabled_<id>=1 的插件），结果缓存供面板查询 */
export async function loadEnabledPlugins(api, pluginsDir = path.join(ROOT, "plugins")) {
  const results = [];
  for (const p of discoverPlugins(pluginsDir)) {
    const id = p.manifest.id;
    if (isPluginDisabled(id)) {
      results.push({ ok: false, id, name: p.manifest.name, version: p.manifest.version, disabled: true, error: "已停用（可在面板设置→插件管理开启）" });
      continue;
    }
    results.push({ ...(await loadPlugin(p, api)), disabled: false });
  }
  lastResults = results;
  return results;
}

export function getPluginLoadResults() { return lastResults; }

/** 面板列表：manifest + 加载结果 + 启停标记（管理页唯一数据源） */
export function listPlugins(pluginsDir = path.join(ROOT, "plugins")) {
  const loaded = new Map(lastResults.map((r) => [r.id, r]));
  return discoverPlugins(pluginsDir).map((p) => {
    const m = p.manifest;
    const l = loaded.get(m.id);
    return {
      id: m.id,
      name: m.name,
      version: m.version || "",
      description: m.description || "",
      panel: m.panel || null,
      schedules: m.schedules || [],
      disabled: isPluginDisabled(m.id),
      load: l
        ? { ok: l.ok, error: l.error || null, health: l.health || null, disabled: l.disabled || false }
        : { ok: false, error: "未加载", health: null, disabled: false },
    };
  });
}

/** 读插件面板设置（只读 manifest 声明的 key；未声明过则 null） */
export function readPluginSettings(id, pluginsDir = path.join(ROOT, "plugins")) {
  const p = listPlugins(pluginsDir).find((x) => x.id === id);
  if (!p) return { ok: false, error: `插件不存在: ${id}` };
  const decls = (p.panel?.settings || []).filter((s) => s?.key);
  const out = {};
  for (const s of decls) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(`plg_${id}_${s.key}`);
      out[s.key] = row ? JSON.parse(String(row.value)) : null;
    } catch { out[s.key] = null; }
  }
  return { ok: true, id, settings: out };
}

/** 写插件面板设置（只允许 manifest 声明的 key；按声明类型收敛值类型） */
export function writePluginSetting(id, key, value, pluginsDir = path.join(ROOT, "plugins")) {
  const p = listPlugins(pluginsDir).find((x) => x.id === id);
  const decl = (p?.panel?.settings || []).find((s) => s.key === key);
  if (!decl) return { ok: false, error: `插件 ${id} 未声明设置项 ${key}` };
  const v = decl.type === "toggle" ? !!value : String(value ?? "");
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(`plg_${id}_${key}`, JSON.stringify(v), Date.now());
    return { ok: true, id, key, value: v };
  } catch (e) {
    return { ok: false, id, key, error: String(e?.message || e).slice(0, 120) };
  }
}

// ---------- 插件市场（data/plugin-market.json；安装 = 下载声明文件到 plugins/<id>） ----------
const MARKET_PATH = () => path.join(ROOT, "data", "plugin-market.json");

export function getPluginMarket() {
  const data = readJsonSafe(MARKET_PATH(), { plugins: [] });
  return { ok: true, plugins: Array.isArray(data.plugins) ? data.plugins : [] };
}

/**
 * 从市场安装插件：按清单 files 逐个下载写入 plugins/<id>/
 * 安全：id 白名单（^[a-z0-9-]+$）；文件相对路径拒绝 .. / 绝对路径（防目录穿越）；
 *      目标必须落在 plugins/<id>/ 内；fetcher 可注入（测试用假 fetch，默认 node fetch）
 * @param {string} id
 * @param {{fetcher?: (url: string) => Promise<{ok: boolean, status?: number, text: () => Promise<string>}>, pluginsDir?: string, market?: Array<any>}} [opts]
 */
export async function installPlugin(id, opts = {}) {
  const { fetcher = fetch, pluginsDir = path.join(ROOT, "plugins"), market = getPluginMarket().plugins } = opts;
  const entry = market.find((p) => p && p.id === id);
  if (!entry) return { ok: false, error: `市场无此插件: ${id}` };
  if (!/^[a-z0-9-]+$/.test(String(id))) return { ok: false, error: "非法插件 id（只允许小写字母/数字/连字符）" };
  const files = (entry.files || []).filter((f) => f && typeof f.path === "string" && typeof f.url === "string");
  if (!files.length) return { ok: false, error: "市场条目缺少文件清单" };
  const targetDir = path.join(pluginsDir, id);
  const targetPrefix = targetDir + path.sep;
  for (const f of files) {
    const rel = f.path.replace(/\\/g, "/");
    if (rel.startsWith("..") || rel.includes("../") || path.isAbsolute(rel) || rel.includes("\0")) {
      return { ok: false, error: `非法文件路径: ${rel}` };
    }
    const dest = path.join(targetDir, rel);
    if (dest !== targetDir && !dest.startsWith(targetPrefix)) {
      return { ok: false, error: `路径越界: ${rel}` };
    }
    let resp;
    try { resp = await fetcher(f.url); } catch (e) {
      return { ok: false, error: `下载失败 ${f.url}: ${String(e?.message || e).slice(0, 80)}` };
    }
    if (!resp || !resp.ok) return { ok: false, error: `下载失败 ${f.url}（HTTP ${resp?.status || "?"}）` };
    const text = await resp.text();
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text, "utf8");
  }
  // 完整性检查：安装后必须存在 manifest.json 且 id 与安装目标一致
  const manifestFile = path.join(targetDir, "manifest.json");
  if (!existsSync(manifestFile)) {
    return { ok: false, error: "安装文件缺少 manifest.json（市场条目不完整）" };
  }
  try {
    const m = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (m.id !== id) return { ok: false, error: `manifest.id(${m.id}) 与安装目标不一致` };
  } catch {
    return { ok: false, error: "manifest.json 解析失败" };
  }
  return { ok: true, id, name: entry.name || id, version: entry.version || "", note: "已安装，重启后生效（面板设置→插件管理可启停）" };
}
