// 模拟面试：会话编排（submit/end/status）+ 轮次控制 + 报告生成
// 纵向拆分第 5 刀：interview-session 域（<500 行验收）
// 面试官工具轮/chat → interview-agent；STaR 解析/回流 → interview-scoring；
// 优先考察聚合 → interview-focus；轮次常量 → interview-config；会话初始化 → interview-start
import { memory } from "./memory.mjs";
import { llmChat, extractJson, getReplyText } from "./llm.mjs";
import { chat, runInterviewerTool, ivSafeParse, getInterviewerTools } from "./interview-agent.mjs";
import { parseScores, cleanWeakTopic, flowWeakPoint, recordKpFlow, flowLearningEvent, backfillReviewCards, addFailedToPlan } from "./interview-scoring.ts";
import { MAX_ROUNDS, MAX_DEPTH, EXTRA_ROUND, ROUND_PLAN, ROUND_SEQ } from "./interview-config.ts";

// ---------- 提交回答 → 评分 + 下一问 ----------
// 技术债 L7：submitAnswer 208 行拆分为 4 个子函数（prompt 构造/Agent 出题/记录回流/轮次推进）

/** 构造面试官 prompt（轮次编排/薄弱点队列/工具说明/输出格式） */
function buildSubmitPrompt(session, current, roundNum, roundIndex, currentRound, nextRound, progress, depthLimit, pendingWeak, askedWeak, answer) {
  return `你是${session.role}面试官。面试进行到第 ${roundNum} 轮（面试长度动态：计划 ${ROUND_SEQ.length} 轮，**根据表现可提前结束（finish=true）或自动加试**——候选人表现充分/要求结束 → 提前收尾；薄弱点未考完 → 服务端会自动追加补考轮）。
【面试进度】${progress}${session.isExtraRound ? "；🔁 薄弱点补考（进行中）" : ""}
【本轮类型】${currentRound.name}：${currentRound.desc}
${nextRound ? `【衔接】本轮结束后下一轮是「${nextRound.name}」，请在本轮点评后自然衔接（一句话过渡即可）。` : session.isExtraRound ? "【衔接】补考轮内可继续追问/换题；候选人已无明显薄弱点时再结束面试。" : "【衔接】本轮结束后面试结束（反问环节收官）。"}
本轮问题：${current.question}
考察维度：${current.dimension}
合格标准：${current.criteria}
追问边界：${current.boundary}
候选人回答：${String(answer).slice(0, 3000)}

面试历史：
${session.rounds.map((r, i) => `轮${i + 1}【${r.question.slice(0, 50)}】答：${r.answer.slice(0, 80)} 分：${r.score}`).join("\n")}

${pendingWeak.length ? `【薄弱点队列·未考察】除开场/项目拷打/反问轮外（八股、手写、场景题等），本轮问题主题**必须**从队列里选 1 个（若本题主题已是队列项，则在 weak_hit 中原样抄出主题名）；队列项每题至多考一次。
${pendingWeak.map((w) => `- ${w.topic}（答错 ${w.failCount} 次）`).join("\n")}` : ""}
${askedWeak.length ? `【薄弱点队列·已考察（不要再出）】${askedWeak.map((w) => w.topic).join("、")}` : ""}

可调用工具（只读检索，出题前按需使用，每轮至多 2 个；不确定题目/资料时**用工具查**而不是编造）：
- search_challenge(query)：查本地题库（448 道手写/算法题，含题干难度）——handwrite/coding 轮出题**优先**用
- search_knowledge(query)：查本地知识库（候选人学过的讲解/复习卡）——考"学过没学好"的知识点用
- get_weak_points()：查薄弱点清单——八股/手写轮出题优先选薄弱点
（注意：你**看不到**候选人的代码——和真实面试官一样，项目问题只能基于简历里写到的内容提问）

请：
1. 给本轮回答五维评分（0-100 每维）：
   - tech：技术准确性
   - expr：表达结构（逻辑/STAR）
   - depth：项目/原理深度
   - edge：异常/边界考虑
   - reflect：复盘意识
2. 一句话点评
 3. 决定下一问类型 next_kind（**必须三选一，这是服务端轮次编排的唯一依据**）：
    - 判定原则：**根据候选人本轮回答质量判断**，不是机械计数——
      · 回答完整、准确、有深度（关键点全中）→ 已挖透，切 new 或 stage
      · 回答有明显漏洞/含糊/不完整，且本题还有可挖空间 → followup 继续深挖
      · 回答跑题/不会/明显紧张 → 换题（new/stage），不硬追
      · **候选人明确说"忘了/不会/没做过/不清楚" → 必须换题（new 换一道同类型新题），禁止 followup**——
        真实面试官听到"没做过"就换方向考别的，反复拷打同一题只会让人卡死（用户反馈 2026-09）
    - "followup"：就本题继续深挖（**同一轮次内**，不进入新轮次）
    - "new"：本轮内换一道**同类型**新题（深度归 0，仍是本轮）
    - "stage"：本轮完成 → 进入下一阶段（下一轮「${nextRound ? nextRound.name : "结束"}」的第一问）
    防死循环兜底：深度达到 ${depthLimit} 后禁止 followup——此时请用 **new 同类型换题**继续考察同一知识点（不要 stage 静默换阶段）；项目拷打轮深度上限更宽（${MAX_DEPTH + 3}）
 4. 候选人表现充分/时间紧张/候选人主动要求结束 → **finish=true 提前结束面试**（不用走完全部轮次）
输出 JSON：
{"scores":{"tech":0,"expr":0,"depth":0,"edge":0,"reflect":0},"comment":"一句话点评","finish":false,"next_kind":"followup|new|stage","next_question":"下一问问题（finish=true 时为空）","next_basis":"追问依据","next_dimension":"考察维度","next_criteria":"合格标准","next_boundary":"边界","weak_topic":"本轮暴露的薄弱知识点（如有，如'事件循环'）","weak_hit":"本轮问题主题命中的薄弱点队列项（从队列原样抄主题名，非队列出题则为空）"}`;
}

