// desktop/lib/widget-server.mjs —— 后端 widget 服务守护（纵向拆分：从 desktop/main.mjs 迁出）
// 启动/复用 widget.mjs + 持续探测守护（挂了自动拉起）+ 退出清理（只杀本实例拉起的进程）
// 依赖注入：widgetFetch（带 token 的 fetch，来自 widget-auth.mjs）+ healthUrl；无 electron 依赖
import { spawn, spawnSync } from "node:child_process";

/** 安全 spawn：始终挂 error 处理器，避免子进程 'error' 未捕获导致主进程崩溃 */
export function safeSpawn(cmd, args, opts = {}) {
  try {
    const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: "ignore", ...opts });
    child.on("error", (err) => console.log(`[kanban] spawn ${cmd} 失败: ${err.message}`));
    try { child.unref(); } catch { /* ignore */ }
    return child;
  } catch (err) {
    console.log(`[kanban] spawn ${cmd} 异常: ${err.message}`);
    return null;
  }
}

/**
 * 创建 widget 服务守护器
 * @param {object} deps
 * @param {Function} deps.widgetFetch 带 Bearer token 的 fetch（widgetFetchFactory 产物）
 * @param {string} deps.healthUrl 认证豁免健康检查端点
 * @param {string} deps.root 项目根目录（spawn widget.mjs 的 cwd）
 */
export function createWidgetServer({ widgetFetch, healthUrl: healthUrlValue, root }) {
  // 本实例拉起的 widget 子进程 pid 集合（退出清理只杀自己拉起的，避免误杀其他 node 实例/开发进程）
  const spawnedPids = new Set();
  let widgetProc = null;

  /** 探测 + 拉起：/api/health 认证豁免（探测 /api/refresh 会被 401 误判未启动 → 疯狂重复 spawn） */
  function ensure() {
    widgetFetch(healthUrlValue, { signal: AbortSignal.timeout(5000) })
      .then((r) => { if (!r.ok) throw new Error("bad status"); })
      .catch(() => {
        if (widgetProc && widgetProc.exitCode === null) return; // 已在运行，不重复启动
        const child = safeSpawn("node", ["widget.mjs"], { cwd: root });
        widgetProc = child;
        if (child) {
          spawnedPids.add(child.pid);
          child.on("exit", () => { spawnedPids.delete(child.pid); if (widgetProc === child) widgetProc = null; });
          // spawn 失败（如 ENOENT）是异步 'error' 事件，exit 永不触发 → 不清引用会永久卡死守卫；
          // 这里清掉引用并记录失败原因，允许下一轮探测重试
          child.on("error", (err) => {
            console.log(`[kanban] widget.mjs 启动失败: ${err?.message || err}`);
            spawnedPids.delete(child.pid);
            if (widgetProc === child) widgetProc = null;
          });
          console.log("[kanban] widget.mjs 已后台拉起");
        }
      });
  }

  /**
   * 退出清理：只杀本实例拉起的 widget 数据服务 + 其拉起的 discover 爬虫子进程
   * （不用 CommandLine 匹配，避免误杀其他 node 实例/开发进程）
   */
  function cleanup() {
    const pids = [...spawnedPids];
    if (!pids.length) return;
    const parentCond = pids.map((p) => `($_.ParentProcessId -eq ${p})`).join(" -or ");
    const selfCond = pids.map((p) => `($_.ProcessId -eq ${p})`).join(" -or ");
    try {
      spawnSync(
        "powershell",
        ["-NoProfile", "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ${parentCond} -or ${selfCond} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { windowsHide: true, timeout: 5000, stdio: "ignore" }
      );
      console.log("[kanban] 已停止后台服务与爬虫进程");
    } catch { /* ignore */ }
  }

  return { ensure, cleanup, isRunning: () => !!(widgetProc && widgetProc.exitCode === null) };
}
