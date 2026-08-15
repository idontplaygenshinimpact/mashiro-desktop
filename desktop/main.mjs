// 看板娘 Electron 主进程
// 透明无边框窗口 + 置顶 + 拖拽 + 系统托盘
import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, exec, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { WIDGET_URL, loadTokenFromFile, shouldInjectAuth, widgetFetchFactory, healthUrl } from "../lib/widget-auth.mjs";

// ---------- 启动加速 ----------
// 注意：透明窗口 + disable-gpu 会导致窗口不渲染（看不到）。
// 先用保守配置保证可见，后续再优化。
// app.commandLine.appendSwitch("disable-gpu");
// app.commandLine.appendSwitch("disable-gpu-compositing");
// app.commandLine.appendSwitch("disable-software-rasterizer");
// app.disableHardwareAcceleration();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let win = null;
let panelWin = null;
let tray = null;
let widgetProc = null; // 后端数据服务（widget.mjs）
let fitReceived = false; // 渲染层是否已上报 window:fit（用于兜底显示）

// 本实例拉起的 widget 子进程 pid 集合（退出清理只杀自己拉起的，避免误杀其他 node 实例/开发进程）
const spawnedWidgetPids = new Set();

// ---------- 单实例锁（防注册表自启 + 用户双击 → 双托盘/双守护） ----------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 已有实例：聚焦现有窗口（优先面板，其次桌宠）
    if (panelWin && !panelWin.isDestroyed()) {
      panelWin.show();
      panelWin.focus();
    } else if (win && !win.isDestroyed()) {
      win.show();
    }
  });
}

// ---------- 安全 spawn：始终挂 error 处理器，避免子进程 'error' 未捕获导致主进程崩溃 ----------
function safeSpawn(cmd, args, opts = {}) {
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

// ---------- 启动/复用后端 widget 服务（含守护：死了自动拉起） ----------
function ensureWidgetServer() {
  // 探测 /api/health：认证豁免端点（主进程 fetch 不走 webRequest token 注入，
  // 探测 /api/refresh 会被 401 误判 widget 未启动 → 疯狂重复 spawn）
  // 5s 超时：widget 卡死时不再无限挂起，超时视为未启动
  widgetFetch(healthUrl(), { signal: AbortSignal.timeout(5000) })
    .then((r) => { if (!r.ok) throw new Error("bad status"); })
    .catch(() => {
      if (widgetProc && widgetProc.exitCode === null) return; // 已在运行，不重复启动
      const child = safeSpawn("node", ["widget.mjs"], { cwd: ROOT });
      widgetProc = child;
      if (child) {
        spawnedWidgetPids.add(child.pid);
        child.on("exit", () => { spawnedWidgetPids.delete(child.pid); if (widgetProc === child) widgetProc = null; });
        console.log("[kanban] widget.mjs 已后台拉起");
      }
    });
}

// 持续守护：每 30 秒探测，挂了自动重启
if (gotSingleInstanceLock) setInterval(ensureWidgetServer, 30000);

// 退出时清理：只杀本实例拉起的 widget 数据服务 + 其拉起的 discover 爬虫子进程
// （不再用 CommandLine 匹配，避免误杀其他 node 实例/开发进程）
function cleanupWidget() {
  const pids = [...spawnedWidgetPids];
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
app.on("before-quit", () => { cleanupWidget(); });

// ---------- 托盘图标（用字符画生成简单图标） ----------
function createTrayIcon() {
  // 生成一个 16x16 的图标：紫色圆点 + 白边，表示"看板娘在线"
  const size = 16;
  const canvasData = Buffer.alloc(size * size * 4);
  const cx = 8, cy = 8, r = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      const idx = (y * size + x) * 4;
      if (d <= r) {
        canvasData[idx] = 138; canvasData[idx + 1] = 90; canvasData[idx + 2] = 220; // #8a5adc
        canvasData[idx + 3] = 255;
        if (d > r - 1.5) { canvasData[idx] = 255; canvasData[idx + 1] = 255; canvasData[idx + 2] = 255; }
      } else {
        canvasData[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(canvasData, { width: size, height: size });
}

// ---------- 窗口位置持久化（data/window-state.json，防抖保存） ----------
const STATE_FILE = path.join(ROOT, "data", "window-state.json");
let mascotState = { x: null, y: null };
let panelState = { x: null, y: null, width: null, height: null };
let stateSaveTimer = null;

function readWindowState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveWindowState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ mascot: mascotState, panel: panelState }, null, 2), "utf8");
  } catch { /* ignore */ }
}
function scheduleSaveWindowState() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(saveWindowState, 400); // 防抖，避免拖动时频繁写盘
}
// 校验位置是否在屏内（至少露出 40px，避免恢复到屏幕外）
function isOnScreen(x, y, w, h) {
  try {
    const { workArea } = screen.getPrimaryDisplay();
    const minVisible = 40;
    return (
      x + minVisible <= workArea.x + workArea.width &&
      x + w - minVisible >= workArea.x &&
      y + minVisible <= workArea.y + workArea.height &&
      y + h - minVisible >= workArea.y
    );
  } catch { return false; }
}

