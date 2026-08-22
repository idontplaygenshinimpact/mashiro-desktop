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
 */
export function findStudyFile(item) {
  const outDir = config.outputDir;
  if (!existsSync(outDir)) return null;
  // 1. study_notes 按 topic 匹配
  const notesDir = studyNotesDir();
  if (existsSync(notesDir)) {
    const topicNorm = normName(item?.topic);
    for (const f of readdirSync(notesDir)) {
      if (!f.endsWith(".md")) continue;
      if (normName(f.replace(/\.md$/, "")) === topicNorm) {
        return path.join(notesDir, f);
      }
    }
  }
  // 2. 产出目录按 source 模糊匹配
  const src = String(item?.source || "").replace(/\.md$/, "");
  const sn = normName(src);
  for (const d of readdirSync(outDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "study_notes") continue;
    const dirPath = path.join(outDir, d.name);
    for (const f of readdirSync(dirPath)) {
      if (!f.endsWith(".md") || /^00[_-]/.test(f)) continue;
      const key = normName(f.replace(/\.md$/, ""));
      if (key === sn || key.includes(sn) || sn.includes(key)) return path.join(dirPath, f);
    }
  }
  return null;
}
