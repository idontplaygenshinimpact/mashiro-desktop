// preload：安全桥接 IPC
const { contextBridge, ipcRenderer } = require("electron");

let voiceEnabled = true; // 语音开关（渲染层可切换）

// 从启动参数读取模型路径
const modelArg = process.argv.find((a) => a.startsWith("--model-path="));
const modelPath = modelArg ? modelArg.split("=").slice(1).join("=") : "";

// SSE 流封装：订阅 chunk 事件 + 120s 安全超时（防止 invoke 永不 settle 时监听器泄漏）
function streamPromise({ channel, invokeName, args, onChunk, jsonMode = false, extraDone = null }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      ipcRenderer.removeListener(channel, listener);
      if (timer) clearTimeout(timer);
    };
    const finish = (fn, val) => { if (settled) return; settled = true; cleanup(); fn(val); };
    const listener = (event, data) => {
      if (typeof data !== "string") return;
      const line = data.startsWith("data:") ? data.slice(5).trim() : data;
      if (!line) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (j.type === "done") finish(resolve, Object.assign({ done: true, saved: j.saved, filePath: j.filePath }, extraDone ? extraDone(j) : {}));
      else if (j.type === "error") finish(reject, new Error(j.error));
      else if (j.type === "delta") onChunk(j.delta);
      else if (j.type === "start") { /* 忽略 start */ }
      else if (jsonMode && j.ok) { // JSON 模式（有文件）：直接完成
        onChunk(j.content);
        finish(resolve, { done: true, fromFile: true, topic: j.topic, content: j.content });
      }
    };
    timer = setTimeout(() => finish(reject, new Error("流式响应超时（120 秒无最终事件）")), 120000);
    ipcRenderer.on(channel, listener);
    ipcRenderer.invoke(invokeName, args)
      .then((r) => { if (!r?.ok) finish(reject, new Error(r?.error || "流式启动失败")); })
      .catch((err) => finish(reject, err));
  });
}

contextBridge.exposeInMainWorld("kanban", {
  modelPath,
  getData: () => ipcRenderer.invoke("widget:data"),
  getProgress: () => ipcRenderer.invoke("widget:progress"),
  notify: (title, message) => ipcRenderer.invoke("widget:notify", { title, message }),
  chat: (message, history) => ipcRenderer.invoke("widget:chat", { message, history }),
  chatHistory: () => ipcRenderer.invoke("widget:chat-history"),
  studyPlan: () => ipcRenderer.invoke("widget:study-plan"),
  interviewHistory: () => ipcRenderer.invoke("widget:interview-history"),
  getStats: () => ipcRenderer.invoke("widget:stats"),
  getObservability: () => ipcRenderer.invoke("widget:observability"),
  patrolConfig: (cfg) => ipcRenderer.invoke("widget:patrol-config", cfg || {}),
  patrolRun: () => ipcRenderer.invoke("widget:patrol-run"),
  interviewNotes: (topics) => ipcRenderer.invoke("widget:interview-notes", { topics }),
  studyDetail: (id) => ipcRenderer.invoke("widget:study-detail", { id }),
  studyDetailStream: (id, onChunk) => streamPromise({
    channel: "study-detail-chunk", invokeName: "widget:study-detail-stream", args: { id }, onChunk, jsonMode: true,
  }),
  studyDetailAppend: (id, question, onChunk) => streamPromise({
    channel: "study-append-chunk", invokeName: "widget:study-append-stream", args: { id, question }, onChunk,
  }),
  studyConsolidate: (id, onChunk) => streamPromise({
    channel: "study-consolidate-chunk", invokeName: "widget:study-consolidate-stream", args: { id }, onChunk,
  }),
  studyCluster: (ids, onChunk) => streamPromise({
    channel: "study-cluster-chunk", invokeName: "widget:study-cluster-stream", args: { ids }, onChunk,
    extraDone: (j) => ({ clusterName: j.clusterName }),
  }),
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
  getMastery: () => ipcRenderer.invoke("widget:mastery"),
  runDiscover: () => ipcRenderer.invoke("widget:run-discover"),
  quit: () => ipcRenderer.invoke("window:quit"),
  restartApp: () => ipcRenderer.invoke("app:restart"),
  openOutput: () => ipcRenderer.invoke("window:open-output"),
  openFile: (filePath) => ipcRenderer.invoke("window:open-file", { filePath }),
  togglePanel: () => ipcRenderer.invoke("window:toggle-panel"),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke("window:set-ignore", { ignore }),
  speak: (text) => ipcRenderer.invoke("window:speak", { text }),
  playScene: (scene) => ipcRenderer.invoke("window:play-scene", { scene }),
  playLongScene: (scene) => ipcRenderer.invoke("window:play-long-scene", { scene }),
  // 🎵 樱花庄音乐
  musicPlay: (file) => ipcRenderer.invoke("music:play", { file }),
  musicStop: () => ipcRenderer.invoke("music:stop"),
  musicNext: () => ipcRenderer.invoke("music:next"),
  musicState: () => ipcRenderer.invoke("music:state"),
  musicVolume: (volume) => ipcRenderer.invoke("music:volume", { volume }),
  musicAutoplay: (on) => ipcRenderer.invoke("music:autoplay", { on }),
  parseResumeFile: (name, data) => ipcRenderer.invoke("resume:parse-file", { name, data }),
  speechToText: (audio) => ipcRenderer.invoke("speech:transcribe", { audio }),
  setVoiceEnabled: (on) => { voiceEnabled = !!on; },
  isVoiceEnabled: () => voiceEnabled,
  // 全局语音开关：面板切换 → main 广播 voice-changed 到所有窗口（桌宠同步静音）
  setGlobalVoice: (enabled) => ipcRenderer.invoke("voice:set", enabled),
  onVoiceChanged: (cb) => ipcRenderer.on("voice-changed", (e, enabled) => cb(!!enabled)),
  setPanelState: (open) => ipcRenderer.invoke("window:panel-state", { open }),
  fitWindow: (w, h) => ipcRenderer.invoke("window:fit", { w, h }),
  moveWindow: (x, y) => ipcRenderer.invoke("window:move", { x, y }),
  // 桌宠形象（Live2D 模型切换）
  mascotModels: () => ipcRenderer.invoke("mascot:models"),
  mascotSetModel: (modelPath) => ipcRenderer.invoke("mascot:set-model", { path: modelPath }),
  showMascotMenu: () => ipcRenderer.invoke("mascot:menu"),
  onPanelGotoChallenges: (cb) => ipcRenderer.on("panel:goto-challenges", () => cb()),
  onPanelGotoTab: (cb) => ipcRenderer.on("panel:goto-tab", (e, data) => cb(data?.tab)),
  gotoPanelTab: (tab) => ipcRenderer.invoke("panel:goto-tab", { tab }),
  onMascotModelChanged: (cb) => ipcRenderer.on("mascot-model-changed", (e, data) => cb(data)),
  onOpenPanel: (cb) => ipcRenderer.on("open-panel", () => cb()),
  onRunDiscover: (cb) => ipcRenderer.on("run-discover", () => cb()),
  // 专注监督气泡/语音事件（主进程 pet-say 广播 → 桌宠 app.js 订阅）
  onPetSay: (cb) => ipcRenderer.on("pet-say", (e, { text, scene }) => cb({ text, scene })),
});