/** Agent 化出题（两段式）：决策轮可检索项目资源（题库/档案/知识库/薄弱点）→ 出题轮
 * LLM 不调用工具时退化为单次出题（兼容旧行为）；工具失败只注入错误，不影响出题
 * 工具轮打满后**强制收口**（toolChoice:"none"）——修复真实事故（2026-09）：模型连续 4 次只调工具、
 * 永远不出 JSON → raw 空 → 本轮 0 分 + 兜底"请继续"，面试官连续 7 轮卡在同一题空转
 * 返回 { raw, msgs }：raw = 出题 JSON 文本；msgs = 本轮完整消息（含 tool 结果——供 session.messages 累积） */
const MAX_TOOL_ROUNDS = 2; // 每轮工具检索轮数上限（prompt 约定"每轮至多 2 个"）；之后禁止再调工具，必须出 JSON
async function askInterviewer(prompt, messages = []) {
  const msgs = [
    { role: "system", content: "你是严格专业的面试官。每轮可调用工具检索真实资料（题库/项目档案/知识库/薄弱点/复习卡/学习计划/面经产出）——查完立即调整策略，再输出面试官 JSON。输出 JSON 时不再调用工具。方向自主编排（开场后从方向池选：项目拷打/八股/手写场景/反问——不按固定序列）。next_question 必填（finish=false 时禁止空）。" },
    ...messages,
    { role: "user", content: prompt },
  ];
  try {
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      const res = await llmChat(msgs, { maxTokens: 3000, temperature: 0.3, tools: getInterviewerTools(), toolChoice: "auto" });
      const msg = res?.choices?.[0]?.message;
      if (msg?.tool_calls?.length) {
        msgs.push(msg);
        for (const tc of msg.tool_calls.slice(0, 2)) {
          const tArgs = ivSafeParse(tc.function?.arguments);
          const tResult = await runInterviewerTool(tc.function?.name, tArgs);
          msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(tResult).slice(0, 4096) });
        }
        continue;
      }
      const text = getReplyText(res);
      if (extractJson(text)) return { raw: text, msgs };
      break; // 有回复但不是可解析 JSON → 走下面的强制收口（不把空 raw 交给调用方）
    }
    // 强制收口①：已有工具结果，禁止再调工具直接出 JSON
    const forced = await llmChat(
      [...msgs, { role: "system", content: "工具检索已结束（本轮工具调用达上限）：现在**禁止**再调用工具，直接输出面试官 JSON（五维评分 + 下一问）。" }],
      { maxTokens: 3000, temperature: 0.3, tools: getInterviewerTools(), toolChoice: "none" },
    );
    const forcedText = getReplyText(forced);
    if (extractJson(forcedText)) return { raw: forcedText, msgs };
    // 强制收口②：后端不支持 tool_choice / 仍不给 JSON → 无工具纯对话兜底（不传 tools，走已注入的 llmChat）
    const fallback = await llmChat([...msgs, { role: "user", content: "请直接输出面试官 JSON（scores/comment/next_kind/next_question 等字段），不要调用任何工具。" }], { maxTokens: 2000, temperature: 0.3 });
    return { raw: getReplyText(fallback), msgs };
  } catch (e) {
    // 工具轮异常不阻塞出题：退化为单次调用（面试是核心流程，不能被检索失败拖垮）
    console.warn(`[interview] 面试官工具轮失败，退化单次出题: ${String(e?.message || e).slice(0, 120)}`);
    const res = await chat([...msgs], { maxTokens: 2000 });
    return { raw: getReplyText(/** @type {any} */ (res)), msgs };
  }
}

