// 桌宠形象管理：枚举本地 Live2D 模型 + 当前形象持久化
// 模型来源：node_modules/live2d-widget-model-* 包（model.json 深度扫描）
// 持久化：data/mascot-model.json（主进程读取，渲染层 preload 传路径）
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// 测试隔离：MIANSHI_MASCOT_MODEL 指向临时文件（生产不设置则用默认路径）
const MODELS_FILE = process.env.MIANSHI_MASCOT_MODEL
  || path.join(process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "data"), "mascot-model.json");

/** 扫描 node_modules 下全部 Live2D 模型（model.json），返回 [{id, name, package, path, url}] */
export function scanMascotModels(root = path.join(import.meta.dirname, "..", "node_modules")) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith("live2d-widget-model-")) continue;
    const pkgDir = path.join(root, dir.name);
    const walk = (d, depth = 0) => {
      if (depth > 4) return;
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) { walk(path.join(d, e.name), depth + 1); continue; }
        if (e.name.endsWith(".model.json")) {
          const full = path.join(d, e.name);
          // 形象名：目录结构推断（mashiro 包的 seifuku/shifuku/ryoufuku）或包名
          const parts = full.replace(/\\/g, "/").split("/");
          const fileBase = e.name.replace(".model.json", "");
          const parent = parts[parts.length - 2] || "";
          const isMashiro = dir.name.includes("mashiro");
          let name = fileBase;
          const NAME_MAP = { ryoufuku: "旅行装", seifuku: "水手服", shifuku: "私服", mashiro: "真白" };
          if (NAME_MAP[name]) name = NAME_MAP[name];
          else if (isMashiro && parent === "mashiro") name = parent; // Sakurasou/mashiro/*.model.json
          const display = isMashiro ? `真白·${name}` : dir.name.replace("live2d-widget-model-", "");
          out.push({
            id: `${dir.name}/${full.replace(/\\/g, "/").split("/").slice(-3).join("/")}`,
            name: display,
            package: dir.name,
            path: full,
          });
        }
      }
    };
    walk(pkgDir);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** 读当前形象路径（文件缺失/损坏 → 默认真白旅行装） */
export function getCurrentModel(models = null) {
  const list = models || scanMascotModels();
  let saved = "";
  try {
    if (existsSync(MODELS_FILE)) {
      const j = JSON.parse(readFileSync(MODELS_FILE, "utf8"));
      if (typeof j?.path === "string") saved = j.path;
    }
  } catch { /* ignore */ }
  const match = list.find((m) => m.path === saved);
  return match ? match.path : (list[0]?.path || "");
}

/** 保存当前形象 */
export function saveCurrentModel(modelPath) {
  try {
    mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
    writeFileSync(MODELS_FILE, JSON.stringify({ path: String(modelPath), ts: Date.now() }, null, 2), "utf8");
    return true;
  } catch { return false; }
}
