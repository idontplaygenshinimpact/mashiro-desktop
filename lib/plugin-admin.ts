// lib/plugin-admin.ts —— 插件管理（阶段 3：管理页/启停/设置/市场安装）
// 与 plugin-loader.ts 的分工：loader 只管"加载一个插件"，admin 管"插件生命周期状态"
//   —— 启停标记（settings 表 plg_disabled_<id>）、加载结果缓存、设置读写（plg_<id>_ 前缀）、
//      市场安装（data/plugin-market.json → 下载文件到 plugins/<id>，路径安全校验）
// 全量 TS 升级工单阶段 3：lib/plugin-admin.mjs → .ts（唯一调用方 widget.mjs 与 tests 按 .mjs 路径加载 → 保留同名一行桶）
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.mjs";
import { discoverPlugins, loadPlugin, type LoadedPlugin, type PluginApi, type PluginEntry } from "./plugin-loader.ts";
import { readJsonSafe } from "./atomic-json.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISABLED_PREFIX = "plg_disabled_"; // 停用标记：settings key（值为 "1"）

/** 插件面板设置项声明（manifest.panel.settings 项） */
export interface PluginSettingDecl { key: string; label?: string; type?: string; [k: string]: unknown }
/** 插件面板声明（manifest.panel） */
export interface PluginPanel { tabs?: Array<{ id: string; label: string }>; settings?: PluginSettingDecl[]; [k: string]: unknown }
/** 面板列表项（管理页唯一数据源） */
export interface PluginListItem {
  id: string; name: string;
  // manifest 其余字段来自 JSON.parse（PluginManifest 索引签名 → unknown），按原值透传给面板，不做收敛
  version: unknown; description: unknown;
  panel: PluginPanel | null; schedules: unknown[]; disabled: boolean;
  load: { ok: boolean; error: string | null; health: unknown; disabled: boolean };
}
/** 加载结果 + 启停标记（widget 启动 loadEnabledPlugins 写入） */
export type PluginLoadResult = LoadedPlugin & { disabled: boolean };
/** 市场条目（data/plugin-market.json） */
export interface MarketFile { path: string; url: string }
export interface MarketEntry { id: string; name?: string; version?: string; files?: MarketFile[]; [k: string]: unknown }
/** 市场安装可注入项（测试用假 fetch / 假市场） */
export interface InstallPluginOptions {
  fetcher?: (url: string) => Promise<{ ok: boolean; status?: number; text: () => Promise<string> }>;
  pluginsDir?: string;
  market?: MarketEntry[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function defaultPluginsDir(): string {
  return process.env.MIANSHI_PLUGINS_DIR || path.join(ROOT, "plugins");
}

/** 插件是否被停用（面板/设置里关了 → 下次启动跳过加载，路由不注册） */
export function isPluginDisabled(id: unknown): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(DISABLED_PREFIX + String(id)) as { value?: unknown } | undefined;
    return row ? String(row.value) === "1" : false;
  } catch { return false; }
}

/** 启停插件（写标记；已注册的路由在当前进程仍生效，重启后按新状态加载） */
export function setPluginEnabled(id: unknown, enabled: unknown): { ok: boolean; id: string; enabled?: boolean; note?: string; error?: string } {
  const key = DISABLED_PREFIX + String(id);
  try {
    if (enabled) db.prepare("DELETE FROM settings WHERE key=?").run(key);
    else db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)").run(key, "1", Date.now());
    return { ok: true, id: String(id), enabled: !!enabled, note: "重启后生效" };
  } catch (e) {
    return { ok: false, id: String(id), error: errMsg(e).slice(0, 120) };
  }
}

// 加载结果缓存（widget 启动 loadEnabledPlugins 写入；/api/plugins 与 /api/health 查询）
let lastResults: PluginLoadResult[] = [];

/** 加载全部启用插件（跳过 plg_disabled_<id>=1 的插件），结果缓存供面板查询 */
export async function loadEnabledPlugins(api: PluginApi, pluginsDir = defaultPluginsDir()): Promise<PluginLoadResult[]> {
  const results: PluginLoadResult[] = [];
  for (const p of discoverPlugins(pluginsDir) as Array<PluginEntry | null>) {
    if (!p) continue; // 清单损坏 → 跳过（不拖垮宿主）
    const id = p.manifest?.id || "?";
    if (isPluginDisabled(id)) {
      results.push({ ok: false, id, name: p.manifest?.name, version: p.manifest?.version, disabled: true, error: "已停用（可在面板设置→插件管理开启）" });
      continue;
    }
    results.push({ ...(await loadPlugin(p, api)), disabled: false });
  }
  lastResults = results;
  return results;
}

