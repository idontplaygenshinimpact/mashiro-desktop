// preload：安全桥接 IPC
const { contextBridge, ipcRenderer } = require("electron");

let voiceEnabled = true; // 语音开关（渲染层可切换）

// 从启动参数读取模型路径
const modelArg = process.argv.find((a) => a.startsWith("--model-path="));
const modelPath = modelArg ? modelArg.split("=").slice(1).join("=") : "";

contextBridge.exposeInMainWorld("kanban", {
  modelPath,
  getData: () => ipcRenderer.invoke("widget:data"),
  getProgress: () => ipcRenderer.invoke("widget:progress"),
  notify: (title, message) => ipcRenderer.invoke("widget:notify", { title, message }),
  chat: (message, history) => ipcRenderer.invoke("widget:chat", { message, history }),
  studyPlan: () => ipcRenderer.invoke("widget:study-plan"),
  studyGenerate: () => ipcRenderer.invoke("widget:study-generate"),
  studyCheck: (id, done) => ipcRenderer.invoke("widget:study-check", { id, done }),
  studyReview: () => ipcRenderer.invoke("widget:study-review"),
  studyAnswer: (answers) => ipcRenderer.invoke("widget:study-answer", { answers }),
  runDiscover: () => ipcRenderer.invoke("widget:run-discover"),
  quit: () => ipcRenderer.invoke("window:quit"),
  openOutput: () => ipcRenderer.invoke("window:open-output"),
  speak: (text) => ipcRenderer.invoke("window:speak", { text }),
  setVoiceEnabled: (on) => { voiceEnabled = !!on; },
  isVoiceEnabled: () => voiceEnabled,
  setPanelState: (open) => ipcRenderer.invoke("window:panel-state", { open }),
  fitWindow: (w, h) => ipcRenderer.invoke("window:fit", { w, h }),
  moveWindow: (x, y) => ipcRenderer.invoke("window:move", { x, y }),
  stabilizeWindow: (x, y) => ipcRenderer.invoke("window:stabilize", { x, y }),
  onOpenPanel: (cb) => ipcRenderer.on("open-panel", () => cb()),
  onRunDiscover: (cb) => ipcRenderer.on("run-discover", () => cb()),
});