/** 记录本轮 + 薄弱点回流（学习事件流/薄弱点/掌握度——失败不影响面试） */
async function recordRound(session, current, answer, r, scores, total, weakQueue) {
  const weakHitTopic = cleanWeakTopic(r.weak_hit);
  const hitItem = weakHitTopic ? weakQueue.find((w) => !w.asked && w.topic === weakHitTopic) : null;
  if (hitItem) hitItem.asked = true;
  session.rounds.push({
    question: current.question,
    answer: String(answer).slice(0, 2000),
    scores, total,
    comment: r.comment || "",
    weak_topic: cleanWeakTopic(r.weak_topic) || null, // 本轮暴露的真实薄弱知识点
  });
  await flowLearningEvent({ weakTopic: r.weak_topic, question: current.question, total });
  flowWeakPoint({ weakTopic: cleanWeakTopic(r.weak_topic), total, question: current.question });
  await recordKpFlow(current.question, total);
  return { hitItem, weakHitTopic };
}

/** 候选人是否明确放弃本题（"忘了/不会/没做过"）——放弃就不再拷打同一题，换题继续考
 * 只看短回答（≤120 字）：长回答里出现"不知道"多半是展开论述中的转折，不当作放弃 */
const GIVE_UP_RE = /(忘了|忘记了|想不起来|不记得|记不清|没记住|不会|不太会|答不上来|没做过|没写过|没接触过|没用过|不清楚|不了解|不知道|没有思路|没思路|想不出|跳过|放弃|略过)/;
export function isGiveUpAnswer(answer) {
  const a = String(answer || "").replace(/\s+/g, "");
  if (!a) return true;
  return a.length <= 120 && GIVE_UP_RE.test(a);
}

