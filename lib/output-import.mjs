// lib/output-import.mjs —— 手动导入面经到产出目录（与爬取产出同构）
// 格式：output/YYYY-MM-DD/NN_标题_来源.md（# 标题 + > 来源 + 正文）
// 落盘后自动被巡检/最新产出/面试素材（recentOutputsText）识别，无需额外索引
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";

/** 文件名安全化：去 Windows 非法字符 + 压缩空白 + 截断 */
function safeName(s) {
  return String(s || "")
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * 保存一条手动导入的面经
 * @param {{title: string, content: string, source?: string}} post
 * @param {string} [outputDir] 产出根目录（默认 config.outputDir；测试可注入临时目录）
 * @returns {{ok: boolean, file?: string, name?: string, error?: string}}
 */
export function saveImportedPost({ title, content, source = "" }, outputDir = config.outputDir) {
  const t = String(title || "").trim();
  const c = String(content || "").trim();
  if (!t || !c) return { ok: false, error: "标题和内容不能为空" };
  if (c.length < 20) return { ok: false, error: "内容太短（至少 20 字），请粘贴完整面经" };
  const dateDir = new Date().toISOString().slice(0, 10); // 与爬取同构的日期目录
  const dir = path.join(outputDir, dateDir);
  try { mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: "创建目录失败: " + String(e.message).slice(0, 60) }; }
  // 序号：目录内已有 md 数 + 1（与爬取 NN_ 前缀一致）
  let n = 1;
  try { n = readdirSync(dir).filter((f) => f.endsWith(".md")).length + 1; } catch { /* ignore */ }
  const srcName = safeName(source ? String(source).replace(/^https?:\/\//, "").split("/")[0] : "手动导入");
  const fileName = `${String(n).padStart(2, "0")}_${safeName(t)}_${srcName}.md`;
  const file = path.join(dir, fileName);
  const srcTag = source ? `\n> 来源: ${String(source).trim().slice(0, 300)}\n` : "\n> 来源: 手动导入\n";
  try {
    writeFileSync(file, `# ${t}\n${srcTag}\n${c}\n`, "utf8");
  } catch (e) {
    return { ok: false, error: "写入失败: " + String(e.message).slice(0, 60) };
  }
  return { ok: true, file: path.relative(outputDir, file), name: fileName };
}
