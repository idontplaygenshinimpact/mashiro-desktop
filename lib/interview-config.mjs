// 模拟面试：共享常量（轮次编排/深度安全阀/面试官风格）
// 纵向拆分第 5 刀：interview-config 域（interview-start 与 interview-session 共用，避免循环 import）

export const MAX_ROUNDS = 12;        // 最多问答轮数（真实面试 45-60 分钟约 10 轮）
export const MAX_DEPTH = 6;         // 追问深度安全阀（正常按回答质量判断不会走到；仅防 LLM 死循环）
// 薄弱点补考轮：固定轮次走完后若优先清单仍有未考察项 → 自动追加（自适应延长，不再"固定 N 轮死板收场"）
export const EXTRA_ROUND = {
  type: "tech", name: "薄弱点补考", rounds: 1,
  desc: "从候选人的薄弱点优先清单继续出题（本场最该补的知识点，不能跳过）；队列出题必须命中 weak_hit。",
};

// ---------- 面试轮次编排（对标 ai-career 成熟模式：项目拷打与八股混合穿插，非串行阶段） ----------
// 真实面试是"项目拷打为主线 + 八股穿插"：面试官围绕简历项目深挖，每 2-3 轮插入 1 道基础题
// 参考 ai-career useInterviewSession.getNextTopicIndex：answeredRounds>=2 且偶数轮时优先基础题
export const ROUND_PLAN = [
  { type: "open", name: "开场与自我介绍", rounds: 1,
    desc: "请候选人自我介绍并简述最熟悉的项目。根据介绍锁定拷打目标。" },
  { type: "project", name: "项目拷打", rounds: 2,
    desc: "锁定简历/自我介绍中的项目深挖：技术选型 trade-off、架构、个人贡献、难点踩坑、量化指标。每轮顺着回答往下追问（为什么/遇到什么问题/边界失败/有没有数据）。" },
  { type: "tech", name: "八股穿插", rounds: 1,
    desc: "插入 1 道基础八股（事件循环/HTTP/React/浏览器原理等，从学习清单/高频考点出），考察原理深度。" },
  { type: "project", name: "项目拷打·回马枪", rounds: 1,
    desc: "回到项目继续深挖另一条线（换个技术点追问，如性能优化/异常处理/扩展性），保持追问链。" },
  { type: "tech", name: "八股与基础", rounds: 1,
    desc: "再插 1 道八股或场景题（考察知识面）。" },
  { type: "coding", name: "手写/场景题", rounds: 2,
    desc: "手写题或场景设计题（防抖节流/深拷贝/Promise 实现/性能优化方案），考察代码能力与工程思维。" },
  { type: "reverse", name: "反问环节", rounds: 1,
    desc: "请候选人提问（团队/技术栈/业务），并给出面试初步反馈。" },
];
// 扁平化为逐轮类型（rounds 展开）
export const ROUND_SEQ = ROUND_PLAN.flatMap((s) => Array.from({ length: s.rounds }, () => s));

export const ROLES = {
  "温和引导型": "耐心引导，给予充分思考时间，回答不完整时先提示再追问，适合首次模拟",
  "压力追问型": "节奏快、追问紧、直击漏洞，模拟大厂真实高压面试，不轻易放过模糊回答",
  "技术深挖型": "围绕技术细节不断深挖底层原理，考察知识边界，追问为什么/怎么做/边界在哪",
};
