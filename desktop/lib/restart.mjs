// desktop/lib/restart.mjs —— 桌宠重启设施（纵向拆分：从 desktop/main.mjs 迁出）
// 渲染层产物防呆（app.bundle.js 过期检测 + esbuild 自动重建）+ 暴力清理 widget 进程（重启用）
// 无 electron 依赖（fs/child_process），可单测
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 渲染源码是否比 bundle 新（任一源文件 mtime > bundle mtime 即过期）
 * @param {string} rendererDir desktop/renderer 目录
 * @param {string[]} srcFiles 源码文件名（app.js/index.html/style.css）
 */
export function rendererBundleStale(rendererDir, srcFiles) {
  const bundle = path.join(rendererDir, "app.bundle.js");
  try {
    if (!existsSync(bundle)) return true;
    const bm = statSync(bundle).mtimeMs;
    return srcFiles.some((f) => existsSync(path.join(rendererDir, f)) && statSync(path.join(rendererDir, f)).mtimeMs > bm);
  } catch { return false; }
}

/** 重建 app.bundle.js（esbuild；失败不阻塞重启，返回是否成功） */
export function rebuildRendererBundle(root) {
  return new Promise((resolve) => {
    const esbuildBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
    if (!existsSync(esbuildBin)) { console.log("[renderer] esbuild 未安装，跳过自动构建"); resolve(false); return; }
    const child = spawn(esbuildBin, ["desktop/renderer/app.js", "--bundle", "--format=esm", "--outfile=desktop/renderer/app.bundle.js", "--log-level=warning"], {
      cwd: root, windowsHide: true, stdio: "ignore",
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 60000);
    child.on("exit", (code) => { clearTimeout(timer); console.log(`[renderer] 自动重建 bundle ${code === 0 ? "成功" : "失败(code=" + code + ")"}`); resolve(code === 0); });
    child.on("error", () => { clearTimeout(timer); console.log("[renderer] esbuild 启动失败"); resolve(false); });
  });
}

/**
 * 一键重启专用：杀全部 widget 子进程（含外部残留，按命令行匹配）→ 主进程 relaunch 后重新拉起
 * 教训：cleanupWidget 只杀本实例拉起的 pid；测试/手动残留的 widget 占着 8899 会导致
 * 重启后新主进程探测到旧服务而不重新拉起 → "重启没生效"。这里按命令行全杀，治本。
 */
export function killAllWidgetProcesses() {
  try {
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'widget\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { windowsHide: true, timeout: 5000, stdio: "ignore" }
    );
    console.log("[kanban] 已清理全部 widget 进程（含外部残留）");
  } catch { /* ignore */ }
}
