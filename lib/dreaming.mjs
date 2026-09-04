// 记忆巩固（OpenClaw 风格 Dreaming）：夜间"做梦"把碎片记忆提炼成长期记忆
// 流程：collectCandidates（从各表收集候选，origin 溯源门禁排除 untrusted）
//       → selectCandidates（recency+importance 加权取 top-N）
//       → buildConsolidationPrompt（中文 LLM 提示词）
//       → runDreaming（LLM 提炼 JSON → INSERT OR REPLACE 到 curated_memory → 写 markdown 日志）
// 溯源模型（对标 OpenClaw）：候选带 origin（owner/agent/untrusted）+ sourceRef（来源引用），
// 提炼后的长期记忆也必须带 sourceRef，可追溯"这条记忆从哪来"。
import { extractJson } from "./llm.mjs";
import { localDateKey } from "./date-utils.mjs";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { withTx } from "./db.mjs";

// ---------- JSON 提取（与 lib/llm.mjs 同款：兼容代码块/前后缀；本地实现避免依赖 llm 配置） ----------


// ---------- 时间解析 + 时新度 ----------
const DAY_MS = 24 * 3600 * 1000;

function parseTs(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

// 时新度：越新越高（1.0=刚刚 → 趋近 0=很久以前/无时间戳）。now - ts 越大分越低。
function recencyScore(now, ts) {
  const t = parseTs(ts);
  if (!t) return 0;
  const ageDays = Math.max(0, now - t) / DAY_MS;
  return 1 / (1 + ageDays);
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// ---------- 候选收集 ----------
/**
 * 从各记忆表收集候选（origin 溯源门禁：untrusted 直接排除）
 * @param {{ chatHistory?: Array, weakPoints?: Array, masteredPoints?: Array, interviewHistory?: Array, now?: number }} src
 * @returns {Array<{text:string, origin:string, sourceRef:string, recencyScore:number, importanceScore:number}>}
 */
export function collectCandidates({ chatHistory = [], weakPoints = [], masteredPoints = [], interviewHistory = [], now = Date.now() } = {}) {
  const out = [];

  // 薄弱点（origin 门禁：untrusted 伪知识点不进入长期记忆提炼）
  for (const w of weakPoints || []) {
    if (!w || w.origin === "untrusted") continue;
    const topic = String(w.topic || "").trim();
    if (!topic) continue;
    const failCount = w.failCount || w.fail_count || 0;
    out.push({
      text: `薄弱点：${topic}（答错 ${failCount} 次）`,
      origin: w.origin || "agent",
      sourceRef: `weak:${topic}`,
      recencyScore: recencyScore(now, w.lastFailedAt ?? w.last_failed_at),
      importanceScore: Math.min(1 + failCount, 5),
    });
  }

  // 已掌握（agent 验证过，低优先级但仍值得沉淀）
  for (const m of masteredPoints || []) {
    if (!m) continue;
    const topic = String(m.topic || "").trim();
    if (!topic) continue;
    out.push({
      text: `已掌握：${topic}`,
      origin: "agent",
      sourceRef: `mastered:${topic}`,
      recencyScore: recencyScore(now, m.verifiedAt ?? m.verified_at),
      importanceScore: 1,
    });
  }

  // 跨会话对话历史（user → owner 来源，assistant → agent 来源，均可信）
  for (const c of chatHistory || []) {
    if (!c) continue;
    const text = String(c.content || "").trim();
    if (!text) continue;
    out.push({
      text: `对话(${c.role || "unknown"})：${text.slice(0, 200)}`,
      origin: c.role === "user" ? "owner" : "agent",
      sourceRef: `chat:${c.ts || 0}`,
      recencyScore: recencyScore(now, c.ts),
      importanceScore: 1,
    });
  }

  // 面试历史（轮次越多越值得总结）
  for (const iv of interviewHistory || []) {
    if (!iv) continue;
    const label = iv.position || iv.role || "面试";
    const body = iv.report ? `\n复盘：${String(iv.report).slice(0, 200)}` : "";
    out.push({
      text: `面试记录：${label}（${iv.date || "未知日期"}）${body}`,
      origin: "agent",
      sourceRef: `interview:${iv.date || "unknown"}`,
      recencyScore: recencyScore(now, iv.date),
      importanceScore: Math.min(1 + (iv.rounds || 0), 5),
    });
  }

  return out;
}

// ---------- 候选筛选 ----------
/**
 * 按 recencyScore + importanceScore 加权取 top-N（确定性稳定排序）
 */
export function selectCandidates(candidates, { maxCount = 12 } = {}) {
  const sorted = [...(candidates || [])].sort((a, b) => {
    const diff = (b.recencyScore + b.importanceScore) - (a.recencyScore + a.importanceScore);
    if (diff !== 0) return diff;
    // 平分时按 sourceRef 字典序稳定排序（确定性，避免同分抖动）
    return String(a.sourceRef).localeCompare(String(b.sourceRef));
  });
  return sorted.slice(0, maxCount);
}

// ---------- LLM 提示词 ----------
/**
 * 中文 LLM 提示词：要求输出 JSON {entries:[{topic,content,sourceRef,importance,keep}], drop:[topics]}
 */
export function buildConsolidationPrompt(candidates, existingMemory) {
  const candLines = (candidates || []).map((c, i) =>
    `${i + 1}. [来源:${c.sourceRef}] ${c.text}`).join("\n");
  const existing = (existingMemory || []).length
    ? (existingMemory || []).map((m) => `- ${m.topic}（来源:${m.source_ref || m.sourceRef || "未知"}）`).join("\n")
    : "（无）";

  return `你是记忆巩固助手。请把下面的候选素材提炼成结构化长期记忆，并淘汰过时/低价值主题。

已有长期记忆：
${existing}

候选素材：
${candLines}

要求：
1. 只输出一个合法 JSON 对象：{"entries":[{"topic":"主题","content":"内容(<=120字)","sourceRef":"来源引用","importance":1-5,"keep":"保留原因"}],"drop":["可丢弃的主题"]}
2. 每条 entry 的 sourceRef 必须从候选素材的 [来源:xxx] 中引用（原样复制，不要编造）。
3. 每条 entry 的 content 不超过 120 字，importance 取 1-5 整数。
4. drop 数组列出已过时/被新记忆取代/无长期价值的主题（可为空数组）。
5. 不要输出 Markdown 代码块、不要任何解释文字，只输出 JSON 本身。`;
}

// ---------- 默认依赖 ----------
async function defaultLlm(messages) {
  const { chat } = await import("./ai.mjs");
  return await chat(messages, { maxTokens: 2000, json: true, temperature: 0.3 });
}

function defaultLogDir() {
  return path.join(process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "data"), "dreams");
}

// 表读取 helper（表可能不存在时返回空，不抛）
function readRows(dbi, sql) {
  try { return dbi.prepare(sql).all(); } catch { return []; }
}

// ---------- 主流程 ----------
/**
 * 完整巩固流程：collect → select → LLM 提炼 → 写 curated_memory → 写日志
 * @param {{ llm?: Function, now?: number, dbImpl?: any, logDir?: string }} opts
 *   llm: async (messages) => string（默认 ai.mjs chat 包装）；now: 当前时间戳；dbImpl: SQLite 实例（默认 db.mjs db）；logDir: 日志目录
 * @returns {Promise<{ok:boolean, candidates?:number, added?:number, updated?:number, dropped?:number, logFile?:string|null, error?:string}>}
 */
export async function runDreaming({ llm, now = Date.now(), dbImpl, logDir } = {}) {
  try {
    const dbi = dbImpl || (await import("./db.mjs")).db;
    const useLlm = llm || defaultLlm;
    const logBase = logDir || defaultLogDir();

    // 1. collect：从各表读候选（origin 门禁在 collectCandidates 内）
    const chatHistory = readRows(dbi, "SELECT role, content, ts FROM chat_history ORDER BY id DESC LIMIT 40")
      .map((r) => ({ role: r.role, content: r.content, ts: r.ts }));
    const weakPoints = readRows(dbi, "SELECT topic, fail_count, last_failed_at, source, origin FROM weak_points")
      .map((r) => ({ topic: r.topic, failCount: r.fail_count, lastFailedAt: r.last_failed_at, source: r.source, origin: r.origin }));
    const masteredPoints = readRows(dbi, "SELECT topic, verified_at FROM mastered_points")
      .map((r) => ({ topic: r.topic, verifiedAt: r.verified_at }));
    const interviewHistory = readRows(dbi, "SELECT date, position, role, rounds, avg, dims, report FROM interview_history")
      .map((r) => ({ date: r.date, position: r.position, role: r.role, rounds: r.rounds, avg: r.avg, dims: r.dims, report: r.report }));

    const all = collectCandidates({ chatHistory, weakPoints, masteredPoints, interviewHistory, now });
    const selected = selectCandidates(all);

    // 无候选：不调 LLM，直接返回
    if (!selected.length) {
      return { ok: true, candidates: all.length, added: 0, updated: 0, dropped: 0, logFile: null };
    }

    // 2. LLM 提炼（源引用 → origin 映射，保留溯源链）
    const originByRef = new Map(selected.map((c) => [c.sourceRef, c.origin]));
    const existing = readRows(dbi, "SELECT topic, source_ref FROM curated_memory");
    const prompt = buildConsolidationPrompt(selected, existing);
    const raw = await useLlm([
      { role: "system", content: "你是记忆巩固助手，负责把碎片记忆提炼成带来源的长期记忆。" },
      { role: "user", content: prompt },
    ]);

    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { ok: false, error: "LLM 输出无法解析为 JSON（需含 entries 数组）" };
    }

    // 3. 写 curated_memory + drop（同一事务：entries upsert 与 drop 要么全成要么全回滚）
    let added = 0, updated = 0, dropped = 0;
    // drop 白名单：只允许删除"本次 upsert 的 entries 主题 ∪ 现有 curated_memory 主题"，
    // 防 LLM 幻觉输出任意主题名 → 误删真实长期记忆（无候选校验的历史问题）
    const dropAllowed = new Set(readRows(dbi, "SELECT topic FROM curated_memory").map((r) => r.topic));
    withTx(() => {
      const upsert = dbi.prepare(`INSERT OR REPLACE INTO curated_memory
        (id, topic, content, source_ref, importance, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of parsed.entries || []) {
        if (!e) continue;
        const topic = String(e.topic || "").trim().slice(0, 120);
        const content = String(e.content || "").trim().slice(0, 120);
        const sourceRef = String(e.sourceRef || "").trim().slice(0, 200);
        // 每条 entry 必须带 sourceRef（溯源硬约束）；缺则跳过
        if (!topic || !content || !sourceRef) continue;
        const importance = clampInt(e.importance, 1, 5, 3);
        const origin = originByRef.get(sourceRef) || "agent";
        const prev = dbi.prepare("SELECT id, created_at FROM curated_memory WHERE topic = ?").get(topic);
        const id = prev ? prev.id : `cm_${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        upsert.run(id, topic, content, sourceRef, importance, origin, prev ? prev.created_at : now, now);
        if (prev) updated++; else added++;
        dropAllowed.add(topic); // 本次 entry 主题也允许被 drop（被新记忆取代）
      }
      // drop：只删白名单内的主题（不在候选集合的条目跳过，不计数）
      for (const t of parsed.drop || []) {
        const topic = String(t || "").trim();
        if (!topic || !dropAllowed.has(topic)) continue;
        dbi.prepare("DELETE FROM curated_memory WHERE topic = ?").run(topic);
        dropped++;
      }
    });

    // 4. 写 markdown 日志 logDir/YYYY-MM-DD.md
    let logFile = null;
    try {
      const date = localDateKey(now);
      const file = path.join(logBase, `${date}.md`);
      mkdirSync(path.dirname(file), { recursive: true });
      const lines = [
        `# 记忆巩固日志 ${date}`,
        "",
        `- 候选数：${all.length}（筛选后 ${selected.length}）`,
        `- 新增：${added}`,
        `- 更新：${updated}`,
        `- 丢弃：${dropped}`,
        "",
        "## 长期记忆条目",
        ...(parsed.entries || []).filter((e) => e && e.topic).map((e) =>
          `- **${e.topic}**（重要度 ${e.importance ?? "?"}，来源 ${e.sourceRef ?? "?"}）：${e.content ?? ""}`),
        "",
        "## 丢弃主题",
        ...(parsed.drop || []).map((t) => `- ${t}`),
        "",
      ];
      writeFileSync(file, lines.join("\n"), "utf8");
      logFile = file;
    } catch { /* 日志失败不影响记忆入库 */ }

    return { ok: true, candidates: all.length, added, updated, dropped, logFile };
  } catch (e) {
    // LLM 抛错 / DB 异常 / 任何未预期错误 → 不抛，返回 ok:false
    return { ok: false, error: String(e?.message || e) };
  }
}
