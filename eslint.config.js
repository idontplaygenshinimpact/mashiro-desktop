// ESLint flat config（Node ESM 项目）
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// 面板跨文件共享全局（desktop/renderer/panel-*.js 普通 script 互相引用，非模块导出）
const panelGlobals = {
  API_BASE: "writable", // Phase 2：API 基址单一来源（panel-core.js 定义 + 动态解析赋值——P1-4 端口单一来源）
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
  loadTodayBar: "readonly", // 今日任务聚合条（panel-jobs.js 定义，panel-rest.js 轮询调用）
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
  { ignores: ["node_modules/**", "output/**", "data/**", "benchmark/reports/**", "desktop/renderer/app.bundle.js", "desktop/renderer/react-panel.bundle.js", "desktop/renderer/speech-queue.bundle.js", "desktop/renderer/vue-review/review-app.bundle.js", "desktop/renderer/panel-react/dist/**", "desktop/renderer/panel-vue-review/dist/**", "desktop/renderer/assets/**", "desktop/renderer/lib/**", "*.bak", "*.log"] },
  // 全量 TS 升级工单护栏：.ts 必须和 .mjs 一样受 lint 约束
  // （此前 eslint 配置只匹配 **/*.mjs|js → 迁移到 .ts 的文件被静默跳过，随着迁移推进会掏空 lint 覆盖）
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tseslint.parser,
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      ...baseRules,
      // TS 文件关闭 no-undef（typescript-eslint 官方建议）：类型命名空间（NodeJS.Timeout 等）
      // 在 TS 里由类型系统解析，js 版 no-undef 会误报；未定义标识符由 tsc 兜住
      "no-undef": "off",
      "no-unused-vars": "off", // 由 TS 版本接管（否则 interface/type 导入被误报）
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // 迁移期的两类真实缺陷（typo/死代码）——recommended 里的风格类规则（no-explicit-any 等）
      // 与"边界宽松、内部收紧"的迁移约定冲突，不启用
      "@typescript-eslint/no-duplicate-enum-values": "error",
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
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
  // React 版面板（jsx：模块化 + JSX 语法 + 浏览器全局；不装 react 插件，规则用基础集）
  {
    files: ["desktop/renderer/panel-react/src/**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      ...baseRules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
