// 分析 panel.js 顶层直接执行的调用（行首非缩进的函数调用/赋值，决定拆分加载顺序）
import { readFileSync } from "node:fs";
const lines = readFileSync("desktop/renderer/panel.js", "utf8").split("\n");
const top = [];
lines.forEach((l, i) => {
  const t = l.trim();
  // 顶层：行首无缩进 或 2 空格缩进（顶层语句通常是 0 或 2 空格），排除函数体内
  const indent = l.length - l.trimStart().length;
  if (indent > 2) return;
  // 直接调用：xxx(...) 或 $("...").addEventListener / .forEach / setInterval 等
  if (/^[A-Za-z_$][\w$]*\(/.test(t) || /^\$\(/.test(t) || /^document\./.test(t) || /^window\./.test(t) || /^set(Interval|Timeout)\(/.test(t)) {
    top.push(`${i + 1}: ${t.slice(0, 75)}`);
  }
});
top.forEach((m) => console.log(m));
console.log(`\n共 ${top.length} 处顶层执行`);
