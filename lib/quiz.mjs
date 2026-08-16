// 复习选择题模块（快速回忆自测）
//
// 生成策略（评估结论：题库化 + 洗牌 + 轮换，而非"每次现场生成"）：
// - 每卡首次复习前懒生成一批 6 题（一次 LLM 调用批量产出，JSON 校验不合格即丢）
// - 每次复习随机抽 3 道 + 选项顺序打乱（破"背位置"；FSRS 间隔拉长后重看概率低）
// - 答错重学（rating<2）可再生成新批（batch+1，换角度再考）
// - 生成失败/未生成 → 前端优雅降级为纯文本卡（选择题只是增强，不阻塞复习）
import { randomUUID } from "node:crypto";
import { db, withTx } from "./db.mjs";

const BATCH_SIZE = 6;   // 每批生成题数
const DRAW_SIZE = 3;    // 每次复习抽取题数

// ---------- 生成（LLM 批量产出 + 严格校验） ----------
/**
 * 为复习卡生成一批选择题（一次 LLM 调用）
 * @param {{topic: string, question?: string, answer?: string}} card
 * @returns {Promise<{ok: boolean, added?: number, error?: string}>}
 */
export async function generateQuiz(card) {
  if (!card?.topic) return { ok: false, error: "卡片主题缺失" };
  try {
    const { llmChat, getReplyText, extractJson } = await import("./llm.mjs");
    const { getCareerProfile } = await import("./career.mjs");
    const prof = getCareerProfile(); // 方向画像：角色/范围/代码语言全部跟随（转后端后选择题也出后端题）
    const prompt = `你是${prof.roleLabel}（覆盖${prof.scopeNote}方向）。为知识点「${card.topic}」出 ${BATCH_SIZE} 道单选题，用于复习自测（快速回忆，不是面试提问）。
题目素材（复习卡）：
问题：${String(card.question || card.topic).slice(0, 200)}
参考答案：${String(card.answer || "（无）").slice(0, 800)}

要求：
1. 覆盖不同角度：核心概念、原理机制、易错/边界场景、代码/输出题（知识点适用时）
2. 题目内容必须与「${prof.scopeNote}」方向一致；涉及代码的题按 ${prof.codeLang} 出题与给答案
3. 每题 4 个选项、只有 1 个正确；干扰项要真实（常见误解），不能明显离谱
4. 简短精炼：题干 ≤ 45 字，选项 ≤ 22 字，解析 ≤ 35 字
5. 只输出 JSON，不要其他内容：
{"questions":[{"question":"题干","options":["选项A","选项B","选项C","选项D"],"answer":0,"explain":"一句话解析"}]}`;

    const data = await llmChat(
      [
        { role: "system", content: `你是出题老师，只输出合法 JSON。\n题目方向：${prof.scopeNote}；代码语言：${prof.codeLang}。` },
        { role: "user", content: prompt },
      ],
      { maxTokens: 2500, temperature: 0.6, role: "quiz" }
    );
    const raw = extractJson(getReplyText(data));
    const questions = Array.isArray(raw?.questions) ? raw.questions : [];
    const cleaned = questions
      .map((q, i) => {
        const question = String(q?.question || "").trim().slice(0, 60);
        const options = Array.isArray(q?.options)
          ? q.options.map((o) => String(o).trim().slice(0, 30)).filter(Boolean)
          : [];
        const uniq = [...new Set(options)];
        const answer = Number(q?.answer);
        const explain = String(q?.explain || "").trim().slice(0, 60);
        // 校验：题干/解析非空、选项 ≥3 且全部互异（防"选项重复"烂题）、answer 合法
        if (!question || options.length < 3 || uniq.length !== options.length || !Number.isInteger(answer) || answer < 0 || answer >= options.length || !explain) return null;
        return { question, options, answer, explain, order: i };
      })
      .filter(Boolean)
      .slice(0, BATCH_SIZE);
    if (!cleaned.length) return { ok: false, error: "生成的选择题未通过校验（全部不合格）" };

    // 批号：取该卡最大 batch + 1
    let batch = 1;
    try {
      const row = db.prepare("SELECT MAX(batch) b FROM quiz_questions WHERE card_id = ?").get(card.id || "");
      batch = (row?.b || 0) + 1;
    } catch { /* ignore */ }
    const now = Date.now();
    withTx(() => {
      const ins = db.prepare(`INSERT OR REPLACE INTO quiz_questions (id, card_id, batch, question, options, answer, explain, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const q of cleaned) {
        ins.run(`qz_${now.toString(36)}${randomUUID().slice(0, 8)}${q.order}`, String(card.id || ""), batch,
          q.question, JSON.stringify(q.options), q.answer, q.explain, now);
      }
    });
    return { ok: true, added: cleaned.length, batch };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

// ---------- 懒生成：题库为空才生成（供复习前调用；失败静默降级） ----------
export async function ensureQuiz(cardId) {
  try {
    const row = db.prepare("SELECT COUNT(*) n FROM quiz_questions WHERE card_id = ?").get(String(cardId || ""));
    if ((row?.n || 0) > 0) return { ok: true, total: row.n, fromCache: true };
  } catch { /* ignore */ }
  // 读卡内容作为生成素材
  let card = null;
  try {
    card = db.prepare("SELECT id, topic, question, answer FROM review_cards WHERE id = ?").get(String(cardId || ""));
  } catch { /* ignore */ }
  if (!card) return { ok: false, error: "卡片不存在" };
  const r = await generateQuiz(card);
  if (!r.ok) return r;
  return { ok: true, total: r.added, fromCache: false };
}

// ---------- 抽取：随机抽 n 题 + 选项洗牌（不返回答案，判分在服务端） ----------
export function drawQuiz(cardId, n = DRAW_SIZE) {
  try {
    const rows = db.prepare(
      `SELECT id, question, options, answer FROM quiz_questions WHERE card_id = ? ORDER BY batch DESC, RANDOM() LIMIT ?`
    ).all(String(cardId || ""), n);
    if (!rows.length) return { ok: true, questions: [], total: 0 };
    return {
      ok: true,
      total: Number(db.prepare("SELECT COUNT(*) n FROM quiz_questions WHERE card_id = ?").get(String(cardId || "")).n || 0),
      questions: rows.map((r) => {
        let options = [];
        try { options = JSON.parse(r.options); } catch { /* ignore */ }
        const answer = Number(r.answer) || 0;
        const correct = options[answer];
        // 洗牌：Fisher-Yates，保证正确项位置随机
        const idx = options.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        return {
          id: r.id,
          question: r.question,
          options: idx.map((i) => options[i]),
          answer: idx.indexOf(answer), // 洗牌后的正确项位置（前端选中后提交判分）
        };
      }),
    };
  } catch { /* ignore */ }
  return { ok: true, questions: [], total: 0 };
}

// ---------- 判分 + 记录 ----------
export function submitQuiz(cardId, answers = []) {
  const list = Array.isArray(answers) ? answers : [];
  const results = [];
  let correctCount = 0;
  const now = Date.now();
  withTx(() => {
    const ins = db.prepare("INSERT INTO quiz_attempts (card_id, question_id, correct, answered_at) VALUES (?, ?, ?, ?)");
    for (const a of list) {
      const qid = String(a?.questionId || a?.qid || "");
      if (!qid) continue;
      const row = db.prepare("SELECT id, answer, explain FROM quiz_questions WHERE id = ?").get(qid);
      if (!row) continue;
      const chosen = Number(a?.chosen ?? -1);
      const correct = chosen === Number(row.answer);
      if (correct) correctCount++;
      ins.run(String(cardId || ""), qid, correct ? 1 : 0, now);
      results.push({ questionId: qid, correct, rightIndex: Number(row.answer), explain: String(row.explain || "") });
    }
  });
  return { ok: true, correct: correctCount, total: results.length, results };
}

// ---------- 统计（正确率，薄弱点联动可读） ----------
export function getQuizStats(cardId) {
  try {
    const total = Number(db.prepare("SELECT COUNT(*) n FROM quiz_attempts WHERE card_id = ?").get(String(cardId || "")).n || 0);
    const correct = Number(db.prepare("SELECT COUNT(*) n FROM quiz_attempts WHERE card_id = ? AND correct = 1").get(String(cardId || "")).n || 0);
    const wrong = total - correct;
    const wrongTopics = Number(db.prepare("SELECT COUNT(DISTINCT question_id) n FROM quiz_attempts WHERE card_id = ? AND correct = 0").get(String(cardId || "")).n || 0);
    return { total, correct, wrong, wrongQuestions: wrongTopics };
  } catch { /* ignore */ }
  return { total: 0, correct: 0, wrong: 0, wrongQuestions: 0 };
}
