// 学习讲解文件工具：study_notes 目录 + 条目讲解文件查找 + 文件名安全化
// 从 widget.mjs 抽出（路由纵向拆分共用），独立可测
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";

/** 文件名规范化：忽略空格/下划线/括号/冒号/斜杠等差异，用于模糊匹配。
 * 注意：必须覆盖 sanitizeFilename 删除的字符（\\/:*?"<>|）——否则 topic 含冒号/斜杠时
 * 存档名与查找名不一致，findStudyFile 找不到已存在的存档 → 重新生成覆盖 → 讲解/追问丢失 */
export const normName = (s) => String(s || "").toLowerCase().replace(/[\s_\-（）()【】[\].:/\\*?"<>|]/g, "");

/** 学习讲解文件专用目录（AI 生成的讲解存档） */
export const studyNotesDir = () => path.join(config.outputDir, "study_notes");

/** 知识点名 → 安全文件名（去掉 Windows 非法字符） */
export function sanitizeFilename(name) {
  return String(name || "note")
    .replace(/[\\/:*?"<>|\r\n]/g, "")
    .trim()
    .slice(0, 60) || "note";
}

/**
 * 查找学习条目的讲解文件：
 * 1. study_notes/ 下按 topic 精确匹配（最优先——AI 生成的讲解存档）
 * 2. 产出目录里按 source 文件名模糊匹配
 * @param {{topic?: string, source?: string}} item
 * @param {{notesOnly?: boolean}} [opts] notesOnly=true 时只查 study_notes 精确匹配——
 *    "重新生成"（noSimilar=1）用：产出目录 source 模糊匹配（includes 双向）可能命中相似文件
 *    （如 source 短时匹配到"合并有序数组.md"），导致 reset 删了本条存档后仍返回旧文件（重新生成不生效）
 */
export function findStudyFile(item, { notesOnly = false } = {}) {
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return null;
  // 1. study_notes 按 topic 匹配
  const notesDir = studyNotesDir();
  if (existsSync(notesDir)) {
    // 与存档文件名同管道：sanitizeFilename（去非法字符 + 60 截断）→ normName。
    // 长 topic（清理后 >60 字符）截断存储，若直接 normName 全串会失配 → 重复生成覆盖旧讲解/追问
    const topicNorm = normName(sanitizeFilename(item?.topic));
    for (const f of readdirSync(notesDir)) {
      if (!f.endsWith(".md")) continue;
      if (normName(f.replace(/\.md$/, "")) === topicNorm) {
        return path.join(notesDir, f);
      }
    }
  }
  // 2. 产出目录按 source 模糊匹配（notesOnly 时跳过——重新生成不认复用/模糊匹配）
  if (notesOnly) return null;
  const src = String(item?.source || "").replace(/\.md$/, "");
  const sn = normName(src);
  for (const d of readdirSync(outDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "study_notes" || d.name === "讲解") continue; // 讲解子目录（discover 产出分离）不参与 source 匹配
    const dirPath = path.join(outDir, d.name);
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".md") || /^00[_-]/.test(f)) continue;
      const key = normName(f.replace(/\.md$/, ""));
      // sn 为空时 key.includes("") 恒真 → 误命中任意产出文件（讲解生成张冠李戴）——空 source 不匹配
      // 最小长度门槛（2026-08 排查）：双向 includes 对短串天然高分——"a"⊂"abc"、"js"⊂"jsx"
      // 会误命中无关产出；归一化后 <3 字不参与模糊匹配（精确相等仍可命中）
      if (sn && (key === sn || (sn.length >= 3 && key.length >= 3 && (key.includes(sn) || sn.includes(key))))) return path.join(dirPath, f);
    }
  }
  return null;
}
