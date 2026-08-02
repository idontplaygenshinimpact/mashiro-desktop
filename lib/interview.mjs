// 模拟面试模块（借鉴 ai-career 协议：plan → round → review）
// 面试官角色、五维评分、追问深度控制、复盘报告、薄弱点回流
import { memory } from "./memory.mjs";
import { llmChat, getReplyText, extractJson } from "./llm.mjs";

const MAX_ROUNDS = 6;        // 最多问答轮数
const MAX_DEPTH = 3;         // 同一追问点最大深挖次数（防无限追问）

// 过滤伪知识点：考察维度名（"综合能力"/"考察维度：XXX"）、泛化标签、空值 → null
// 只保留"事件循环"、"React 渲染流程"这类具体知识点名
const PSEUDO_PATTERNS = [
  /考察维度/i, /综合能力/, /表达能力/, /^维度/, /^综合/,
  /^沟通/, /^态度/, /^思维/, /^逻辑/, /面试表现/, /整体表现/,
  /^无$/, /^暂无/, /^none$/i, /^null$/i, /^未/,
];
function cleanWeakTopic(topic) {
  if (!topic) return null;
  const t = String(topic).trim().slice(0, 40);
  if (!t) return null;
  if (t.length > 30) return null; // 太长的多半是句子不是知识点
  for (const p of PSEUDO_PATTERNS) if (p.test(t)) return null;
  return t;
}

const ROLES = {
  "温和引导型": "耐心引导，给予充分思考时间，回答不完整时先提示再追问，适合首次模拟",
  "压力追问型": "节奏快、追问紧、直击漏洞，模拟大厂真实高压面试，不轻易放过模糊回答",
  "技术深挖型": "围绕技术细节不断深挖底层原理，考察知识边界，追问为什么/怎么做/边界在哪",
};

// ---------- LLM 调用（统一客户端，带重试+超时） ----------
async function chat(messages, { maxTokens = 4000, temperature = 0.4 } = {}) {
  const data = await llmChat(messages, { maxTokens, temperature });
  return getReplyText(data);
}

// ---------- 开始面试（参考学习清单 + 最近面经 + 薄弱点） ----------
export async function startInterview({ position, role = "技术深挖型", resume = "", focus = "" }) {
  if (memory.getInterview()) {
    return { error: "已有一场面试进行中，先结束（end_interview）或继续回答", session: memory.getInterview() };
  }
  const profile = memory.getProfileSummary();
  const weak = memory.getTrustedWeakPoints(5);

  // 参考：学习清单（优先考察未完成项）
  let studyPlanText = "";
  try {
    const { getPlan } = await import("./study.mjs");
    const plan = getPlan();
    if (plan?.items?.length) {
      studyPlanText = plan.items
        .filter((i) => !i.done)
        .slice(0, 6)
        .map((i) => `- ${i.topic}（${i.reviewed ? "已复盘" : "待学"}）${i.why ? "：" + i.why.slice(0, 50) : ""}`)
        .join("\n");
    }
  } catch { /* ignore */ }

  // 参考：最近面经产出（高频考点）
  let recentOutputsText = "";
  try {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const outDir = path.join(import.meta.dirname, "..", "output");
    const files = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".md") && !e.name.startsWith("00_")) {
          try { const st = statSync(p); if (st.size > 300 && st.size < 50000) files.push(p); } catch { /* ignore */ }
        }
      }
    };
    walk(outDir);
    files.sort((a, b) => statSync(b).mtime - statSync(a).mtime);
    const latest = files.slice(0, 4);
    const excerpts = latest.map((f) => {
      const c = readFileSync(f, "utf8");
      // 提取题目/结论段落（前 600 字）
      return `【${path.basename(f).slice(0, 40)}】${c.slice(0, 600)}`;
    }).join("\n\n---\n\n");
    if (excerpts.length > 100) recentOutputsText = excerpts;
  } catch { /* ignore */ }

  const prompt = `你是${role}面试官，为"${position}"岗位面试候选人。
面试官风格：${ROLES[role] || ROLES["技术深挖型"]}

候选人画像：${profile}
${weak.length ? `已知薄弱点（优先考察）：${weak.map((w) => `${w.topic}(${w.failCount}次)`).join("、")}` : ""}
${studyPlanText ? `候选人的学习清单（优先从这些未完成知识点出题）：\n${studyPlanText}` : ""}
${focus ? `用户指定本次面试重点方向：${focus}` : ""}
${recentOutputsText ? `最近爬取的面经/题目（从中选取真实高频考点出题，优先用这些素材）：\n${recentOutputsText.slice(0, 4000)}` : ""}
${resume ? `候选人简历：\n${resume.slice(0, 3000)}` : ""}

请生成面试的**第一问**。要求：
1. 优先从【最近面经】里的真实高频考点或【学习清单】未完成项出题（不要只出泛泛八股）
2. 问题要具体、可作答
3. 输出 JSON：
{"question":"问题内容","basis":"为什么问这个（触发依据，注明来自哪篇面经/哪个清单项）","dimension":"考察维度","criteria":"合格回答需覆盖的要点(3-5个)","boundary":"追问不会越界到哪些范围"}`;

  const raw = await chat([
    { role: "system", content: "你是严格专业的面试官，只输出合法 JSON。" },
    { role: "user", content: prompt },
  ], { maxTokens: 1500 });

  const q = extractJson(raw) || { question: "请介绍一下你自己和你最熟悉的项目。", basis: "开场破冰", dimension: "表达与项目", criteria: "STAR 结构、项目亮点、量化成果", boundary: "不涉及未提及的技术" };

  // 初始化会话
  memory.setInterview({
    position, role, resume: resume.slice(0, 3000),
    startedAt: new Date().toISOString(),
    rounds: [],
    current: { question: q.question, basis: q.basis, dimension: q.dimension, criteria: q.criteria, boundary: q.boundary, depth: 0, round: 1 },
    finished: false,
  });

  return {
    ok: true,
    message: `面试开始！我是${role}面试官。`,
    question: q.question,
    basis: q.basis,
    dimension: q.dimension,
    criteria: q.criteria,
    boundary: q.boundary,
    round: 1,
    hint: `回答后我会评分并给出下一问。共 ${MAX_ROUNDS} 轮，随时可说"结束面试"。`,
  };
}

