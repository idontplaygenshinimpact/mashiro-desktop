// 验证 panel 拆分文件的加载顺序：按序累积"全局声明"，检查每个文件顶层立即执行的
// 调用引用的标识符是否已声明（防 ReferenceError）。启发式：仅行首 0-2 空格缩进的语句。
import { readFileSync } from "node:fs";

const FILES = ["panel-core.js", "panel-study.js", "panel-chat.js", "panel-jobs.js", "panel-rest.js"];
const CONTROL = new Set(["if", "for", "while", "switch", "return", "catch", "finally", "else", "async", "await", "new", "delete", "typeof", "case", "throw", "import", "export", "const", "let", "var", "function", "class", "document", "window", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "console", "Math", "JSON", "Date", "Object", "Array", "String", "Number", "Boolean", "Promise", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent", "navigator", "location", "history", "fetch", "URL", "Blob", "FileReader", "FormData", "AbortController", "performance", "navigator", "localStorage", "requestAnimationFrame", "confirm", "alert", "structuredClone", "EventSource", "customElements", "getComputedStyle", "navigator"]);

const declared = new Set();
let problems = 0;

for (const f of FILES) {
  const lines = readFileSync(`desktop/renderer/${f}`, "utf8").split("\n");
  const decls = [];
  const calls = [];
  lines.forEach((l, i) => {
    const indent = l.length - l.trimStart().length;
    if (indent > 2) return; // 函数体内跳过
    const t = l.trim();
    if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return;
    // 声明：function NAME / const NAME = / let NAME = / var NAME =
    const dm = t.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/) ||
               t.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (dm) { decls.push(dm[1]); return; }
    // 顶层直接调用：NAME(... 或 $(
    const cm = t.match(/^([A-Za-z_$][\w$]*)\(/);
    if (cm) calls.push({ name: cm[1], line: i + 1, text: t.slice(0, 60) });
  });
  for (const d of decls) declared.add(d);
  // 检查本文件调用（不含本文件声明的）是否在累积声明中
  const local = new Set(decls);
  for (const c of calls) {
    if (local.has(c.name) || declared.has(c.name)) continue;
    if (CONTROL.has(c.name)) continue;
    // 可能是 DOM id 函数或误报——报告
    problems++;
    console.log(`⚠ ${f}:${c.line} 顶层调用 ${c.name}() 未在加载顺序内声明（可能来自后加载文件或 DOM API）`);
  }
  console.log(`${f}: 声明 ${decls.length} 个，顶层调用 ${calls.length} 个`);
}
console.log(problems ? `\n共 ${problems} 处可疑跨文件引用` : "\n✅ 无跨文件顶层引用问题");
