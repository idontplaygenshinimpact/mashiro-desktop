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
  interviewHistory: () => ipcRenderer.invoke("widget:interview-history"),
  getStats: () => ipcRenderer.invoke("widget:stats"),
  studyDetail: (id) => ipcRenderer.invoke("widget:study-detail", { id }),
  studyDetailStream: (id, onChunk) => {
    // 订阅 chunk 事件；返回 promise，结束（done/error）时 resolve
    return new Promise((resolve, reject) => {
      const listener = (event, data) => {
        if (typeof data !== "string") return;
        const line = data.startsWith("data:") ? data.slice(5).trim() : data;
        if (!line) return;
        let j;
        try { j = JSON.parse(line); } catch { return; }
        if (j.type === "done") { ipcRenderer.removeListener("study-detail-chunk", listener); resolve({ done: true, saved: j.saved, filePath: j.filePath }); }
        else if (j.type === "error") { ipcRenderer.removeListener("study-detail-chunk", listener); reject(new Error(j.error)); }
        else if (j.type === "delta") onChunk(j.delta);
        else if (j.type === "start") onChunk(""); // 忽略 start
        else if (j.ok) { // JSON 模式（有文件）：直接完成
          ipcRenderer.removeListener("study-detail-chunk", listener);
          onChunk(j.content);
          resolve({ done: true, fromFile: true, topic: j.topic, content: j.content });
        }
      };
      ipcRenderer.on("study-detail-chunk", listener);
      ipcRenderer.invoke("widget:study-detail-stream", { id })
        .then((r) => { if (!r?.ok) { ipcRenderer.removeListener("study-detail-chunk", listener); reject(new Error(r?.error || "流式启动失败")); } })
        .catch((err) => { ipcRenderer.removeListener("study-detail-chunk", listener); reject(err); });
    });
  },
  studyGenerate: () => ipcRenderer.invoke("widget:study-generate"),
  studyCheck: (id, done) => ipcRenderer.invoke("widget:study-check", { id, done }),
  studyReview: () => ipcRenderer.invoke("widget:study-review"),
  studyAnswer: (answers) => ipcRenderer.invoke("widget:study-answer", { answers }),
  // 模拟面试
  invStart: (cfg) => ipcRenderer.invoke("interview:start", cfg),
  invAnswer: (answer) => ipcRenderer.invoke("interview:answer", { answer }),
  invEnd: () => ipcRenderer.invoke("interview:end"),
  // 复习
  reviewDue: () => ipcRenderer.invoke("review:due"),
  reviewSubmit: (id, rating) => ipcRenderer.invoke("review:submit", { id, rating }),
  runDiscover: () => ipcRenderer.invoke("widget:run-discover"),
  quit: () => ipcRenderer.invoke("window:quit"),
  openOutput: () => ipcRenderer.invoke("window:open-output"),
  openFile: (filePath) => ipcRenderer.invoke("window:open-file", { filePath }),
  togglePanel: () => ipcRenderer.invoke("window:toggle-panel"),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke("window:set-ignore", { ignore }),
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