// ---------- 提交回答 → 评分 + 下一问 ----------
export async function submitAnswer(answer) {
  const session = memory.getInterview();
  if (!session) return { error: "没有进行中的面试，先 start_interview" };
  if (session.finished) return { error: "面试已结束，可 start_interview 开始新的" };

  const current = session.current;
  const roundNum = current.round;

  const prompt = `你是${session.role}面试官。面试进行到第 ${roundNum} 轮（共 ${MAX_ROUNDS} 轮）。

本轮问题：${current.question}
考察维度：${current.dimension}
合格标准：${current.criteria}
追问边界：${current.boundary}
候选人回答：${String(answer).slice(0, 3000)}

面试历史：
${session.rounds.map((r, i) => `轮${i + 1}【${r.question.slice(0, 50)}】答：${r.answer.slice(0, 80)} 分：${r.score}`).join("\n")}

请：
1. 给本轮回答五维评分（0-100 每维）：
   - tech：技术准确性
   - expr：表达结构（逻辑/STAR）
   - depth：项目/原理深度
   - edge：异常/边界考虑
   - reflect：复盘意识
2. 一句话点评
3. 决定下一问：
   - 如果回答有漏洞且当前追问深度 < ${MAX_DEPTH}，**深挖追问**（depth+1，针对漏洞继续）
   - 否则**切换新题**（depth 归 0，换考点）
   - 如果已是第 ${MAX_ROUNDS} 轮，返回 finish: true

输出 JSON：
{"scores":{"tech":0,"expr":0,"depth":0,"edge":0,"reflect":0},"comment":"一句话点评","finish":false,"next_question":"下一问问题（finish=true 时为空）","next_basis":"追问依据","next_dimension":"考察维度","next_criteria":"合格标准","next_boundary":"边界","weak_topic":"本轮暴露的薄弱知识点（如有，如'事件循环'）"}`;

  const raw = await chat([
    { role: "system", content: "你是严格专业的面试官，只输出合法 JSON。" },
    { role: "user", content: prompt },
  ], { maxTokens: 2000 });

  const r = extractJson(raw) || {};
  const scores = r.scores || { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0 };
  const total = Math.round((scores.tech + scores.expr + scores.depth + scores.edge + scores.reflect) / 5);

  // 记录本轮
  session.rounds.push({
    question: current.question,
    answer: String(answer).slice(0, 2000),
    scores, total,
    comment: r.comment || "",
    weak_topic: cleanWeakTopic(r.weak_topic) || null, // 本轮暴露的真实薄弱知识点
  });

  // 薄弱点回流（有明确 weak_topic 才记录；考察维度名/伪知识点不记）
  const weakTopic = cleanWeakTopic(r.weak_topic);
  if (weakTopic && total < 60) memory.addWeakPoint(weakTopic, "模拟面试", "agent");

  // 知识点掌握度写回（题目匹配知识点 → 按评分加减分）
  try {
    const { matchKp, recordKp } = await import("./knowledge.mjs");
    const kpId = matchKp(current.question);
    if (kpId) {
      recordKp(kpId, { correct: total >= 60, strong: total >= 80 });
    }
  } catch { /* ignore */ }

  // 推进下一问
  if (r.finish || roundNum >= MAX_ROUNDS) {
    session.finished = true;
    memory.setInterview(session);
    return {
      ok: true, finished: true, round: roundNum,
      scores, total, comment: r.comment,
      message: "面试结束！请调用 end_interview 生成复盘报告。",
    };
  }

  const depth = r.finish ? 0 : (r.next_question && current.depth >= 1 ? Math.min(current.depth + 1, MAX_DEPTH) : (r.next_question ? (r.next_basis === current.basis ? current.depth + 1 : 0) : 0));
  session.current = {
    question: r.next_question || "请继续。",
    basis: r.next_basis || "追问",
    dimension: r.next_dimension || current.dimension,
    criteria: r.next_criteria || current.criteria,
    boundary: r.next_boundary || current.boundary,
    depth: r.next_question && r.next_basis === current.basis ? current.depth + 1 : 0,
    round: roundNum + 1,
  };
  memory.setInterview(session);

  return {
    ok: true, finished: false, round: roundNum,
    scores, total, comment: r.comment,
    question: session.current.question,
    basis: session.current.basis,
    dimension: session.current.dimension,
    criteria: session.current.criteria,
    boundary: session.current.boundary,
  };
}

