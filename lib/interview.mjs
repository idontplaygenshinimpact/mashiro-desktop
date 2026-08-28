// 模拟面试模块（借鉴 ai-career 协议：plan → round → review）
// 面试官角色、五维评分、追问深度控制、复盘报告、薄弱点回流
// 纵向拆分第 5 刀：本文件降为桶 re-export（引用方 import 路径不变，零改动）
// - 会话编排/状态/报告：lib/interview-session.mjs
// - 面试官工具轮/chat：lib/interview-agent.mjs
// - STaR 解析/回流：lib/interview-scoring.mjs
// - 优先考察聚合：lib/interview-focus.mjs
export { startInterview } from "./interview-start.mjs";
export { submitAnswer, endInterview, getInterviewStatus } from "./interview-session.mjs";
export { buildInterviewFocus } from "./interview-focus.mjs";