// ---------- 创建透明悬浮窗 ----------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // 固定窗口尺寸（创建即锁定，绝不做 setSize——透明窗口 setSize 会被系统二次调整导致"长按增大"）
  const W = 220, H = 360;
  console.log(`[kanban] workArea: x=${workArea.x} y=${workArea.y} w=${workArea.width} h=${workArea.height}`);
  // 恢复上次保存的桌宠位置（校验在屏内，避免恢复到屏幕外）
  let winX = workArea.x + workArea.width - W - 12;
  let winY = workArea.y + workArea.height - H - 12;
  const savedMascot = readWindowState().mascot;
  if (savedMascot && Number.isFinite(savedMascot.x) && Number.isFinite(savedMascot.y) && isOnScreen(savedMascot.x, savedMascot.y, W, H)) {
    winX = Math.round(savedMascot.x);
    winY = Math.round(savedMascot.y);
  }
  console.log(`[kanban] window pos: ${winX}, ${winY}`);

  win = new BrowserWindow({
    width: W,
    height: H,
    x: winX,
    y: winY,
    // 透明窗口（角色本体悬浮，无背景块）——模型渲染已修复，透明应正常
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    show: false, // 先隐藏，等渲染层模型就绪再显示
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 给渲染层传模型绝对路径（避免 file:// 相对路径问题）
      additionalArguments: [
        `--model-path=${path.join(ROOT, "node_modules", "live2d-widget-model-mashiro-zamp", "assets", "model", "Sakurasou", "mashiro", "ryoufuku.model.json")}`,
      ],
    },
  });

  // 创建即锁死尺寸（min=max=初始值），杜绝任何窗口尺寸变化
  win.setMinimumSize(W, H);
  win.setMaximumSize(W, H);

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("paint", () => {});
  win.webContents.on("did-finish-load", () => console.log("[kanban] page loaded"));
  win.webContents.on("did-fail-load", (e, code, desc) => console.log(`[kanban] FAIL load: ${code} ${desc}`));
  win.webContents.on("console-message", (e, level, message) => console.log(`[renderer] ${message}`));

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // 兜底：渲染层 15s 内未上报 window:fit（模型加载失败/渲染层崩溃）→ 强制显示，避免应用永远不可见
  const fitFallbackTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible() && !fitReceived) {
      win.showInactive();
      console.log("[kanban] 渲染层未上报就绪，兜底显示窗口");
    }
  }, 15000);
  // 位置持久化：拖动后防抖保存
  win.on("moved", () => {
    try {
      const [x, y] = win.getPosition();
      mascotState = { x, y };
      scheduleSaveWindowState();
    } catch { /* ignore */ }
  });
  win.on("closed", () => { clearTimeout(fitFallbackTimer); win = null; });
}

