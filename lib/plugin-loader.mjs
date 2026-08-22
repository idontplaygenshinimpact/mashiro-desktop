// lib/plugin-loader.mjs —— 插件加载器（阶段 1）
// 协议：plugins/<id>/ 目录含 manifest.json（id/name/version/server）+ server.mjs 导出 register(api)
//       api = { router, db, getCorsOrigin, laneSubmit, ... }（宿主注入）
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

/** manifest 校验（id 只允许小写字母/数字/连字符——命名空间安全） */
export function validateManifest(m) {
  if (!m?.id || !m?.name || !m?.server) return "manifest 缺少 id/name/server";
  if (!/^[a-z0-9-]+$/.test(String(m.id))) return `非法插件 id: ${m.id}（只允许小写字母/数字/连字符）`;
  return null;
}

/** 加载单个插件：import server → register(api)；失败隔离（不抛） */
export async function loadPlugin(plugin, api) {
  const err = validateManifest(plugin?.manifest);
  if (err) return { ok: false, id: plugin?.manifest?.id || "?", error: err };
  const id = plugin.manifest.id;
  try {
    const mod = await import(pathToFileURL(path.join(plugin.dir, plugin.manifest.server)).href);
    if (typeof mod?.register !== "function") {
      return { ok: false, id, error: `server 未导出 register(api)` };
    }
    await mod.register(api);
    return { ok: true, id, name: plugin.manifest.name, version: plugin.manifest.version };
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
