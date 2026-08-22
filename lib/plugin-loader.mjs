// lib/plugin-loader.mjs —— 插件加载器（阶段 1 + 阶段 2 扩展）
// 协议：plugins/<id>/ 目录含 manifest.json（id/name/version/server + 可选 panel/schedules）
//       server.mjs 导出 register(api)（必需）+ init(api)/health()（可选）
//       api = { router, db, getCorsOrigin, laneSubmit, settings, log, ... }（宿主注入）
// 隔离：单插件加载失败不拖垮宿主（返回 { ok:false, error }，其余插件继续）
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 扫描 plugins/ 下带 manifest.json 的插件目录 */
export function discoverPlugins(pluginsDir = path.join(ROOT, "plugins")) {
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
export function validateManifest(m) {
  if (!m?.id || !m?.name || !m?.server) return "manifest 缺少 id/name/server";
  if (!/^[a-z0-9-]+$/.test(String(m.id))) return `非法插件 id: ${m.id}（只允许小写字母/数字/连字符）`;
  // 阶段 2：panel 声明校验（tabs/settings 结构）
  if (m.panel !== undefined) {
    if (m.panel === null || typeof m.panel !== "object" || Array.isArray(m.panel)) return "panel 必须是对象";
    if (m.panel.tabs !== undefined) {
      if (!Array.isArray(m.panel.tabs)) return "panel.tabs 必须是数组";
      for (const t of m.panel.tabs) {
        if (!t?.id || !t?.label || !/^[a-z0-9-]+$/.test(String(t.id))) return "panel.tabs 项需含合法 id/label";
      }
    }
    if (m.panel.settings !== undefined) {
      if (!Array.isArray(m.panel.settings)) return "panel.settings 必须是数组";
      for (const s of m.panel.settings) {
        if (!s?.key || !["text", "toggle", "password"].includes(s?.type)) return `panel.settings 项需含 key + 合法 type(text/toggle/password)`;
      }
    }
  }
  return null;
}

/**
 * 加载单个插件：import server → init(api) → register(api)；失败隔离（不抛）
 * 阶段 2 扩展：init 钩子（默认设置/资源准备）、health 检查、settings 命名空间
 */
export async function loadPlugin(plugin, api) {
  const err = validateManifest(plugin?.manifest);
  if (err) return { ok: false, id: plugin?.manifest?.id || "?", error: err };
  const id = plugin.manifest.id;
  try {
    const mod = await import(pathToFileURL(path.join(plugin.dir, plugin.manifest.server)).href);
    if (typeof mod?.register !== "function") {
      return { ok: false, id, error: `server 未导出 register(api)` };
    }
    // 插件设置命名空间：key 自动加 plg_<id>_ 前缀（避免与宿主/其他插件 key 冲突）
    const settingsNs = {
      get: (key) => {
        try {
          const row = api.db?.prepare("SELECT value FROM settings WHERE key=?").get(`plg_${id}_${key}`);
          if (row?.value == null) return null;
          return JSON.parse(String(row.value));
        } catch { return null; }
      },
      set: (key, value) => {
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
      ok: true, id, name: plugin.manifest.name, version: plugin.manifest.version,
      panel: plugin.manifest.panel || null,
      schedules: plugin.manifest.schedules || [],
      health: typeof mod?.health === "function" ? (() => { try { return mod.health() || { ok: true }; } catch { return { ok: false, detail: "健康检查异常" }; } })() : null,
    };
  } catch (e) {
    return { ok: false, id, error: `加载失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 加载全部插件（按目录顺序；单插件失败不中断其余） */
export async function loadAllPlugins(api, pluginsDir) {
  const results = [];
  for (const p of discoverPlugins(pluginsDir)) {
    results.push(await loadPlugin(p, api));
  }
  return results;
}