// ---------- 托盘 ----------
function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("mianshi-agent 看板娘");
  const menu = Menu.buildFromTemplate([
    { label: "📌 看板娘", enabled: false },
    { type: "separator" },
    { label: "显示/隐藏", click: () => { if (win) { win.isVisible() ? win.hide() : win.show(); } } },
    { label: "打开面板", click: () => { createPanelWindow(); } },
    { label: "立即爬取", click: () => { widgetPost("/api/run-discover", {}).catch(() => {}); } },
    { label: "打开输出目录", click: () => { safeSpawn("explorer", [path.join(ROOT, "output")]); } },
    { type: "separator" },
    { label: "退出", click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
}

// ---------- IPC ----------
ipcMain.handle("widget:data", async () => {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/widget-data`);
    return await res.json();
  } catch {
    return { error: "widget 服务未启动" };
  }
});

ipcMain.handle("widget:run-discover", async () => {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/run-discover`);
    return await res.json();
  } catch {
    return { error: "widget 服务未启动" };
  }
});

ipcMain.handle("widget:progress", async () => {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/progress`);
    return await res.json();
  } catch {
    return { status: "idle", message: "widget 服务未启动" };
  }
});

// 对话 + 学习清单转发（widget 服务实现）
async function widgetPost(pathname, body) {
  try {
    const res = await widgetFetch(`${WIDGET_URL}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch {
    return { error: "widget 服务未启动" };
  }
}
async function widgetGet(pathname) {
  try {
    const res = await widgetFetch(`${WIDGET_URL}${pathname}`);
    return await res.json();
  } catch {
    return { error: "widget 服务未启动" };
  }
}
ipcMain.handle("widget:chat", (e, { message, history }) => widgetPost("/api/chat", { message, history }));
ipcMain.handle("widget:study-plan", () => widgetGet("/api/study-plan"));
ipcMain.handle("widget:interview-history", () => widgetGet("/api/interview/history"));
ipcMain.handle("widget:stats", () => widgetGet("/api/stats"));
ipcMain.handle("widget:observability", () => widgetGet("/api/observability"));
// 自动巡检配置：无参数 GET 读取，有参数 POST 修改（即时重排定时器）
ipcMain.handle("widget:patrol-config", (e, cfg) => (cfg && Object.keys(cfg).length ? widgetPost("/api/patrol-config", cfg) : widgetGet("/api/patrol-config")));
ipcMain.handle("widget:patrol-run", () => widgetPost("/api/patrol-run", {}));
ipcMain.handle("widget:interview-notes", (e, { topics }) => widgetPost("/api/interview-notes", { topics }));
ipcMain.handle("widget:study-detail", (e, { id }) => widgetGet(`/api/study-detail?id=${encodeURIComponent(id)}`));
// 流式讲解：main 转发 widget SSE → 渲染层事件（避开渲染层 CORS/webSecurity 限制）
ipcMain.handle("widget:study-detail-stream", async (e, { id }) => {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/study-detail-stream?id=${encodeURIComponent(id)}`);
    const ctype = res.headers.get("content-type") || "";
    // 有文件：一次性 JSON
    if (!ctype.includes("text/event-stream")) {
      const j = await res.json();
      e.sender.send("study-detail-chunk", JSON.stringify(j));
      return { ok: true, mode: "json" };
    }
    // 无文件：SSE 流，逐块转发
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        e.sender.send("study-detail-chunk", event); // 原样转发 data: {...}
      }
    }
    return { ok: true, mode: "sse" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 讲解追问补充：main 转发 widget append-stream SSE → 渲染层（独立事件通道）
ipcMain.handle("widget:study-append-stream", async (e, { id, question }) => {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/study-append-stream?id=${encodeURIComponent(id)}&question=${encodeURIComponent(question)}`);
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const j = await res.json();
      e.sender.send("study-append-chunk", JSON.stringify(j));
      return { ok: true, mode: "json" };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        e.sender.send("study-append-chunk", event);
      }
    }
    return { ok: true, mode: "sse" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 整理讲解全文：main 转发 widget consolidate-stream SSE → 渲染层（独立事件通道）
ipcMain.handle("widget:study-consolidate-stream", async (e, { id }) => {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/study-consolidate-stream?id=${encodeURIComponent(id)}`);
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const j = await res.json();
      e.sender.send("study-consolidate-chunk", JSON.stringify(j));
      return { ok: true, mode: "json" };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        e.sender.send("study-consolidate-chunk", event);
      }
    }
    return { ok: true, mode: "sse" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 多条目归并：main 转发 widget cluster-stream SSE → 渲染层（独立事件通道）
ipcMain.handle("widget:study-cluster-stream", async (e, { ids }) => {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/study-cluster-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) {
      const j = await res.json();
      e.sender.send("study-cluster-chunk", JSON.stringify(j));
      return { ok: true, mode: "json" };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        e.sender.send("study-cluster-chunk", event);
      }
    }
    return { ok: true, mode: "sse" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("widget:study-generate", () => widgetPost("/api/study-generate"));
ipcMain.handle("widget:study-check", (e, { id, done }) => widgetGet(`/api/study-check?id=${encodeURIComponent(id)}&done=${done ? "1" : "0"}`));
ipcMain.handle("widget:study-review", () => widgetPost("/api/study-review"));
ipcMain.handle("widget:study-answer", (e, { answers }) => widgetPost("/api/study-answer", { answers }));

// 模拟面试转发
ipcMain.handle("interview:start", (e, cfg) => widgetPost("/api/interview/start", cfg || {}));
ipcMain.handle("interview:answer", (e, { answer }) => widgetPost("/api/interview/answer", { answer }));
ipcMain.handle("interview:end", () => widgetPost("/api/interview/end", {}));

// 复习转发
        ipcMain.handle("review:due", () => widgetGet("/api/review/due"));
        ipcMain.handle("review:submit", (e, { id, rating }) => widgetPost("/api/review/submit", { id, rating }));
        ipcMain.handle("widget:mastery", () => widgetGet("/api/mastery"));

ipcMain.handle("widget:notify", async (e, { title, message }) => {
  // 系统通知（复用 node-notifier 同款 toast）
  try {
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($template.CreateTextNode('${String(title).replace(/'/g, "")}')) > $null
$textNodes.Item(1).AppendChild($template.CreateTextNode('${String(message).replace(/'/g, "")}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('MianshiAgent').Show($toast)`;
    safeSpawn("powershell", ["-NoProfile", "-Command", ps]);
  } catch { /* ignore */ }
  return { ok: true };
});