// ---------- 结束面试 → 复盘报告 ----------
export async function endInterview() {
  const session = memory.getInterview();
  if (!session) return { error: "没有进行中的面试" };
  if (session.rounds.length === 0) {
    memory.clearInterview();
    return { ok: true, report: "还没有回答任何问题，面试未记录。可以重新开始。" };
  }

  const roundsText = session.rounds.map((r, i) =>
    `轮${i + 1}【${r.question.slice(0, 60)}】\n答：${r.answer.slice(0, 200)}\n评分：技术${r.scores.tech}/表达${r.scores.expr}/深度${r.scores.depth}/边界${r.scores.edge}/复盘${r.scores.reflect} 均分${r.total}\n点评：${r.comment}`
  ).join("\n\n");

  const avg = Math.round(session.rounds.reduce((s, r) => s + r.total, 0) / session.rounds.length);
  const dims = ["tech", "expr", "depth", "edge", "reflect"];
  const avgDims = {};
  for (const d of dims) {
    avgDims[d] = Math.round(session.rounds.reduce((s, r) => s + (r.scores[d] || 0), 0) / session.rounds.length);
  }

  const prompt = `你是面试复盘导师。下面是刚才的模拟面试记录（${session.role}面试官，${session.position}岗位，${session.rounds.length} 轮，均分 ${avg}）。

面试记录：
${roundsText}

请生成复盘报告（Markdown）：
## 面试复盘（${session.position}）
### 总体评价
[基于均分和表现，判断当前准备度]
### 具体优势
[引用实际回答中的亮点，2-3 条]
### 具体短板
[引用实际回答中的不足，2-4 条，明确指出哪些知识点薄弱]
### 可执行改进建议
[3-5 条具体行动：学什么、怎么练、优先级]
### 推荐学习方向
[针对薄弱知识点给出具体学习主题和建议顺序]
### 投递建议
[可以投递 / 基本准备好 / 需要继续打磨 / 建议先集中训练，一句话理由]`;

  const report = await chat([
    { role: "system", content: "你是资深前端面试复盘导师，输出 Markdown。" },
    { role: "user", content: prompt },
  ], { maxTokens: 4000, temperature: 0.4 });

  // 记录历史 + 薄弱点回流（低分轮次 → 复习卡片 + 学习清单）
  for (const r of session.rounds) {
    if (r.total < 50) {
      // 只用本轮暴露的真实薄弱知识点（已过滤伪知识点）；没有则不记录
      const weakTopic = cleanWeakTopic(r.weak_topic);
      if (!weakTopic) continue;
      memory.addWeakPoint(weakTopic, "模拟面试", "agent");
      // 自动创建复习卡片（答错的知识点进入间隔复习）
      try {
        const { review } = await import("./review.mjs");
        review.addCard({
          topic: weakTopic,
          question: r.question.slice(0, 200),
          answer: r.answer.slice(0, 300),
          source: "模拟面试",
        });
      } catch { /* ignore */ }
    }
  }

  // 闭环：复盘薄弱知识点 → 追加进学习清单（下次优先学）
  let planAdded = 0;
  try {
    const { addPlanItems } = await import("./study.mjs");
    const weakTopics = memory.getTrustedWeakPoints(3);
    const r = addPlanItems(weakTopics.map((w) => ({
      topic: w.topic,
      why: `模拟面试中暴露（答错/不完整 ${w.failCount} 次），需优先补强`,
      source: "模拟面试",
      verify_question: `请完整回答并讲清原理：${w.topic}`,
    })));
    planAdded = r.added || 0;
  } catch { /* ignore */ }

  memory.saveInterviewHistory({
    date: new Date().toISOString(),
    position: session.position,
    role: session.role,
    rounds: session.rounds.length,
    avg,
    dims: avgDims,
    report: report.slice(0, 4000),
  });
  memory.clearInterview();

  return {
    ok: true, avg, avgDims, report,
    hint: `薄弱点已记录并回流学习清单（新增 ${planAdded} 项），下次生成清单会优先覆盖`,
  };
}