/** 推进轮次（next_kind 三态 + 服务端质量兜底 + 动态加试）→ 返回给面板的下一问对象 */
function advanceRound(session, r, scores, total, roundNum, roundIndex, currentRound, hitItem, gaveUp = false) {
  const nextRoundIndex = roundIndex + 1;
  // 轮数动态化（用户反馈：固定 9 轮不合理，回答质量高应继续问）：
  //   · 固定轮次（ROUND_SEQ）走完后不再直接结束——
  //     薄弱点队列未考完 或 近期回答质量高（近 3 轮均分 ≥55）→ 自动进入「动态加试轮」继续考
  //   · 加试轮内：质量持续在线 → 继续；质量回落 / LLM finish / 达到 MAX_ROUNDS → 结束
  const seqExhausted = nextRoundIndex >= ROUND_SEQ.length;
  const recent = session.rounds.slice(-3);
  const recentAvg = recent.length ? Math.round(recent.reduce((s, r) => s + (r.total || 0), 0) / recent.length) : 0;
  const weakLeft = (session.weakQueue || []).some((w) => !w.asked);
  const extendWorthy = seqExhausted && roundNum < MAX_ROUNDS && (weakLeft || recentAvg >= 55);
  if (r.finish || roundNum >= MAX_ROUNDS || (seqExhausted && !extendWorthy)) {
    session.finished = true;
    session.isCompleted = true;
    session.isAdvancing = false;
    memory.setInterview(session);
    return {
      ok: true, finished: true, round: roundNum,
      scores, total, comment: r.comment,
      weakHit: !!hitItem, weakTopic: hitItem?.topic || null,
      message: "面试结束！请调用 end_interview 生成复盘报告。",
    };
  }
  // 轮次编排（next_kind 三态，语义与 prompt 一致）：
  //   followup = 就本题继续深挖（不推进轮次，depth+1）
  //   new      = 本轮内换一道同类型新题（不推进轮次，depth 归 0，round 不变）——修复：原实现把 new 当推进轮次，
  //              与 prompt 告诉 LLM 的语义（"仍是本轮"）断裂 → 同类型新题被编排进下一轮型、计划轮次被吞
  //   stage    = 本轮完成 → 进入下一阶段（推进轮次）
  // 未知/缺失 next_kind → 按 new（本轮内换题）保守处理（修复：原实现静默按 stage 推进 → LLM 脏输出吞计划轮次）
  // 质量服务端兜底（Bug#5 修复）：next_kind 不再 100% 信任 LLM——
  //   · 候选人**明确放弃**（"忘了/不会/没做过"）→ 强制换题 new（用户反馈 2026-09：明确说忘了还被
  //     同一题连续拷打 7 轮；真实面试官听到"没做过"会换方向考别的），不硬追
  //   · total < 50（答错但没放弃）→ 强制 followup（就本题深挖，深度上限内），不让 LLM 轻易放行
  //     （仅 open/tech/project 轮适用；手写轮答错换题重练、反问轮不追问）
  //   · total >= 75（高质量）→ 禁止 followup（已挖透，切 new/stage），不让 LLM 无意义纠缠
  const current = session.current;
  const qualityRound = currentRound.type === "open" || currentRound.type === "tech" || currentRound.type === "project";
  let kind = r.next_kind === "followup" ? "followup" : (r.next_kind === "stage" ? "stage" : "new");
  if (gaveUp) {
    kind = "new"; // 明确放弃 → 换一道同类型新题（手写轮也一样：换题重练，不重复同一道）
  } else if (total < 50 && kind !== "followup" && qualityRound && current.depth < MAX_DEPTH - 1) {
    kind = "followup"; // 答错 → 强制追问（服务端兜底，不依赖 LLM 自觉）
  } else if (total >= 75 && kind === "followup") {
    kind = "new"; // 答得好 → 不再追问（服务端兜底：高质量还追问是浪费轮次）
  }
  const followup = kind === "followup" && current.depth < MAX_DEPTH; // 追问：同轮深挖（深度上限硬约束）
  const sameRound = kind === "new"; // 本轮内换题（不推进轮次）
  const depth = (followup || sameRound) ? (followup ? current.depth + 1 : 0) : 0;
  if (!followup && !sameRound) {
    session.roundIndex = nextRoundIndex; // 仅 stage 推进轮次（追问/换题都不消耗轮次）
    // 六态推进（Bug#10 修复：原实现 isPreparing 全程 true，UI 阶段无过渡）
    session.isPreparing = false;
    session.isAdvancing = true;
  } else {
    // 追问/换题仍处于进行中
    session.isPreparing = false;
    session.isAdvancing = true;
  }
  session.current = {
    // 模拟面试 agent 化工单任务 5：next_question 空 → 兜底换题/追问（不再"请继续"）。
    // 追问兜底沿用本题；换题（含候选人放弃后的换题）兜底**不能重复原题**——引导到别的知识点
    question: r.next_question || (kind === "followup"
      ? `请继续深入讲讲「${current.question.slice(0, 40)}」的${current.dimension || "技术"}方面——结合你的实际经验展开。`
      : gaveUp
        ? "没关系，这题先跳过——换个方向：讲讲你简历里最有把握的一个技术点（做了什么、为什么这么做、结果如何）。"
        : `换一道${currentRound.name}的题：结合你的实际经验，讲讲你在${current.dimension || "这个方向"}上踩过的一个坑和解决过程。`),
    basis: r.next_basis || "追问",
    dimension: r.next_dimension || current.dimension,
    criteria: r.next_criteria || current.criteria,
    boundary: r.next_boundary || current.boundary,
    depth,
    round: (followup || sameRound) ? roundNum : roundNum + 1, // 追问/换题不增加"第几轮"
  };
  memory.setInterview(session);
  // 下一问所属轮型 → 决定作答形态（coding 轮给代码编辑器；追问/换题沿用本轮类型）
  const nextRoundObj = (followup || sameRound) ? currentRound : (session.isExtraRound ? EXTRA_ROUND : (ROUND_SEQ[nextRoundIndex] || currentRound));
  return {
    ok: true, finished: false, round: session.current.round, // 下一问的轮号（面板用它配 question 展示；修复 off-by-one：原返回当前回答轮号）
    stage: ROUND_SEQ[nextRoundIndex]?.name, // 下一轮类型（面板展示用）
    roundType: currentRound.name,            // 本轮类型
    nextRoundType: nextRoundObj?.name || "", // 下一问所属轮型（面板展示用）
    answerMode: nextRoundObj?.type === "coding" ? "code" : "text", // 作答形态（code = 手写/代码轮）
    gaveUp,                                  // 本轮是否明确放弃（面板可提示"已换题"）
    scores, total, comment: r.comment,
    weakHit: !!hitItem, weakTopic: hitItem?.topic || null, // 🎯 薄弱点队列命中
    depth,                                        // 下一问的追问深度（>0 = 追问链）
    question: session.current.question,
    basis: session.current.basis,
    dimension: session.current.dimension,
    criteria: session.current.criteria,
    boundary: session.current.boundary,
  };
}