ipcMain.handle("window:quit", () => app.quit());

// 打开指定文件（用系统默认程序，如 md 编辑器/浏览器）
ipcMain.handle("window:open-file", (e, { filePath }) => {
  if (!filePath) return { ok: false, error: "no path" };
  // 白名单：仅允许打开 ROOT/output 与 ROOT/data 内的文件（防任意路径打开/执行）
  const target = path.resolve(String(filePath));
  const allowed = [path.join(ROOT, "output"), path.join(ROOT, "data")];
  const inAllowed = allowed.some((dir) => target === dir || target.startsWith(dir + path.sep));
  if (!inAllowed) return { ok: false, error: "路径不在允许范围" };
  try {
    shell.openPath(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 打开输出目录（explorer）
ipcMain.handle("window:open-output", () => {
  safeSpawn("explorer", [path.join(ROOT, "output")]);
  return { ok: true };
});

// 语音播放：edge-tts 神经语音（日语声线，真白人设）→ 失败降级系统 TTS（也是日语）
// 语音文本按"真白人设"由 agent 生成后传入；显示中文、播放日语声
let ttsEdge = null;
async function getTtsEdge() {
  if (!ttsEdge) {
    try { ttsEdge = await import("./tts-edge.mjs"); } catch { ttsEdge = null; }
  }
  return ttsEdge;
}
// 固定语音包场景播放（无文本事件：点击/托盘等 → 直接播预设日语台词，零延迟）
ipcMain.handle("window:play-scene", async (e, { scene }) => {
  try {
    const vp = await import("./voice-pack.mjs");
    const r = vp.playScene(String(scene || ""));
    return r || { ok: false };
  } catch {
    return { ok: false };
  }
});
// 语音全局开关：面板 🔊 切换 → 广播到所有窗口（桌宠 app.js 订阅同步静音/恢复）
ipcMain.handle("voice:set", (e, enabled) => {
  const on = !!enabled;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed()) w.webContents.send("voice-changed", on);
  }
  return { ok: true, enabled: on };
});
// 语音输入：本地 whisper 转写（面板 🎤 → Float32Array → 文本）
ipcMain.handle("speech:transcribe", async (e, { audio }) => {
  try {
    const { transcribeAudio } = await import("../lib/speech.mjs");
    return await transcribeAudio(audio);
  } catch (err) {
    return { ok: false, error: `语音模块异常: ${String(err?.message || err).slice(0, 120)}` };
  }
});

// 简历文件解析（PDF/docx）：Node 端本地解析
// 原因：浏览器端 bare specifier import + CDN worker 不可靠（无网络/被墙即失败）
ipcMain.handle("resume:parse-file", async (e, { name, data }) => {
  const n = String(name || "");
  const ext = n.slice(n.lastIndexOf(".")).toLowerCase();
  try {
    if (ext === ".pdf") {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const { pathToFileURL } = await import("node:url");
      // 中文 PDF 需要 cmap 数据（CID 字体映射）；Node 端要求 file:// URL（含尾斜杠）
      const pdfjsRoot = path.join(import.meta.dirname, "..", "node_modules", "pdfjs-dist");
      const pdf = await getDocument({
        data: new Uint8Array(data),
        cMapUrl: pathToFileURL(path.join(pdfjsRoot, "cmaps") + path.sep).toString(),
        cMapPacked: true,
        standardFontDataUrl: pathToFileURL(path.join(pdfjsRoot, "standard_fonts") + path.sep).toString(),
        useWorkerFetch: false,
        isEvalSupported: false,
        disableFontFace: true,
      }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((it) => (it.str || "")).filter(Boolean).join(" "));
      }
      const text = pages.join("\n").trim();
      if (!text) return { ok: false, error: "PDF 没有可提取文本，可能是图片型 PDF，请复制文本粘贴" };
      return { ok: true, text, msg: `已解析 PDF 简历（${pdf.numPages} 页）` };
    }
    if (ext === ".docx") {
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
      const text = (result.value || "").trim();
      if (!text) return { ok: false, error: "Word 文件中没有可分析文本" };
      return { ok: true, text, msg: "已解析 Word 简历" };
    }
    return { ok: false, error: "unsupported" };
  } catch (err) {
    return { ok: false, error: `解析失败: ${String(err?.message || err).slice(0, 120)}` };
  }
});

ipcMain.handle("window:speak", async (e, { text }) => {
  if (!text || !String(text).trim()) return { ok: false };
  // 全部日语预设：按文本关键词匹配语音包场景 → 播日语 wav；未命中播 ack 通用应答
  // 不做任何实时 TTS 合成（内容对不上且开销大）
  try {
    const tts = await getTtsEdge();
    if (tts) {
      const r = await tts.speak(String(text));
      if (r.ok) return { ok: true, engine: "voicepack", scene: r.scene };
      return { ok: false, error: r.error };
    }
  } catch { /* ignore */ }
  return { ok: false };
});

// 渲染层模型加载完成后，通知主进程显示桌宠窗口（尺寸已固定锁定）
ipcMain.handle("window:fit", async () => {
  if (!win) return { ok: false };
  if (mascotHidden) return { ok: true }; // 面板打开中，不显示桌宠
  const firstShow = !fitReceived;
  fitReceived = true;
  win.showInactive(); // 不抢焦点（避免透明窗口 isFocused 永久 true 导致全屏不隐藏）
  if (!firstShow) return { ok: true }; // 仅首次显示时校正位置，之后不强制拉回（用户已拖动的不要再弹回）
  // show 后延迟强制拉回一次（透明窗口 show 时 DWM 可能调整）
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    const expectX = workArea.x + workArea.width - 220 - 12;
    const expectY = workArea.y + workArea.height - 360 - 12;
    // 若用户在延迟期内已拖动，则不强制复位
    const [cx, cy] = win.getPosition();
    if (Math.abs(cx - expectX) > 2 || Math.abs(cy - expectY) > 2) return;
    win.setBounds({ x: expectX, y: expectY, width: 220, height: 360 });
    win.setMinimumSize(220, 360);
    win.setMaximumSize(220, 360);
  }, 1200);
  return { ok: true };
});

