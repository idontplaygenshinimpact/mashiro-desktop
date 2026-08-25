// ESLint flat config（Node ESM 项目）
import js from "@eslint/js";
import globals from "globals";

// 面板跨文件共享全局（desktop/renderer/panel-*.js 普通 script 互相引用，非模块导出）
const panelGlobals = {
  API_BASE: "readonly", // Phase 2：API 基址单一来源（panel-core.js 定义，全面板共享）
  $: "readonly",
  addChatMsg: "readonly",
  AudioWorkletProcessor: "readonly",
  chatHistory: "writable", // panel-chat 跨文件读写（消息历史缓冲区）
  checkApprovals: "readonly",
  checkAsks: "readonly",
  checkServiceVersion: "readonly",
  DIM_LABELS: "readonly",
  DIRECTION_LABEL: "readonly",
  drawIvRadar: "readonly",
  esc: "readonly",
  loadCareerProfile: "readonly",
  loadChallenges: "readonly",
  loadCrawlData: "readonly",
  loadDashboard: "readonly",
  loadDocs: "readonly",
  loadDocsProject: "readonly",
  loadFocus: "readonly",
  loadIvResume: "readonly",
  loadIvHistory: "readonly",
  loadIvResumeAuto: "readonly",
  loadIvWeakChips: "readonly",
  loadJobs: "readonly",
  loadKbStats: "readonly",
  loadKnowledgeTree: "readonly",
  loadLoop: "readonly",
  loadLoopBar: "readonly",
  loadMascotModels: "readonly",
  loadPlatforms: "readonly",
  loadProfileStatus: "readonly",
  loadReview: "readonly",
  loadRss: "readonly",
  loadSchedule: "readonly",
  loadSettings: "readonly",
  loadStudyPlan: "readonly",
  loadTodo: "readonly",
  loadTreeTemplates: "readonly",
  parseResumeFile: "readonly",
  pickMicDevice: "readonly",
  registerProcessor: "readonly",
  renderMd: "readonly",
  resampleTo16k: "readonly",
  safeUrl: "readonly",
  scoreBarHtml: "readonly",
  startJobsSchedTimer: "readonly",
  stopJobsSchedTimer: "readonly",
  switchTab: "readonly",
  voiceOn: "writable", // panel-voice 跨文件读写（语音开关状态）
};

const baseRules = {
  ...js.configs.recommended.rules,
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
  "no-undef": "error",
  "no-empty": ["error", { allowEmptyCatch: true }], // 允许空 catch（有注释说明的场景）
  "no-constant-condition": ["error", { checkLoops: false }],
};

export default [
  { ignores: ["node_modules/**", "output/**", "data/**", "benchmark/reports/**", "desktop/renderer/app.bundle.js", "desktop/renderer/assets/**", "desktop/renderer/lib/**", "*.bak", "*.log"] },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser, // 面板/渲染层代码
      },
    },
    rules: baseRules,
  },
  // 面板普通 script：无 import/export，顶层函数是跨文件共享全局（用 /* exported */ 声明；
  // 关闭 no-redeclare：globals 声明 + 顶层定义并存是共享全局的预期模式）
  {
    files: ["desktop/renderer/panel-*.js", "desktop/renderer/vad.js", "desktop/renderer/pcm-worklet.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...panelGlobals,
      },
    },
    rules: {
      ...baseRules,
      "no-redeclare": "off",
    },
  },
];
