// 真白面板 API 类型声明（Phase 2 §3.5）：preload 桥接的全量签名，renderer 侧 import type 零运行时开销。
// 由 preload.js 的实现驱动；checkJs（tsconfig.desktop.json）校验实现与声明一致。

/** IPC 流事件（与 lib/contracts/sse.mjs 事件 union 对齐的传输形态） */
export interface StreamEvent {
  type: string;
  delta?: string;
  error?: string;
  reply?: string;
  saved?: boolean;
  topic?: string;
  hit?: boolean;
  similarFrom?: { topic: string };
  earlierArchive?: { topic: string };
  clusterName?: string;
  [k: string]: unknown;
}

export interface KanbanApi {
  readonly modelPath: string;
  getData: () => Promise<any>;
  getProgress: () => Promise<any>;
  notify: (title: string, message: string) => Promise<any>;
  chat: (message: string, history?: any[], sessionId?: string) => Promise<any>;
  chatStream: (message: string, history?: any[], onEvent?: (ev: StreamEvent) => void, sessionId?: string) => Promise<any>;
  chatSessions: () => Promise<any>;
  chatMessages: (sessionId: string) => Promise<any>;
  chatSessionDelete: (id: string) => Promise<any>;
  chatHistory: () => Promise<any>;
  studyPlan: () => Promise<any>;
  interviewHistory: () => Promise<any>;
  getStats: () => Promise<any>;
  getObservability: () => Promise<any>;
  patrolConfig: (cfg?: Record<string, unknown>) => Promise<any>;
  patrolRun: () => Promise<any>;
  ragConfig: (cfg?: Record<string, unknown>) => Promise<any>;
  interviewNotes: (topics: string[] | string) => Promise<any>;
  studyDetail: (id: string) => Promise<any>;
  studyDetailStream: (id: string, onChunk: (content: string) => void, opts?: { noSimilar?: boolean }) => Promise<any>;
  studyDetailAppend: (id: string, question: string, onChunk: (content: string) => void, onEvent?: (ev: StreamEvent) => void) => Promise<any>;
  studyConsolidate: (id: string, onChunk: (content: string) => void) => Promise<any>;
  studyCluster: (ids: string[], onChunk: (content: string) => void) => Promise<any>;
  studyGenerate: () => Promise<any>;
  studyCheck: (id: string, done: boolean) => Promise<any>;
  studyReview: () => Promise<any>;
  studyAnswer: (answers: Array<{ id: string; answer: string }>) => Promise<any>;
  invStart: (cfg: { position?: string; role?: string; resume?: string; focus?: string }) => Promise<any>;
  invAnswer: (answer: string) => Promise<any>;
  invEnd: () => Promise<any>;
  invStatus: () => Promise<any>;
  reviewDue: () => Promise<any>;
  reviewSubmit: (id: string, rating: number) => Promise<any>;
  getMastery: () => Promise<any>;
  runDiscover: () => Promise<any>;
  quit: () => Promise<any>;
  restartApp: () => Promise<any>;
  openOutput: () => Promise<any>;
  openFile: (filePath: string) => Promise<any>;
  togglePanel: () => Promise<any>;
  setIgnoreMouse: (ignore: boolean) => Promise<any>;
  speak: (text: string) => Promise<any>;
  playScene: (scene: string) => Promise<any>;
  playLongScene: (scene: string) => Promise<any>;
  playClickShort: () => Promise<any>;
  playClickLong: () => Promise<any>;
  musicPlay: (file: string) => Promise<any>;
  musicStop: () => Promise<any>;
  musicNext: () => Promise<any>;
  musicState: () => Promise<any>;
  musicVolume: (volume: number) => Promise<any>;
  musicAutoplay: (on: boolean) => Promise<any>;
  parseResumeFile: (name: string, data: ArrayBuffer) => Promise<any>;
  parseImportFile: (name: string, data: ArrayBuffer) => Promise<any>;
  speechToText: (audio: ArrayBuffer) => Promise<any>;
  setVoiceEnabled: (on: boolean) => void;
  isVoiceEnabled: () => boolean;
  setGlobalVoice: (enabled: boolean) => Promise<any>;
  onVoiceChanged: (cb: (enabled: boolean) => void) => void;
  setPanelState: (open: boolean) => Promise<any>;
  fitWindow: (w: number, h: number) => Promise<any>;
  moveWindow: (x: number, y: number) => Promise<any>;
  mascotModels: () => Promise<any>;
  mascotSetModel: (modelPath: string) => Promise<any>;
  showMascotMenu: () => Promise<any>;
  onPanelGotoChallenges: (cb: () => void) => void;
  onPanelGotoTab: (cb: (tab: string) => void) => void;
  gotoPanelTab: (tab: string) => Promise<any>;
  onMascotModelChanged: (cb: (data: any) => void) => void;
  onOpenPanel: (cb: () => void) => void;
  onRunDiscover: (cb: () => void) => void;
  onPetSay: (cb: (data: { text: string; scene?: string }) => void) => void;
}

declare global {
  interface Window {
    kanban: KanbanApi;
  }
}

export {};