// ---------- 独立面板窗口（学习清单/模拟面试/对话/产出） ----------
function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    // 面板显示时隐藏桌宠（避免遮挡）
    hideMascot();
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  // 面板尺寸：宽 560 适合模拟面试（问题+评分+回答并排），高 720 内容不挤
  // 上限不超过屏幕 90%，小屏自动缩小
  let W = Math.min(560, Math.round(workArea.width * 0.9));
  let H = Math.min(720, Math.round(workArea.height * 0.9));
  // 屏幕居中
  let x = Math.round(workArea.x + (workArea.width - W) / 2);
  let y = Math.round(workArea.y + (workArea.height - H) / 2);
  // 恢复上次保存的面板位置/尺寸（校验在屏内，避免恢复到屏幕外）
  const savedPanel = readWindowState().panel;
  if (savedPanel && Number.isFinite(savedPanel.x) && Number.isFinite(savedPanel.y) &&
      Number.isFinite(savedPanel.width) && Number.isFinite(savedPanel.height) &&
      isOnScreen(savedPanel.x, savedPanel.y, savedPanel.width, savedPanel.height)) {
    x = Math.round(savedPanel.x);
    y = Math.round(savedPanel.y);
    W = Math.round(savedPanel.width);
    H = Math.round(savedPanel.height);
  }
  panelWin = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    minWidth: 420,
    minHeight: 560,
    title: "真白 · 前端秋招助手",
    backgroundColor: "#171322",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--model-path=${path.join(ROOT, "node_modules", "live2d-widget-model-mashiro-zamp", "assets", "model", "Sakurasou", "mashiro", "ryoufuku.model.json")}`,
        `--panel-window=1`,
      ],
    },
  });
  panelWin.loadFile(path.join(__dirname, "renderer", "panel.html"));
  panelWin.webContents.on("console-message", (e, level, message) => {
    console.log(`[panel] ${message}`);
  });
  // 面板位置/尺寸持久化：移动/缩放后防抖保存
  const trackPanelBounds = () => {
    try {
      const [px, py] = panelWin.getPosition();
      const [pw, ph] = panelWin.getSize();
      panelState = { x: px, y: py, width: pw, height: ph };
      scheduleSaveWindowState();
    } catch { /* ignore */ }
  };
  panelWin.on("moved", trackPanelBounds);
  panelWin.on("resized", trackPanelBounds);
  panelWin.on("closed", () => {
    panelWin = null;
    showMascot(); // 面板被关闭 → 恢复桌宠
  });
  // 面板显示时隐藏桌宠（避免遮挡）
  hideMascot();
}

let mascotHidden = false; // 面板打开时桌宠被隐藏（全屏检测跳过恢复）

// 隐藏桌宠（面板打开时调用）——置 mascotHidden 标记，防止全屏检测定时器弹回来
function hideMascot() {
  if (win && !win.isDestroyed()) {
    // 双保险：窗口隐藏 + 强制鼠标穿透（即使未隐藏成功也不挡面板操作）
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch { /* ignore */ }
    if (win.isVisible()) {
      win.hide();
      console.log("[kanban] 面板打开，桌宠隐藏");
    }
  }
  mascotHidden = true;
}

// 恢复桌宠显示（面板关闭/隐藏时调用）
function showMascot() {
  mascotHidden = false;
  if (win && !win.isDestroyed() && !win.isVisible()) {
    win.showInactive(); // 不抢焦点
    console.log("[kanban] 面板关闭，桌宠恢复");
  }
}

// 面板窗口开关（角色点击/托盘触发）
ipcMain.handle("window:toggle-panel", () => {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
    panelWin.hide();
    showMascot(); // 面板关闭 → 恢复桌宠
  } else {
    createPanelWindow();
  }
  return { ok: true };
});

// 鼠标穿透：透明区域不拦截点击，角色区域可交互
// ignore=true → 窗口忽略鼠标事件（forward 让 renderer 仍能收到 mousemove 用于检测）
ipcMain.handle("window:set-ignore", (e, { ignore }) => {
  if (!win || win.isDestroyed()) return { ok: false };
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
  return { ok: true };
});

// 拖拽：用 setBounds 同时指定固定尺寸（setPosition 只给位置会让 DWM 重新计算尺寸导致漂移；
// setBounds 完整指定位置+尺寸，从根源避免透明窗口漂移）
ipcMain.handle("window:move", (e, { x, y }) => {
  if (!win) return { ok: false };
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: 220, height: 360 });
  return { ok: true };
});

// ---------- 全屏检测：全屏应用（游戏/视频）时隐藏桌宠，其余情况保持显示 ----------
// 用 koffi FFI 直调 Win32（毫秒级，替代慢速 PowerShell）
import { detectForegroundSync, getForegroundInfo } from "./foreground.mjs";
import { isDistractingTitle } from "../lib/focus.mjs";

function detectForeground() {
  return new Promise((resolve) => {
    resolve(detectForegroundSync());
  });
}

let panelOpen = false; // 渲染层上报：面板是否打开（打开时强制显示）
ipcMain.handle("window:panel-state", (e, { open }) => {
  panelOpen = !!open;
  return { ok: true };
});

function startDesktopScopeCheck() {
  let checking = false;
  setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    if (checking) return;
    checking = true;
    try {
      const fg = await detectForeground();
      // 面板打开（mascotHidden）：桌宠保持隐藏，全屏检测不干预
      if (mascotHidden) {
        if (win.isVisible()) win.hide(); // 兜底：确保隐藏
        return;
      }
      // 显示条件：非全屏（桌面/普通窗口）或面板打开
      // 注意：不用 isFocused() 豁免——透明窗口焦点状态不可靠（fit 时曾 focus 后永远 true）
      // 用户点击桌宠时它自然成为前台窗口（fg=normal 小窗口），不会误隐藏
      const shouldShow = fg !== "fullscreen";
      if (shouldShow && !win.isVisible()) {
        win.showInactive();
        console.log("[kanban] 显示桌宠（前台:", fg + "）");
      } else if (!shouldShow && win.isVisible()) {
        win.hide();
        console.log("[kanban] 全屏应用，隐藏桌宠");
      }
    } catch (e) {
      console.log("[kanban] 检测异常:", e.message);
    } finally {
      checking = false;
    }
  }, 1000);
}

// ---------- 专注监督（番茄钟）：陪伴 + 分心应用检测 + 气泡/语音提醒 ----------
// 轮询 widget /api/focus/status（每 5 秒）：专注中检测前台窗口标题，命中黑名单 → 记录分心 + 真白提醒
// 状态跃迁：开始 → focus-start 气泡；完成结束 → focus-done 气泡（"监督"核心价值）
const FOCUS_NUDGE_COOLDOWN = 3 * 60 * 1000; // 分心提醒冷却（3 分钟，防骚扰）

let focusBlacklist = [];          // 分心黑名单（从 widget 拉取缓存）
let focusPrevActive = null;       // 上一次专注状态（null=首轮，跳过跃迁判断）
let focusLastNudge = 0;           // 上次分心提醒时间戳
let focusLastNudgeSession = null; // 分心提醒冷却所属会话 id（新会话重置冷却）

// 广播 pet-say 到所有窗口（桌宠 app.js 订阅显示气泡 + 播语音；面板未订阅则忽略）
function petSay(text, scene) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send("pet-say", { text, scene }); } catch { /* ignore */ }
    }
  }
}

async function fetchFocusBlacklist() {
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/focus/blacklist`);
    const j = await res.json();
    if (j?.ok && Array.isArray(j.blacklist)) focusBlacklist = j.blacklist;
  } catch { /* widget 未启动忽略 */ }
}

