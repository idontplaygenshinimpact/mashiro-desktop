// lib/plugin-loader.ts —— 插件加载器（阶段 1 + 阶段 2 扩展）
// 协议：plugins/<id>/ 目录含 manifest.json（id/name/version/server + 可选 panel/schedules）
//       server.mjs 导出 register(api)（必需）+ init(api)/health()（可选）
//       api = { router, db, getCorsOrigin, laneSubmit, settings, log, ... }（宿主注入）
// 隔离：单插件加载失败不拖垮宿主（返回 { ok:false, error }，其余插件继续）
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 打包版：asar 内 plugins/ 只读——主进程注入 MIANSHI_PLUGINS_DIR=<unpacked>/plugins（可写，
// 市场安装落盘于此）；源码模式默认项目 plugins/
const DEFAULT_PLUGINS_DIR = process.env.MIANSHI_PLUGINS_DIR || path.join(ROOT, "plugins");

/** 扫描 plugins/ 下带 manifest.json 的插件目录 */
export function discoverPlugins(pluginsDir = DEFAULT_PLUGINS_DIR) {
  try {
    return readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = path.join(pluginsDir, d.name);
        const manifestFile = path.join(dir, "manifest.json");
        if (!existsSync(manifestFile)) return null;
        try {
          const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
          return { dir, manifest };
        } catch { return null; } // manifest 损坏 → 跳过（不拖垮宿主）
      })
      .filter(Boolean);
  } catch { return []; }
}

/** manifest 校验（id 只允许小写字母/数字/连字符——命名空间安全；panel/settings 声明结构校验） */
/** 插件 manifest 最小形状（校验通过后调用方读这些字段；其余字段由插件自定义） */
export interface PluginManifest { id: string; name: string; server: string; [k: string]: unknown }
/** 宿主注入给插件的 api：db（settings 表读写）+ 其余由宿主扩展（动态面保留索引签名） */
export type PluginApi = {
  db?: { prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined; run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => Array<Record<string, unknown>> } };
} & Record<string, unknown>;
/** 已扫描到的插件条目（manifest + 目录 + 动态 import 的模块） */
export interface PluginEntry {
  manifest?: PluginManifest; dir: string;
  plugin?: { register?: (api: PluginApi) => unknown; init?: (api: PluginApi) => unknown; health?: () => unknown };
}
export function validateManifest(m: unknown): string | null {
  const mm = m as { id?: unknown; name?: unknown; server?: unknown; panel?: { tabs?: Array<{ id?: unknown; label?: unknown }>; settings?: Array<{ key?: unknown; type?: unknown }> } };
  if (!mm.id || !mm.name || !mm.server) return "manifest 缺少 id/name/server";
  if (!/^[a-z0-9-]+$/.test(String(mm.id))) return `非法插件 id: ${mm.id}（只允许小写字母/数字/连字符）`;
  // 阶段 2：panel 声明校验（tabs/settings 结构）
  if (mm.panel !== undefined) {
    if (mm.panel === null || typeof mm.panel !== "object" || Array.isArray(mm.panel)) return "panel 必须是对象";
    if (mm.panel.tabs !== undefined) {
      if (!Array.isArray(mm.panel.tabs)) return "panel.tabs 必须是数组";
      for (const t of mm.panel.tabs) {
        if (!t?.id || !t?.label || !/^[a-z0-9-]+$/.test(String(t.id))) return "panel.tabs 项需含合法 id/label";
      }
    }
    if (mm.panel.settings !== undefined) {
      if (!Array.isArray(mm.panel.settings)) return "panel.settings 必须是数组";
      for (const s of mm.panel.settings) {
        if (!s?.key || !["text", "toggle", "password"].includes(String(s?.type))) return `panel.settings 项需含 key + 合法 type(text/toggle/password)`;
      }
    }
  }
  return null;
}

/**
 * 加载单个插件：import server → init(api) → register(api)；失败隔离（不抛）
 * 阶段 2 扩展：init 钩子（默认设置/资源准备）、health 检查、settings 命名空间
 */
export interface LoadedPlugin { ok: boolean; id: string; name?: string; version?: unknown; panel?: unknown; schedules?: unknown[]; health?: unknown; error?: string }
export async function loadPlugin(plugin: PluginEntry, api: PluginApi): Promise<LoadedPlugin> {
  const manifest = plugin?.manifest as PluginManifest | undefined;
  const err = validateManifest(manifest);
  if (err) return { ok: false, id: manifest?.id || "?", error: err };
  const id = String(manifest?.id || "?");
  try {
    const mod = await import(pathToFileURL(path.join(plugin.dir, String(manifest?.server || ""))).href);
    if (typeof mod?.register !== "function") {
      return { ok: false, id, error: `server 未导出 register(api)` };
    }
    // 插件设置命名空间：key 自动加 plg_<id>_ 前缀（避免与宿主/其他插件 key 冲突）
    const settingsNs = {
      get: (key: string) => {
        try {
          const row = api.db?.prepare("SELECT value FROM settings WHERE key=?").get(`plg_${id}_${key}`);
          if (row?.value == null) return null;
          return JSON.parse(String(row.value));
        } catch { return null; }
      },
      set: (key: string, value: unknown) => {
        try {
          api.db?.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)")
            .run(`plg_${id}_${key}`, JSON.stringify(value), Date.now());
          return true;
        } catch { return false; }
      },
    };
    // init 钩子（默认设置等；失败仅记日志不阻断 register）
    if (typeof mod?.init === "function") {
      try { await mod.init(Object.assign(api, { settings: settingsNs, pluginId: id })); } catch { /* init 失败不阻断 */ }
    }
    // 注入 settings/pluginId（Object.assign 保持引用——展开复制会让 register 的副作用丢失）
    await mod.register(Object.assign(api, { settings: settingsNs, pluginId: id }));
    return {
      ok: true, id, name: String(manifest?.name || ""), version: manifest?.version,
      panel: manifest?.panel || null,
      schedules: Array.isArray(manifest?.schedules) ? manifest.schedules : [],
      health: typeof mod?.health === "function" ? (() => { try { return mod.health() || { ok: true }; } catch { return { ok: false, detail: "健康检查异常" }; } })() : null,
    };
  } catch (e) {
    return { ok: false, id, error: `加载失败: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
}

/** 加载全部插件（按目录顺序；单插件失败不中断其余） */
export async function loadAllPlugins(api: PluginApi, pluginsDir: string): Promise<LoadedPlugin[]> {
  const results: LoadedPlugin[] = [];
  for (const p of discoverPlugins(pluginsDir)) {
    if (!p) continue; // discoverPlugins 可能返回 null（清单损坏）——原实现会直接把 null 传下去
    results.push(await loadPlugin(p, api));
  }
  return results;
}
