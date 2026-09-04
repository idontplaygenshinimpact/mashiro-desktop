// 工具实现组：面试/出题/产出（纵向拆分第 3 刀）
// toolDetectQuestions / toolSolveQuestion / toolRecordInterviewTopics / toolGetRecentOutputs
import { config } from "../../config.mjs";
import { solveQuestion, detectQuestions } from "../ai.mjs";
import { memory } from "../memory.mjs";
import { wrapUntrusted } from "../prompt-guard.mjs";
import { getCareerProfile } from "../career.mjs";

/**
 * 从面经文本提取面试题
 * @param {{ title: string, text: string }} arg 面经标题 + 正文
 * @returns {Promise<Array<{topic: string, question: string}>>} 提取的题目
 */
export async function toolDetectQuestions({ title, text }) {
  const r = await detectQuestions({ title, text });
  memory.markSeen(title); // 记录已处理
  // 提取的题目来自外部页面，包裹为不可信数据（防恶意页面注入持久化到后续轮次）
  if (r?.questions?.length) {
    r.questions = r.questions.map((q) => ({ ...q, question: wrapUntrusted(q.question) }));
  }
  return r;
}

/**
 * 获取最近产出（巡检/搜集的存档列表）
 * @returns {Promise<{outputs: Array<{file: string, topics: string[], preview: string}>, hint: string} | {error: string}>} 产出列表
 */
export async function toolGetRecentOutputs() {
  try {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const outDir = path.join(config.outputDir);
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
    files.sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime());
    const latest = files.slice(0, 5).map((f) => {
      const c = readFileSync(f, "utf8");
      const title = path.basename(f).replace(/\.md$/, "").slice(0, 40);
      // 提取 ## 标题作为知识点线索
      const heads = [...c.matchAll(/^#{2,3}\s+(.+)$/gm)].slice(0, 6).map((m) => m[1].trim());
      return { file: title, topics: heads, preview: c.slice(0, 300) };
    });
    return { outputs: latest, hint: "这些是最近爬取的面经/题目，出题可参考真实考点" };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 记录面试涉及的知识点（薄弱点回流）
 * @param {string[]} topics 知识点列表
 * @param {string} company 公司名
 * @returns {Promise<{ok: boolean, added: string[], existing: string[], skipped: Array<{topic: string, reason: string}>, hint: string}>} 记录结果
 */
export async function toolRecordInterviewTopics(topics, company) {
  const added = [], existing = [], skipped = [];
  for (const t of (topics || []).slice(0, 8)) {
    const rawTopic = String(t || "").trim().slice(0, 40);
    if (!rawTopic) continue;
    // 伪知识点过滤 + 规范化（用清洗后的 topic，保证与薄弱点口径一致）
    const topic = memory._cleanTopic ? memory._cleanTopic(rawTopic) : rawTopic;
    if (!topic) { skipped.push({ topic: rawTopic, reason: "非具体知识点" }); continue; }
    try {
      const { addPlanItems } = await import("../study.mjs");
      const r = addPlanItems([{
        topic,
        why: "真实面试中被问住，需优先补强",
        source: company ? `面试实录(${company})` : "面试实录",
        verify_question: `请完整回答并讲清原理：${topic}`,
        level: "必会",
      }]);
      if (r.added > 0) {
        added.push(topic);
        // 自动建复习卡
        try {
          const { review } = await import("../review.mjs");
          review.addCard({ topic, question: `请完整回答并讲清原理：${topic}`, answer: "", source: "面试实录" });
        } catch { /* ignore */ }
      } else {
        existing.push(topic);
      }
    } catch (e) {
      skipped.push({ topic, reason: e.message });
    }
  }
  return {
    ok: true,
    added, existing, skipped,
    hint: `已把 ${added.length} 个知识点加入学习清单（必会），可在面板「📋 学习清单」点「💡 讲解」生成详细讲解`,
  };
}

/**
 * 生成题目讲解（面试官工具——出题后讲解）
 * @param {{ question: string, company: string, sourceUrl?: string }} arg 题目信息
 * @returns {Promise<{saved: string, preview: string}>} 讲解存档路径 + 预览
 */
export async function toolSolveQuestion({ question, company, sourceUrl }) {
  const profile = getCareerProfile();
  const md = await solveQuestion({
    title: question.slice(0, 50),
    text: question,
    company: company || "面试题",
    position: "面试", // 修复：position 硬编码"前端实习生"（画像默认）诱导 LLM 硬套前端（"前端视角的映射"）——
    // 与 study-detail-stream 同款修复——从知识本身讲（原题是什么岗位就按什么岗位）
    sourceUrl: sourceUrl || "",
  });
  // 归档到 output/chat_solutions/
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(config.outputDir, "chat_solutions");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const fname = `${date}_${String(Date.now()).slice(-6)}_${(company || "题").replace(/[\\/:*?"<>|]/g, "_").slice(0, 20)}.md`;
  writeFileSync(path.join(dir, fname), `# ${question.slice(0, 60)}\n\n> 来源: ${sourceUrl || "对话提问"}\n\n${md}\n`, "utf8");
  // 讲解内容基于外部页面生成，回填时包裹为不可信数据（防注入随讲解在后续轮次传播）
  return { saved: path.join("output", "chat_solutions", fname), preview: wrapUntrusted(md.slice(0, 1500)) };
}
