// 讲解存档清查：study_notes 存量文件——伪讲解/过短/结构异常
// 检测：① 头部是追问回答（## 💬 追问 出现在 500 字符内）② 内容过短（<500 字符）
//       ③ 结构异常（无 ## 题目 / ### 结论 等讲解结构）——IndexOf -1 处理（找不到 ≠ 头部即追问）
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTES = path.join(ROOT, "output", "study_notes");

if (!existsSync(NOTES)) { console.log("study_notes 不存在:", NOTES); process.exit(0); }

const files = readdirSync(NOTES).filter((f) => f.endsWith(".md"));
const issues = [];
for (const f of files) {
  const p = path.join(NOTES, f);
  const st = statSync(p);
  const text = readFileSync(p, "utf8");
  const len = text.length;
  const qIdx = text.indexOf("## 💬 追问");
  const pseudo = qIdx >= 0 && qIdx < 500; // 追问块在头部 500 字符内 = 伪讲解（追问回答被当主体）
  const tooShort = len < 500;
  const hasTitle = text.includes("## 题目") || text.includes("## 总览") || text.includes("## 核心概念") || text.includes("## 问题");
  const hasConclusion = text.includes("### 结论") || text.includes("## 结论") || text.includes("## 常见实现");
  const structural = !(hasTitle && hasConclusion); // 无讲解结构（生成版/整理版结构不同，任一命中即有效）
  if (pseudo || tooShort || structural) {
    issues.push({ file: f, len, pseudo, tooShort, structural, qIdx: qIdx >= 0 ? qIdx : -1, head: text.slice(0, 60).replace(/\n/g, " ") });
  }
}
console.log(`共 ${files.length} 个存档，问题文件 ${issues.length} 个：`);
for (const i of issues) {
  console.log(`  ${i.file} (${i.len}字) ${i.pseudo ? "【伪讲解】" : ""}${i.tooShort ? "【过短】" : ""}${i.structural ? "【结构异常】" : ""} 追问@${i.qIdx} | ${i.head}`);
}
console.log('URL:', import.meta.url);
