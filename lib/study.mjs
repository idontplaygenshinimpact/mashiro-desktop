// 学习清单模块：从产出提炼优先学习内容 + 勾选完成 + 复盘验证
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";
import { llmChat, getReplyText } from "./llm.mjs";
import { memory } from "./memory.mjs";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const PLAN_FILE = path.join(DATA_DIR, "study-plan.json");

// ---------- 存储 ----------
function loadPlan() {
  try {
    if (existsSync(PLAN_FILE)) return JSON.parse(readFileSync(PLAN_FILE, "utf8"));
  } catch { /* ignore */ }
  return { date: "", items: [] };
}
function savePlan(plan) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), "utf8");
  } catch { /* ignore */ }
}

// ---------- 从产出文件提炼学习清单 ----------
export async function generateStudyPlan() {
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return { date: "", items: [], error: "暂无产出" };

  // 收集最近的产出文件内容
  const files = [];
  const collect = (dir, depth = 0) => {
    if (depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p, depth + 1);
      else if (e.name.endsWith(".md") && !e.name.startsWith("00_")) {
        const st = statSync(p);
        if (st.size > 500 && st.size < 60000) files.push({ name: e.name, path: p });
      }
    }
  };
  collect(outDir);
  // 取最新的 8 个文件
  files.sort((a, b) => statSync(b.path).mtime - statSync(a.path).mtime);
  const latest = files.slice(0, 8);

  const excerpts = [];
  for (const f of latest) {
    const content = readFileSync(f.path, "utf8");
    excerpts.push(`【${f.name}】\n${content.slice(0, 2500)}`);
  }

  const prompt = `你是前端秋招学习规划师。下面是最近爬取整理的面经/笔试讲解产出（${latest.length} 篇）。请基于这些内容的**高频考点和当前招聘导向**，提炼出今天最值得优先学习的 **5-8 个知识点**，每个知识点给出：
- topic：知识点名称（如"事件循环与微任务"）
- why：为什么现在要学（基于产出里的出现频率/公司导向）
- source：参考哪篇产出（文件名）
- verify_question：一道用于自我验证的简答题（面试风格）

只输出 JSON：
{"items":[{"topic":"...","why":"...","source":"...","verify_question":"..."}]}

产出内容：
${excerpts.join("\n\n---\n\n").slice(0, 20000)}`;

  const raw = await llmChat(
    [
      { role: "system", content: "你只输出合法 JSON，不要输出其他内容。" },
      { role: "user", content: prompt },
    ],
    { maxTokens: 4000, temperature: 0.4 }
  );

  let items = [];
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    items = (parsed.items || []).map((it, i) => ({
      id: `s${i + 1}`,
      topic: it.topic,
      why: it.why,
      source: it.source,
      verify_question: it.verify_question,
      done: false,
      reviewed: false,
    }));
  } catch (e) {
    return { date: "", items: [], error: `解析失败: ${e.message}` };
  }

  const plan = { date: new Date().toISOString().slice(0, 10), items };
  savePlan(plan);
  return plan;
}

// ---------- 读取/勾选 ----------
export function getPlan() {
  const plan = loadPlan();
  return plan;
}

// 从面试复盘等来源追加知识点（不重复）
export function addPlanItems(items) {
  const plan = loadPlan();
  let added = 0;
  for (const it of items || []) {
    if (!it?.topic) continue;
    const exists = plan.items.find((x) => x.topic === it.topic);
    if (exists) continue; // 已有则跳过（保持原状态）
    plan.items.push({
      id: `s${Date.now().toString(36)}${plan.items.length}`,
      topic: it.topic,
      why: it.why || "来自模拟面试复盘",
      source: it.source || "模拟面试",
      verify_question: it.verify_question || `请简述：${it.topic} 的核心要点`,
      done: false,
      reviewed: false,
      fromInterview: true,
    });
    added++;
  }
  if (added) { plan.date = new Date().toISOString().slice(0, 10); savePlan(plan); }
  return { ok: true, added };
}

export function checkItem(id, done) {
  const plan = loadPlan();
  const item = plan.items.find((i) => i.id === id);
  if (!item) return { ok: false, error: "未找到条目" };
  item.done = !!done;
  if (item.done) item.doneAt = new Date().toISOString();
  savePlan(plan);
  return { ok: true, item };
}

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
export async function answerReview(answers) {
  // answers: [{id, answer}]
  const plan = loadPlan();
  const answered = answers.filter((a) => a.answer && a.answer.trim());
  if (answered.length === 0) return { ok: false, error: "没有提交任何答案" };

  const qa = answered.map((a) => {
    const it = plan.items.find((i) => i.id === a.id);
    return { topic: it?.topic || a.id, question: it?.verify_question || "", answer: a.answer };
  });

  const prompt = `你是前端面试官。用户回答了以下自我验证题，请逐题评判（对/部分对/错），给出简要点评（1-2 句），并给出参考答案要点。

${qa.map((q, i) => `题${i + 1}【${q.topic}】${q.question}\n用户回答：${q.answer}`).join("\n\n")}

只输出 JSON：
{"results":[{"topic":"...","verdict":"对|部分对|错","comment":"点评","reference":"参考答案要点"}]}`;

  const raw = await llmChat(
    [
      { role: "system", content: "你是严格但友好的前端面试官。只输出合法 JSON。" },
      { role: "user", content: prompt },
    ],
    { maxTokens: 4000, temperature: 0.3 }
  );

  let results = [];
  try {
    results = JSON.parse(raw.replace(/```json|```/g, "").trim()).results || [];
  } catch { /* ignore */ }

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

  return { ok: true, results };
}
