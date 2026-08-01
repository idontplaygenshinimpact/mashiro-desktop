// 看板娘 Electron 主进程
// 透明无边框窗口 + 置顶 + 拖拽 + 系统托盘
import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, exec } from "node:child_process";
import { writeFileSync } from "node:fs";

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
const WIDGET_URL = "http://127.0.0.1:8899";

// ---------- 启动/复用后端 widget 服务（含守护：死了自动拉起） ----------
function ensureWidgetServer() {
  fetch(`${WIDGET_URL}/api/refresh`)
    .then((r) => { if (!r.ok) throw new Error("bad status"); })
    .catch(() => {
      widgetProc = spawn("node", ["widget.mjs"], {
        cwd: ROOT,
        windowsHide: true,
        stdio: "ignore",
        detached: true,
      });
      widgetProc.unref();
      console.log("[kanban] widget.mjs 已后台拉起");
    });
}

// 持续守护：每 30 秒探测，挂了自动重启
setInterval(ensureWidgetServer, 30000);

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

// ---------- 创建透明悬浮窗 ----------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // 固定窗口尺寸（创建即锁定，绝不做 setSize——透明窗口 setSize 会被系统二次调整导致"长按增大"）
  const W = 240, H = 470;
  console.log(`[kanban] workArea: x=${workArea.x} y=${workArea.y} w=${workArea.width} h=${workArea.height}`);
  const winX = workArea.x + workArea.width - W - 12;
  const winY = workArea.y + workArea.height - H - 12;
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
  win.on("closed", () => { win = null; });
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
    { label: "立即爬取", click: () => { win?.webContents.send("run-discover"); } },
    { label: "打开输出目录", click: () => { spawn("explorer", [path.join(ROOT, "output")], { detached: true }).unref(); } },
    { type: "separator" },
    { label: "退出", click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
}

// ---------- IPC ----------
ipcMain.handle("widget:data", async () => {
  try {
    const res = await fetch(`${WIDGET_URL}/api/widget-data`);
    return await res.json();
  } catch {
    return { error: "widget 服务未启动" };
  }
});

ipcMain.handle("widget:run-discover", async () => {
  try {
    const res = await fetch(`${WIDGET_URL}/api/run-discover`);
    return await res.json();
  } catch {
    return { error: "widget 服务未启动" };
  }
});

ipcMain.handle("widget:progress", async () => {
  try {
    const res = await fetch(`${WIDGET_URL}/api/progress`);
    return await res.json();
  } catch {
    return { status: "idle", message: "widget 服务未启动" };
  }
});

// 对话 + 学习清单转发（widget 服务实现）
async function widgetPost(pathname, body) {
  try {
    const res = await fetch(`${WIDGET_URL}${pathname}`, {
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
    const res = await fetch(`${WIDGET_URL}${pathname}`);
    return await res.json();
  } catch {
    return { error: "widget 服务未启动" };
  }
}
ipcMain.handle("widget:chat", (e, { message, history }) => widgetPost("/api/chat", { message, history }));
ipcMain.handle("widget:study-plan", () => widgetGet("/api/study-plan"));
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
    spawn("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, detached: true }).unref();
  } catch { /* ignore */ }
  return { ok: true };
});

ipcMain.handle("window:quit", () => app.quit());

// 打开输出目录（explorer）
ipcMain.handle("window:open-output", () => {
  spawn("explorer", [path.join(ROOT, "output")], { detached: true }).unref();
  return { ok: true };
});

// 语音播放：pwsh + System.Speech 中文 TTS（脚本文件方式，避免命令行转义）
// 语音文本按"真白人设"由 agent 生成后传入
ipcMain.handle("window:speak", (e, { text }) => {
  if (!text || !String(text).trim()) return { ok: false };
  try {
    // 文本写入临时文件（UTF-8），ps1 读取（避免特殊字符转义问题）
    const tmpFile = path.join(app.getPath("temp"), "mashiro-tts.txt");
    writeFileSync(tmpFile, String(text).slice(0, 200), "utf8");
    spawn(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "speak.ps1"), "-TextFile", tmpFile],
      { windowsHide: true, detached: true, stdio: "ignore" }
    ).unref();
  } catch { /* ignore */ }
  return { ok: true };
});

// 渲染层模型加载完成后，通知主进程显示桌宠窗口（尺寸已固定锁定）
ipcMain.handle("window:fit", async () => {
  if (!win) return { ok: false };
  win.showInactive(); // 不抢焦点（避免透明窗口 isFocused 永久 true 导致全屏不隐藏）
  // show 后延迟强制拉回一次（透明窗口 show 时 DWM 可能调整）
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    win.setBounds({
      x: workArea.x + workArea.width - 240 - 12,
      y: workArea.y + workArea.height - 470 - 12,
      width: 240,
      height: 470,
    });
    win.setMinimumSize(240, 470);
    win.setMaximumSize(240, 470);
  }, 1200);
  return { ok: true };
});

// ---------- 独立面板窗口（学习清单/模拟面试/对话/产出） ----------
function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 440,
    height: 680,
    minWidth: 380,
    minHeight: 520,
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
  panelWin.on("closed", () => { panelWin = null; });
}

// 面板窗口开关（角色点击/托盘触发）
ipcMain.handle("window:toggle-panel", () => {
  if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
    panelWin.hide();
  } else {
    createPanelWindow();
  }
  return { ok: true };
});

// 拖拽：用 setBounds 同时指定固定尺寸（setPosition 只给位置会让 DWM 重新计算尺寸导致漂移；
// setBounds 完整指定位置+尺寸，从根源避免透明窗口漂移）
ipcMain.handle("window:move", (e, { x, y }) => {
  if (!win) return { ok: false };
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: 240, height: 470 });
  return { ok: true };
});
ipcMain.handle("window:stabilize", () => ({ ok: false }));

// ---------- 全屏检测：全屏应用（游戏/视频）时隐藏桌宠，其余情况保持显示 ----------
// 用 koffi FFI 直调 Win32（毫秒级，替代慢速 PowerShell）
import { detectForegroundSync } from "./foreground.mjs";

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
      // 显示条件：非全屏（桌面/普通窗口）或面板打开
      // 注意：不用 isFocused() 豁免——透明窗口焦点状态不可靠（fit 时曾 focus 后永远 true）
      // 用户点击桌宠时它自然成为前台窗口（fg=normal 小窗口），不会误隐藏
      const shouldShow = fg !== "fullscreen" || panelOpen;
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

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  ensureWidgetServer();
  setTimeout(createWindow, 800); // 等 widget 服务起来
  createTray();
  startDesktopScopeCheck();
});

app.on("window-all-closed", (e) => {
  // 看板娘关窗口不退出（托盘常驻）
});
