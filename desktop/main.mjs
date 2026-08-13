// 看板娘 Electron 主进程
// 透明无边框窗口 + 置顶 + 拖拽 + 系统托盘
import { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, exec, spawnSync } from "node:child_process";
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

// 退出时清理：杀 widget 数据服务 + 其拉起的爬虫进程（用户期望"退出桌宠=全部停止"）
function cleanupWidget() {
  try {
    spawnSync(
      "powershell",
      ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match '(widget|discover)\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true, timeout: 15000, stdio: "ignore" }
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

// ---------- 创建透明悬浮窗 ----------
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // 固定窗口尺寸（创建即锁定，绝不做 setSize——透明窗口 setSize 会被系统二次调整导致"长按增大"）
  const W = 220, H = 360;
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
    { label: "立即爬取", click: () => { widgetPost("/api/run-discover", {}).catch(() => {}); } },
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
    const res = await fetch(`${WIDGET_URL}/api/study-detail-stream?id=${encodeURIComponent(id)}`);
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
    const res = await fetch(`${WIDGET_URL}/api/study-append-stream?id=${encodeURIComponent(id)}&question=${encodeURIComponent(question)}`);
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
    const res = await fetch(`${WIDGET_URL}/api/study-consolidate-stream?id=${encodeURIComponent(id)}`);
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
    const res = await fetch(`${WIDGET_URL}/api/study-cluster-stream`, {
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
    spawn("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, detached: true }).unref();
  } catch { /* ignore */ }
  return { ok: true };
});

ipcMain.handle("window:quit", () => app.quit());

// 打开指定文件（用系统默认程序，如 md 编辑器/浏览器）
ipcMain.handle("window:open-file", (e, { filePath }) => {
  if (!filePath) return { ok: false, error: "no path" };
  try {
    shell.openPath(String(filePath));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 打开输出目录（explorer）
ipcMain.handle("window:open-output", () => {
  spawn("explorer", [path.join(ROOT, "output")], { detached: true }).unref();
  return { ok: true };
});

// 语音播放：edge-tts 神经语音（晓伊少女音，真白人设）→ 失败降级系统 TTS
// 语音文本按"真白人设"由 agent 生成后传入
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
  // 优先 edge-tts（神经语音）
  try {
    const tts = await getTtsEdge();
    if (tts) {
      const r = await tts.speak(String(text));
      if (r.ok) return { ok: true, engine: "edge-tts" };
    }
  } catch { /* ignore */ }
  // 降级：系统 TTS（pwsh → powershell）
  try {
    const tmpFile = path.join(app.getPath("temp"), "mashiro-tts.txt");
    writeFileSync(tmpFile, String(text).slice(0, 200), "utf8");
    const ps1 = path.join(__dirname, "speak.ps1");
    const run = (shell) => {
      try {
        spawn(
          shell,
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-TextFile", tmpFile],
          { windowsHide: true, detached: true, stdio: "ignore" }
        ).unref();
      } catch { /* ignore */ }
    };
    try {
      const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { timeout: 3000, windowsHide: true });
      if (probe.status === 0) { run("pwsh"); return { ok: true, engine: "pwsh" }; }
    } catch { /* ignore */ }
    run("powershell");
    return { ok: true, engine: "powershell" };
  } catch { /* ignore */ }
  return { ok: false };
});

// 渲染层模型加载完成后，通知主进程显示桌宠窗口（尺寸已固定锁定）
ipcMain.handle("window:fit", async () => {
  if (!win) return { ok: false };
  if (mascotHidden) return { ok: true }; // 面板打开中，不显示桌宠
  win.showInactive(); // 不抢焦点（避免透明窗口 isFocused 永久 true 导致全屏不隐藏）
  // show 后延迟强制拉回一次（透明窗口 show 时 DWM 可能调整）
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    win.setBounds({
      x: workArea.x + workArea.width - 220 - 12,
      y: workArea.y + workArea.height - 360 - 12,
      width: 220,
      height: 360,
    });
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
  const W = Math.min(560, Math.round(workArea.width * 0.9));
  const H = Math.min(720, Math.round(workArea.height * 0.9));
  // 屏幕居中
  const x = Math.round(workArea.x + (workArea.width - W) / 2);
  const y = Math.round(workArea.y + (workArea.height - H) / 2);
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
