// 学习清单：复盘（出验证题 + 判分回流）——复引 study-store
// 纵向拆分第 4 刀第二步
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";
import { llmChat, getReplyText, extractJson } from "./llm.mjs";
import { memory } from "./memory.mjs";
import { matchKp, recordKp, getAllPoints } from "./knowledge.mjs";
import { getCareerProfile } from "./career.mjs";
import { sanitizeFilename } from "./study-files.mjs"; // 存档文件名统一（与 routes/study.mjs 同源，防双份实现漂移）
import { smartSlice } from "./text-utils.mjs"; // 技术债 L3：收敛单点
import { loadPlan, savePlan } from "./study-store.mjs";

// ---------- 复盘：出验证题 ----------
export async function startReview() {
  const plan = loadPlan();
  const pending = plan.items.filter((i) => !i.reviewed);
  if (pending.length === 0) {
    return { ok: false, error: "所有知识点都已复盘过，去爬取新内容吧" };
  }
  // 每个未复盘项出 1 道验证题（用存储的 verify_question）
  const questions = pending.map((it) => ({
    id: it.id,
    topic: it.topic,
    question: it.verify_question || `请简述：${it.topic} 的核心要点`,
  }));
  return { ok: true, date: plan.date, questions };
}

// ---------- 复盘：判分 ----------
// sanitizeFilename 从 study-files.mjs 导入（存档文件名统一，防双份实现漂移）
// smartSlice 从 text-utils.mjs 导入（技术债 L3：收敛单点）

export async function answerReview(answers) {
  // answers: [{id, answer}]
  const plan = loadPlan();
  const answered = answers.filter((a) => a.answer && a.answer.trim());
  if (answered.length === 0) return { ok: false, error: "没有提交任何答案" };

  // 加载每条的学习内容（study_notes/{topic}.md 讲解存档）作为判分上下文——复盘考"学过的内容"
  const qa = answered.map((a) => {
    const it = plan.items.find((i) => i.id === a.id);
    let learned = "";
    try {
      const f = path.join(config.outputDir, "study_notes", `${sanitizeFilename(it?.topic || a.id)}.md`);
      if (existsSync(f)) learned = smartSlice(readFileSync(f, "utf8"));
    } catch { /* 无存档不阻塞复盘 */ }
    return {
      id: a.id,
      topic: it?.topic || a.id,
      question: it?.verify_question || "",
      answer: a.answer,
      learned,
    };
  });

  const profile = getCareerProfile();
  const prompt = `你是${profile.roleLabel || "面试官"}。用户回答了以下自我验证题，请逐题评判（对/部分对/错），给出简要点评（1-2 句），并给出参考答案要点。

评判原则：以"【该题学习内容】"中的资料为参考答案基准——用户答出其中核心要点即可判"对"；超出学习资料但正确的回答也算对；明显遗漏核心要点判"部分对"。

${qa.map((q, i) => `题${i + 1}【${q.topic}】${q.question}
用户回答：${q.answer}
${q.learned ? `【该题学习内容】\n${q.learned}\n【学习内容结束】` : "(该题无学习内容存档，按通识知识评判)"}`).join("\n\n")}

只输出 JSON：
{"results":[{"topic":"...","verdict":"对|部分对|错","comment":"点评","reference":"参考答案要点"}]}`;

  const data = await llmChat(
    [
      { role: "system", content: `你是严格但友好的${profile.roleLabel || "面试官"}。只输出合法 JSON。` },
      { role: "user", content: prompt },
    ],
    { maxTokens: 4000, temperature: 0.3 }
  );

  let results = [];
  let parseFailed = false;
  try {
    const parsed = extractJson(getReplyText(data));
    if (!parsed || !Array.isArray(parsed.results)) parseFailed = true; // 解析失败/结构不对 → 判分无效
    else results = parsed.results;
  } catch { parseFailed = true; }

  // 判分失败（修复 S5：此前解析失败 results=[] 仍无条件标记 reviewed + savePlan——
  // 用户答案被静默消费、复盘进度被消耗、错题不回流且无错误信号）
  if (parseFailed) {
    return { ok: false, error: "判分结果解析失败，未标记已复盘（请重试）", results: [] };
  }

  // 标记已复盘（回答过的）
  for (const a of answered) {
    const it = plan.items.find((i) => i.id === a.id);
    if (it) { it.reviewed = true; it.reviewedAt = new Date().toISOString(); }
  }
  savePlan(plan);

  // 复盘回流：错题 → 薄弱点，答对 → 已掌握（记忆模块）
  if (results.length) {
    memory.applyReviewResults(results);
  }

  // 知识点掌握度写回（增强链路，失败不影响复盘主流程）：判分结果 → 按 topic 匹配知识点记分
  // 树内守卫（修复：matchKp 对未命中主题兜底返回动态主题 → 直接写会让 kp_mastery 表被
  // 不可见行污染 + 每次 recordKp 全表重写；与 review.mjs 同款守卫——只写回知识树内的点）
  try {
    for (const r of results) {
      const kpId = matchKp(r.topic); // 只匹配预定义知识点，匹配不到跳过（如"综合能力"等伪知识点）
      if (!kpId) continue;
      if (!getAllPoints().some((p) => p.id === kpId)) continue; // 树外主题（动态伪知识点）不写入掌握度表
      const v = String(r.verdict || "");
      // 对 → correct（答对记分）；部分对/错 → correct=false（部分对按未掌握处理，半对不加分）
      const correct = v.includes("对") && !v.includes("错") && v !== "部分对";
      recordKp(kpId, { correct });
    }
  } catch { /* ignore */ }

  // 复盘错题 → FSRS 复习卡（答错/部分对自动进间隔复习；失败不影响复盘主流程）
  try {
    const { review } = await import("./review.mjs");
    const existing = review.loadCards().cards;
    const seen = new Set(existing.map((c) => `${c.topic}\u0000${c.question}`));
    for (const r of results) {
      const v = String(r.verdict || "");
      if (v !== "错" && v !== "部分对") continue;
      if (!r.topic) continue;
      // 取 verify_question：优先用 qa 快照（提交答案时从 plan 快照的 question），
      // 再兜底 plan.find（修复：原实现只 plan.find，个别环境/时序下找不到条目时
      // question 静默回退成 topic，复习卡卡面退化——CI 偶发 study-llm 断言失败同源）
      const qaItem = qa.find((q) => q.topic === r.topic);
      const planItem = qaItem ? null : plan.items.find((i) => i.topic === r.topic);
      const question = qaItem?.question || planItem?.verify_question || r.topic;
      const answer = String(r.reference || "").slice(0, 500); // 参考答案要点作为卡面答案
      const key = `${r.topic}\u0000${question}`;
      if (seen.has(key)) continue; // 去重：同 topic+question 不重复建卡
      seen.add(key);
      review.addCard({ topic: r.topic, question, answer, source: "复盘错题" });
    }
  } catch { /* 复习卡创建失败不阻塞复盘 */ }

  return { ok: true, results };
}