async function checkFocusSupervision() {
  let status = null;
  try {
    const res = await widgetFetch(`${WIDGET_URL}/api/focus/status`);
    status = await res.json();
  } catch { /* widget 未启动忽略 */ }
  if (!status || status.ok === false) return;

  const active = !!status.active;
  const prev = focusPrevActive;
  focusPrevActive = active;

  // 黑名单懒加载（首次成功拿到后缓存；每 5 分钟刷新一次由独立定时器兜底）
  if (!focusBlacklist.length) await fetchFocusBlacklist();

  // 状态跃迁：开始 → 陪伴气泡；完成结束 → 慰劳气泡
  if (prev === null) return; // 首轮仅记录，避免启动时误触发问候
  if (active && !prev) {
    petSay("集中して。真白も一緒にいるよ。", "focus-start");
  } else if (!active && prev) {
    if (status.lastCompleted) petSay("お疲れさま。よく頑張ったね。", "focus-done");
  }

  if (!active) return;
  // 专注中：检测前台窗口是否命中分心黑名单
  let title = "";
  try { title = getForegroundInfo().title; } catch { /* 检测失败跳过 */ }
  if (!title || !isDistractingTitle(title, focusBlacklist)) return;

  const now = Date.now();
  // 冷却：同一会话内 3 分钟只提醒一次；新会话重置
  if (status.sessionId !== focusLastNudgeSession) {
    focusLastNudgeSession = status.sessionId;
    focusLastNudge = 0;
  }
  if (now - focusLastNudge < FOCUS_NUDGE_COOLDOWN) return;
  focusLastNudge = now;

  // 记录分心 + 真白提醒
  widgetFetch(`${WIDGET_URL}/api/focus/distract`, { method: "POST" }).catch(() => {});
  petSay("集中して。", "focus-nudge");
}