/**
 * 面试会话形状（memory.getInterview() 返回——memory.ts 的 InterviewSession 只声明治理字段，
 * 完整业务形状由本文件写入，故在边界断言；字段缺失时调用方以 || 兜底，与历史行为一致）
 * @typedef {{
 *   finished?: boolean,
 *   position?: unknown,
 *   role?: unknown,
 *   current?: { round?: unknown, question?: unknown, basis?: unknown, dimension?: unknown, criteria?: unknown, boundary?: unknown, depth?: unknown },
 *   rounds?: Array<{ question?: string, answer?: string, comment?: unknown, total?: number, scores?: Record<string, unknown> }>,
 *   messages?: Array<{ role: string, content: string }>,
 *   weakQueue?: Array<{ topic?: unknown, failCount?: unknown, reason?: unknown, asked?: unknown }>,
 *   roundIndex?: unknown,
 *   isExtraRound?: unknown,
 *   isGeneratingReview?: unknown,
 *   [k: string]: unknown
 * }} InterviewSessionShape
 */

export async function submitAnswer(answer) {
  const session = /** @type {InterviewSessionShape} */ (memory.getInterview());
  if (!session) return { error: "没有进行中的面试，先 start_interview" };
  if (session.finished) return { error: "面试已结束，可 start_interview 开始新的" };
  // 架构 P1-1：idle 超时（30 分钟无活动）→ 自动失效，需重新开始
  if (memory.isInterviewIdle()) {
    memory.clearInterview();
    return { error: "面试会话已超时（30 分钟无活动），已自动结束——请重新开始一场面试" };
  }

  const current = session.current;
  const roundNum = current.round;

  // 薄弱点队列：技术轮优先从未考察项出题；命中后标记 asked（本场不再重复）
  const weakQueue = session.weakQueue || [];
  const pendingWeak = weakQueue.filter((w) => !w.asked);
  const askedWeak = weakQueue.filter((w) => w.asked);

  // 轮次编排：当前轮类型 + 进度 + 下一轮衔接
  // 补考模式（isExtraRound）：固定轮次走完后薄弱点队列还有未考察项 → 追加"薄弱点补考"轮
  const roundIndex = Number(session.roundIndex) || 0;
  const currentRound = session.isExtraRound ? EXTRA_ROUND : ROUND_SEQ[Math.min(roundIndex, ROUND_SEQ.length - 1)];
  const nextRound = session.isExtraRound ? null : (ROUND_SEQ[roundIndex + 1] || null);
  const progress = ROUND_PLAN.map((s) => {
    const startIdx = ROUND_SEQ.indexOf(s);
    const doneCount = Math.min(Math.max(0, roundIndex - startIdx), s.rounds);
    return `${s.name}（${doneCount}/${s.rounds}）${doneCount >= s.rounds ? "✅" : roundIndex >= startIdx ? "→" : ""}`;
  }).join("；");
  const depthLimit = currentRound.type === "project" ? MAX_DEPTH + 3 : MAX_DEPTH; // 项目拷打可挖更深

  const prompt = buildSubmitPrompt(session, current, roundNum, roundIndex, currentRound, nextRound, progress, depthLimit, pendingWeak, askedWeak, answer);
  const { raw, msgs } = await askInterviewer(prompt, session.messages || []);
  // 架构 P1-1：乐观并发写保护——LLM 调用（几十秒）期间会话被并发路径（agent 工具 withRetry vs widget lane）替换 → 拒绝写入防覆盖
  if (memory.getInterview() !== session) {
    return { error: "面试会话已被并发修改（另一场面试已开始），本次回答未记录——请重新操作", concurrent: true };
  }
  // 模拟面试 agent 化工单任务 2：messages 累积（真对话状态——不每轮重构造 prompt）
  // 上下文管理：超长时压缩（保留最近 20 条 + 系统规则——防塞爆）
  session.messages = msgs.length > 24 ? msgs.slice(-20) : msgs;

  const parsed = extractJson(raw);
  // 出题轮彻底失败（工具轮打满 + 强制收口也没拿到 JSON / 后端异常）→ 不写"0 分空转轮"，
  // 让用户重发本轮回答。修复真实事故：此前 raw 空 → r={} → total=0 + 兜底"请继续"，
  // 面试官连续多轮卡在同一题、评分全是 0，用户以为程序卡死。
  if (!parsed || typeof parsed !== "object") {
    return { error: "面试官本轮没有返回可用的评分与下一问（LLM 输出不可解析）——请重发一次你的回答", retry: true };
  }
  const r = parsed;
  // 五维评分解析（B2 校验在 interview-scoring.parseScores：isFinite + clamp，缺维度不 NaN）
  const { scores, total } = parseScores(r.scores);

  // 记录本轮 + 薄弱点回流
  const { hitItem } = await recordRound(session, current, answer, r, scores, total, weakQueue);

  // 推进轮次（next_kind 三态 + 服务端质量兜底 + 动态加试）；gaveUp = 候选人明确放弃本题
  return advanceRound(session, r, scores, total, roundNum, roundIndex, currentRound, hitItem, isGiveUpAnswer(answer));
}