export function getPluginLoadResults(): PluginLoadResult[] { return lastResults; }

/** 面板列表：manifest + 加载结果 + 启停标记（管理页唯一数据源） */
export function listPlugins(pluginsDir = defaultPluginsDir()): PluginListItem[] {
  const loaded = new Map(lastResults.map((r) => [r.id, r]));
  return (discoverPlugins(pluginsDir) as Array<PluginEntry | null>).filter((p): p is PluginEntry => !!p).map((p) => {
    const m = p.manifest;
    // id 参与加载结果 Map 查表，键与 loadEnabledPlugins 的构造保持一致（缺 id → "?"）
    const id = (m?.id || "?") as string;
    const l = loaded.get(id);
    return {
      id,
      name: m?.name || "",
      version: m?.version || "",
      description: m?.description || "",
      panel: (m?.panel as PluginPanel | null) || null,
      schedules: Array.isArray(m?.schedules) ? (m.schedules as unknown[]) : [],
      disabled: isPluginDisabled(id),
      load: l
        ? { ok: l.ok, error: l.error || null, health: l.health || null, disabled: l.disabled || false }
        : { ok: false, error: "未加载", health: null, disabled: false },
    };
  });
}

/** 读插件面板设置（只读 manifest 声明的 key；未声明过则 null） */
export function readPluginSettings(id: string, pluginsDir = defaultPluginsDir()): { ok: boolean; id?: string; settings?: Record<string, unknown>; error?: string } {
  const p = listPlugins(pluginsDir).find((x) => x.id === id);
  if (!p) return { ok: false, error: `插件不存在: ${id}` };
  const decls = (p.panel?.settings || []).filter((s) => s?.key);
  const out: Record<string, unknown> = {};
  for (const s of decls) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(`plg_${id}_${s.key}`) as { value?: unknown } | undefined;
      out[s.key] = row ? JSON.parse(String(row.value)) : null;
    } catch { out[s.key] = null; }
  }
  return { ok: true, id, settings: out };
}

/** 写插件面板设置（只允许 manifest 声明的 key；按声明类型收敛值类型） */
export function writePluginSetting(id: string, key: string, value: unknown, pluginsDir = defaultPluginsDir()): { ok: boolean; id?: string; key?: string; value?: unknown; error?: string } {
  const p = listPlugins(pluginsDir).find((x) => x.id === id);
  const decl = (p?.panel?.settings || []).find((s) => s.key === key);
  if (!decl) return { ok: false, error: `插件 ${id} 未声明设置项 ${key}` };
  const v = decl.type === "toggle" ? !!value : String(value ?? "");
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
      .run(`plg_${id}_${key}`, JSON.stringify(v), Date.now());
    return { ok: true, id, key, value: v };
  } catch (e) {
    return { ok: false, id, key, error: errMsg(e).slice(0, 120) };
  }
}

// ---------- 插件市场（data/plugin-market.json；安装 = 下载声明文件到 plugins/<id>） ----------
const MARKET_PATH = () => path.join(ROOT, "data", "plugin-market.json");

export function getPluginMarket(): { ok: true; plugins: MarketEntry[] } {
  const data = readJsonSafe<{ plugins?: MarketEntry[] }>(MARKET_PATH(), { plugins: [] });
  return { ok: true, plugins: Array.isArray(data.plugins) ? data.plugins : [] };
}

/**
 * 从市场安装插件：按清单 files 逐个下载写入 plugins/<id>/
 * 安全：id 白名单（^[a-z0-9-]+$）；文件相对路径拒绝 .. / 绝对路径（防目录穿越）；
 *      目标必须落在 plugins/<id>/ 内；fetcher 可注入（测试用假 fetch，默认 node fetch）
 */
export async function installPlugin(id: string, opts: InstallPluginOptions = {}): Promise<{ ok: boolean; id?: string; name?: string; version?: string; note?: string; error?: string }> {
  const { fetcher = fetch, pluginsDir = defaultPluginsDir(), market = getPluginMarket().plugins } = opts;
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
    let resp: { ok: boolean; status?: number; text: () => Promise<string> } | undefined;
    try { resp = await fetcher(f.url); } catch (e) {
      return { ok: false, error: `下载失败 ${f.url}: ${errMsg(e).slice(0, 80)}` };
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
    const m = JSON.parse(readFileSync(manifestFile, "utf8")) as { id?: unknown };
    if (m.id !== id) return { ok: false, error: `manifest.id(${String(m.id)}) 与安装目标不一致` };
  } catch {
    return { ok: false, error: "manifest.json 解析失败" };
  }
  return { ok: true, id, name: entry.name || id, version: entry.version || "", note: "已安装，重启后生效（面板设置→插件管理可启停）" };
}