function startFocusSupervision() {
  fetchFocusBlacklist(); // 启动即拉一次黑名单
  setInterval(checkFocusSupervision, 5000);
  setInterval(fetchFocusBlacklist, 5 * 60 * 1000); // 每 5 分钟刷新黑名单（面板改黑名单后生效）
}

// ---------- widget 鉴权：给面板/桌宠对 8899 的请求注入 Bearer token ----------
// 核心逻辑抽到 lib/widget-auth.mjs（纯函数、可单测）：token 轮询 / 注入判断 / fetch 包装 / 健康探测 URL。
// 主进程这里只保留 Electron 相关的 session API 绑定与 token 变量。
let widgetToken = "";
async function loadWidgetToken() {
  const tokenFile = path.join(ROOT, "data", "widget-token.json");
  // widget 冷启动要 15-30s 才写 token 文件 → 持续轮询直到读到（不能 10s 放弃，
  // 否则面板所有请求永远 401，学习清单/复习/对话全部加载不出来）
  widgetToken = await loadTokenFromFile(tokenFile);
  console.log("[kanban] widget token 已加载");
}
function registerWidgetAuth() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (shouldInjectAuth(details.url || "", widgetToken)) {
      details.requestHeaders["Authorization"] = "Bearer " + widgetToken;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

// 主进程 fetch widget 的统一包装：自动附 Bearer token。
// 关键：IPC handler（getData/studyPlan/reviewDue/chat 等）在主进程用 fetch 调 widget，
// 主进程 fetch 不经过 webRequest 注入 → 必须显式带 header，否则全部 401
function widgetFetch(url, opts = {}) {
  return widgetFetchFactory(widgetToken, fetch)(url, opts);
}

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  registerWidgetAuth();
  loadWidgetToken();
  ensureWidgetServer();
  setTimeout(createWindow, 800); // 等 widget 服务起来
  createTray();
  startDesktopScopeCheck();
  startFocusSupervision();
}).catch(() => { /* 单实例锁未获取时提前退出，ready 可能 reject，忽略 */ });

app.on("window-all-closed", (e) => {
  // 看板娘关窗口不退出（托盘常驻）
});