// ---------- 结束面试 → 复盘报告 ----------
export async function endInterview() {
  const session = /** @type {InterviewSessionShape} */ (memory.getInterview());
  if (!session) return { error: "没有进行中的面试" };
  // 架构 P1-1：idle 超时 → 直接清理并提示（不生成复盘——会话已失效）
  if (memory.isInterviewIdle()) {
    memory.clearInterview();
    return { ok: true, report: "面试会话已超时（30 分钟无活动），已自动结束——未生成复盘。可以重新开始。" };
  }
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
    avgDims[d] = Math.round(session.rounds.reduce((s, r) => s + Number(r.scores[d] || 0), 0) / session.rounds.length);
  }

  // 薄弱点覆盖统计（复盘报告展示：本场考了多少个已知薄弱点）
  const weakQueue = session.weakQueue || [];
  const weakCovered = weakQueue.filter((w) => w.asked).map((w) => w.topic);
  const weakTotal = weakQueue.length;

  // 六态：进入复盘报告生成阶段（Bug#10 修复：原实现 isGeneratingReview 从未置 true）
  try {
    session.isGeneratingReview = true;
    memory.setInterview(session);
  } catch { /* ignore */ }

  const prompt = `你是面试复盘导师。下面是刚才的模拟面试记录（${session.role}面试官，${session.position}岗位，${session.rounds.length} 轮，均分 ${avg}）。

面试记录：
${roundsText}
${weakTotal ? `本场已知薄弱点覆盖：已考察 ${weakCovered.length}/${weakTotal}（${weakCovered.join("、") || "无"}）——请针对未覆盖的薄弱点给出补强建议。` : ""}

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

  let reviewerRole = "资深面试复盘导师";
  try {
    const { getCareerProfile } = await import("./career.mjs");
    reviewerRole = getCareerProfile().roleLabel || reviewerRole;
  } catch { /* 画像不可用用默认 */ }
  let report;
  try {
    report = await chat([
      { role: "system", content: `你是${reviewerRole}，输出 Markdown。` },
      { role: "user", content: prompt },
    ], { maxTokens: 4000, temperature: 0.4, timeout: 120000 });
    // timeout 显式 120s：报告是 4000 tokens 长文，曾因 llm.mjs 非流式 20s 默认超时被 abort
    // （用户点"结束面试"反复报 This operation was aborted，会话卡在 isGeneratingReview）
  } catch (e) {
    // 生成失败：复位"生成中"标记，允许用户重试（曾泄漏导致会话状态永久卡死）
    try {
      session.isGeneratingReview = false;
      memory.setInterview(session);
    } catch { /* ignore */ }
    throw e;
  }

  // 薄弱点已由 submitAnswer 实时回流（total<60 即 addWeakPoint，含复习卡），
  // 此处不再重复 addWeakPoint——否则同一轮错题 failCount 双记（修复）
  // 复习卡 answer 回填：submit 时建的卡 answer 为空（当时无候选人回答），
  // end 时用候选人回答回填（addCard 对已有卡更新 answer，不重复建卡）
  await backfillReviewCards(session);

  // 闭环：复盘薄弱知识点 → 追加进学习清单（下次优先学）
  const planAdded = await addFailedToPlan(session);

  memory.saveInterviewHistory({
    date: new Date().toISOString(),
    position: session.position == null ? null : String(session.position),
    role: session.role == null ? null : String(session.role),
    rounds: session.rounds.length,
    avg,
    dims: avgDims,
    report: report.slice(0, 4000),
  });
  memory.clearInterview();
  // 场景收尾（Phase P1）：面试结束 → 回默认场景（技能装配还原）
  try {
    const { resetScenario } = await import("./scenarios.ts");
    resetScenario();
  } catch { /* 场景收尾失败不影响面试主流程 */ }

  return {
    ok: true, avg, avgDims, report,
    weakCovered: weakCovered.length, weakTotal, weakCoveredTopics: weakCovered,
    hint: `薄弱点已记录并回流学习清单（新增 ${planAdded} 项），下次生成清单会优先覆盖`,
  };
}

// ---------- 进行中会话状态（面板"继续上一场面试"入口：关面板/杀进程后回来能续，不用重开） ----------
export function getInterviewStatus() {
  // 会话由 interview-session 定义形状——在边界断言（memory.ts 的 InterviewSession 只声明治理字段）
  const s = /** @type {InterviewSessionShape} */ (memory.getInterview());
  if (!s || s.finished) return { ok: true, active: false };
  // 架构 P1-1：idle 超时 → 视为无会话（面板"继续上一场"入口不再显示过期会话）
  if (memory.isInterviewIdle()) {
    memory.clearInterview();
    return { ok: true, active: false, expired: true };
  }
  // 累计已评分轮次（恢复前端全场均分展示）
  const rounds = s.rounds || [];
  const sum = { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0 };
  for (const r of rounds) {
    for (const k of ["tech", "expr", "depth", "edge", "reflect"]) sum[k] += Number(r.scores?.[k]) || 0;
    sum.total += Number(r.total) || 0;
  }
  const cur = s.current || {};
  const roundIndex = Number(s.roundIndex) || 0;
  const curRound = s.isExtraRound ? EXTRA_ROUND : ROUND_SEQ[Math.min(roundIndex, ROUND_SEQ.length - 1)];
  return {
    ok: true, active: true,
    round: Number(cur.round) || 1,
    roundType: curRound?.name || "问答",
    answerMode: curRound?.type === "coding" ? "code" : "text", // 续场恢复作答形态（手写轮给代码编辑器）
    question: String(cur.question || ""),
    basis: String(cur.basis || ""),
    dimension: String(cur.dimension || ""),
    criteria: String(cur.criteria || ""),
    boundary: String(cur.boundary || ""),
    depth: Number(cur.depth) || 0,
    totalRounds: ROUND_SEQ.length,
    roundsCount: rounds.length,
    weakQueue: (s.weakQueue || []).map((w) => ({ topic: w.topic, failCount: w.failCount, reason: w.reason || "" })),
    scoreSum: sum,
  };
}
