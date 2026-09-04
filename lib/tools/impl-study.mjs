// 工具实现组：学习清单/复习卡/学习计划（纵向拆分第 3 刀）
// toolGetStudyPlan / toolAddStudyItems / toolCreateReviewCard /
// toolCreateLearningPlan / toolGetLearningPlanStatus / toolRecordLearningProgress
// 全部动态 import 业务模块（保持 impl-* 与 schemas 名字耦合现状）

/** 对话 → 学习清单反哺：把知识点加入清单 + 自动挂学习任务（todo 面板可见进度）
 * 闭环：用户说"想学 X/提升 Y" → 清单写入 + todo 任务，学习进度面板可见
 * @returns {Promise<{items: Array<{topic: string, done: boolean, reviewed: boolean, why?: string}>, hint: string}|{error: string}>} 清单条目
 */
export async function toolGetStudyPlan() {
  try {
    const { getPlan } = await import("../study.mjs");
    const plan = getPlan();
    const items = (plan.items || []).map((i) => ({
      topic: i.topic,
      done: !!i.done,
      reviewed: !!i.reviewed,
      why: i.why,
    }));
    return { items, hint: "面试前可优先考察未完成项" };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 添加学习清单条目（自动挂 todo 学习任务）
 * @param {{items?: Array<{topic: string, why?: string, verify_question?: string, level?: "必会"|"进阶"|"拓展", group?: string}>}} args 条目列表
 * @returns {Promise<{ok: boolean, added?: number, topics?: string[], todoItems?: any, hint?: string}|{error: string}>} 添加结果
 */
export async function toolAddStudyItems({ items }) {
  try {
    const { addPlanItems } = await import("../study.mjs");
    const clean = (items || [])
      .map((it) => ({
        topic: String(it?.topic || "").trim(),
        why: String(it?.why || "").trim() || "对话中用户提出想学",
        verify_question: String(it?.verify_question || "").trim(),
        level: ["必会", "进阶", "拓展"].includes(it?.level) ? it.level : "必会",
        group: String(it?.group || "").trim() || undefined,
        fromInterview: false, // 对话添加非面试来源
      }))
      .filter((it) => it.topic);
    if (!clean.length) return { ok: false, error: "没有有效的知识点（topic 必填）" };
    const r = addPlanItems(clean);
    // 自动挂学习任务（todo 面板可见进度；与已有任务按内容去重合并）
    let todo = null;
    try {
      const { initTodo } = await import("../todo.mjs");
      const todoItems = clean.map((it) => ({ content: `📚 学习并讲解：${it.topic}` }));
      todo = initTodo(todoItems);
    } catch { /* todo 不可用不影响清单写入 */ }
    return {
      ok: true,
      added: r.added || 0,
      topics: clean.map((it) => it.topic),
      todoItems: todo?.items || null,
      hint: "已加入学习清单并挂上学习任务（面板任务清单可见），可让用户去查看；每学完一个知识点调 todo_done 标记进度，之后可讲解/复盘/面试考察",
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** 对话 → 复习卡：为用户建 FSRS 间隔复习卡（到期提醒）
 * @param {{topic: string, question?: string, answer?: string}} args 卡片内容
 * @returns {Promise<{ok: boolean, topic: string, hint: string}|{error: string}>} 建卡结果
 */
export async function toolCreateReviewCard({ topic, question, answer }) {
  try {
    const { review } = await import("../review.mjs");
    const t = String(topic || "").trim();
    if (!t) return { ok: false, error: "topic 必填" };
    const q = String(question || "").trim() || `请完整讲讲：${t}`;
    review.addCard({
      topic: t,
      question: q,
      answer: String(answer || "").slice(0, 500),
      source: "对话",
    });
    return { ok: true, topic: t, hint: "已建复习卡（FSRS 间隔复习，到期自动提醒）" };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 创建长期学习计划（通用引擎：任意长时间学习目标 → 计划 + 事件流 + 趋势）
 * @param {{title?: string, scope?: string[], quotaPerDay?: number, durationDays?: number, milestones?: string[]}} args 计划参数
 * @returns {Promise<{ok: boolean, planId: string, title: string, scope: string[], quotaPerDay: number, durationDays: number, message: string}|{error: string}>} 计划结果
 */
export async function toolCreateLearningPlan({ title, scope, quotaPerDay, durationDays, milestones }) {
  try {
    const { createLearningPlan } = await import("../learning-plan.mjs");
    const r = createLearningPlan({ title, scope, quotaPerDay, durationDays, milestones });
    if (!r.ok) return { error: r.error };
    return {
      ok: true,
      planId: r.plan.id,
      title: r.plan.title,
      scope: r.plan.scope,
      quotaPerDay: r.plan.quotaPerDay,
      durationDays: r.plan.durationDays,
      message: `已建计划「${r.plan.title}」：每日 ${r.plan.quotaPerDay} 个，共 ${r.plan.durationDays} 天。之后的做题/学习会自动归入统计。`,
    };
  } catch (e) {
    return { error: `创建计划失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/**
 * 查询学习计划状态（进度/趋势/薄弱主题）
 * @param {{planId?: string}} [args] 计划 id（缺省查当前计划）
 * @returns {Promise<{ok: boolean, plan: object, status: object}|{error: string}>} 计划 + 状态
 */
export async function toolGetLearningPlanStatus({ planId } = {}) {
  try {
    const { getLearningPlanStatus } = await import("../learning-plan.mjs");
    const r = getLearningPlanStatus(planId);
    if (!r.ok) return { error: r.error };
    const s = r.status;
    return {
      ok: true,
      plan: { title: r.plan.title, id: r.plan.id, elapsedDays: r.plan.elapsedDays, remainDays: r.plan.remainDays, quotaPerDay: r.plan.quotaPerDay, milestones: r.plan.milestones },
      status: {
        doneTotal: s.doneTotal,
        passRate: s.passRate,
        avgMs: s.avgMs,
        todayDone: s.todayDone,
        todayQuota: s.todayQuota,
        days: s.days,
        activeDays: s.activeDays,
        weakTopics: s.weakTopics,
        trend: s.trend.slice(-7),
      },
    };
  } catch (e) {
    return { error: `查询计划失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/**
 * 记录学习进度（手动埋点，计入学习计划统计）
 * @param {{topic?: string, note?: string, result?: "pass"|"partial"|"fail"}} [args] 学习事件
 * @returns {Promise<{ok: boolean, message: string}|{error: string}>} 记录结果
 */
export async function toolRecordLearningProgress({ topic, note, result } = {}) {
  try {
    const { recordLearningEvent } = await import("../learning-plan.mjs");
    if (!String(topic || "").trim()) return { error: "topic 必填" };
    const q = result === "pass" ? 1 : result === "partial" ? 0.5 : result === "fail" ? 0 : null;
    const ev = recordLearningEvent({ topic, kind: "manual", result: result || null, quality: q, durationMs: null });
    const planNote = ev.planId ? "已计入学习计划统计" : "未匹配到学习计划（可建计划后自动归类）";
    return { ok: true, message: `已记录「${String(topic).slice(0, 40)}」（${String(note || "").slice(0, 60)}）· ${planNote}` };
  } catch (e) {
    return { error: `记录失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}
