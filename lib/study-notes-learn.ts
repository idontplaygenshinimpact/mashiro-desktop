// 面经产出转学习任务工单：讲解存档（study_notes）→ 学习清单
// 采集强消费弱：讲解存档不自动入清单 → 用户不主动看就沉淀。本模块打通"采集→学习"闭环：
//   - 自动增量（widget 启动：新讲解自动入清单，settings last_notes_learn_ts 增量幂等）
//   - 手动按钮（面板"转学习"：单条/全部，已转标记防重复）
// 文件名即知识点（讲解是按 topic 生成的存档）——无需 LLM 提炼，直接文件名 → topic
// 全量 TS 升级工单阶段 1⑬：lib/study-notes-learn.mjs → .ts（存档条目形状显式声明）
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { studyNotesDir } from "./study-files.ts";
import { isSimilarTopicForArchive } from "./memory.mjs"; // 倒序/措辞漂移相似（"版本号比较" vs "比较版本号"）
import { addPlanItems, getPlan } from "./study.mjs";
import { db } from "./db.mjs";

const LEARN_TS_KEY = "last_notes_learn_ts"; // 增量游标：只处理该时间之后的新存档

/** 讲解存档条目（文件名即 topic） */
export interface StudyNote { file: string; topic: string; size: number; mtimeMs: number }

/** 扫描讲解存档（顶层 .md，不含主题簇子目录） */
export function listStudyNotes(): StudyNote[] {
  const dir = studyNotesDir();
  const out: StudyNote[] = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const p = path.join(dir, e.name);
      try {
        const st = statSync(p);
        out.push({ file: e.name, topic: e.name.slice(0, -3), size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* ignore */ }
    }
  } catch { /* 目录不存在返回空 */ }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 清单是否已有该知识点（精确或相似——防重复转学习） */
function inPlan(topic: string): boolean {
  const items = getPlan().items || [];
  return items.some((i) => i.topic === topic || isSimilarTopicForArchive(topic, String(i.topic || "")));
}

/** level 按考点频率：同知识点有多个变体存档（"版本号比较/比较版本号/版本号数组排序"）→ 必会；单篇 → 进阶
 * 注意：isSimilarTopicForArchive 对相同字符串返回 false（a===b 短路）——自身要 +1 */
function levelFor(topic: string, all: StudyNote[]): string {
  const freq = 1 + all.filter((n) => n.topic !== topic && isSimilarTopicForArchive(topic, n.topic)).length;
  return freq >= 2 ? "必会" : "进阶";
}

/** 入清单（source="面经产出·{文件名}"；精确/相似已存在则跳过） */
function toPlan(note: StudyNote): { ok: boolean; added: number; skipped?: string; error?: string } {
  if (inPlan(note.topic)) return { ok: true, added: 0, skipped: "已在清单" };
  const all = listStudyNotes();
  const r = addPlanItems([{
    topic: note.topic,
    why: `来自讲解存档「${note.file}」——已讲解过的考点，优先复习巩固`,
    source: `面经产出·${note.file}`,
    verify_question: `请完整讲解：${note.topic}`,
    level: levelFor(note.topic, all),
  }]);
  return { ok: true, added: r.added || 0, skipped: r.added ? "" : "已在清单" };
}

/** 单条转学习（面板按钮） */
export function learnOneNote(file: unknown): { ok: boolean; added?: number; skipped?: string; error?: string } {
  const name = String(file || "").trim();
  if (!name.endsWith(".md")) return { ok: false, error: "文件必须是 .md 讲解存档" };
  const note = listStudyNotes().find((n) => n.file === name);
  if (!note) return { ok: false, error: `讲解存档不存在：${name}` };
  return toPlan(note);
}

/** 全部转学习（面板"全部转"按钮——存量 122 篇一键沉淀） */
export function learnAllNotes(): { ok: true; total: number; added: number; skipped: number } {
  const notes = listStudyNotes();
  let added = 0, skipped = 0;
  for (const n of notes) {
    const r = toPlan(n);
    if (r.added > 0) added++; else skipped++;
  }
  return { ok: true, total: notes.length, added, skipped };
}

/** 自动增量（widget 启动）：只处理 last_notes_learn_ts 之后的新存档——幂等，不刷爆存量清单
 * 首次运行（游标不存在）只推进游标不转存量：存量 122 篇用面板"全部转学习"按钮按需转（用户可控） */
export function learnFromStudyNotes(): { ok: true; scanned: number; added: number } {
  const last = (() => {
    try {
      // node:sqlite 行值类型在边界处收口
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(LEARN_TS_KEY) as unknown as { value?: unknown } | undefined;
      return Number(row?.value || 0);
    } catch { return 0; }
  })();
  const notes = listStudyNotes();
  // 容差 1ms：文件 mtime 与游标同毫秒（mtime 带小数、游标整数毫秒）时误判为新文件——偶发重复转
  const fresh = last > 0 ? notes.filter((n) => n.mtimeMs > last + 1) : []; // 首次不转存量
  let added = 0;
  for (const n of fresh) {
    const r = toPlan(n);
    if (r.added > 0) added++;
  }
  // 游标推进：取全部文件最大 mtime（修复：此前用 Date.now()——CI 文件系统 mtime 秒级精度，
  // 同秒内新文件 mtime（秒级）< 游标（毫秒）→ 误判为旧文件不转。游标与文件 mtime 同精度比较）
  const cursor = notes.length ? Math.max(...notes.map((n) => n.mtimeMs)) : Date.now();
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(LEARN_TS_KEY, String(cursor), Date.now());
  } catch { /* ignore */ }
  return { ok: true, scanned: fresh.length, added };
}

/** 面板列表：讲解存档 + 已转标记（inPlan） */
export function listStudyNotesWithPlan() {
  const notes = listStudyNotes();
  return notes.map((n) => ({ ...n, inPlan: inPlan(n.topic) }));
}
