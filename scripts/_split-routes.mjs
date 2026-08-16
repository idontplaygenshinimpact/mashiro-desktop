// 纵向拆分辅助：按路由前缀从 widget.mjs 提取路由块 → 生成 lib/routes/<域>.mjs，并从 widget.mjs 删除
// 用法：node scripts/_split-routes.mjs jobs   （前缀：jobs/zhenti/focus/mail/rss）
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("widget.mjs", "utf8");
const lines = src.split(/\r?\n/);
const prefix = process.argv[2];
if (!prefix) { console.error("用法: node scripts/_split-routes.mjs <前缀>"); process.exit(1); }

// 找块：if (url.pathname === "/api/<prefix>... 或 /api/companies /api/resume-plan（jobs 域）
const matchRe = new RegExp(`if \\(url\\.pathname === "\\/api\\/${prefix}`);
const extra = prefix === "jobs" ? ['"/api/companies"', '"/api/resume-plan"'] : [];
const isStart = (l) => matchRe.test(l) || extra.some((e) => l.includes(`=== ${e}`));

const blocks = [];
for (let i = 0; i < lines.length; i++) {
  if (!isStart(lines[i])) continue;
  // 块结束：`    return;`（4 空格）+ `  }`（2 空格）——widget 路由统一模式；
  // 嵌套块（readBody 回调/GET 分支）的 return/} 缩进更深（6+/4 空格），不会误匹配
  let end = -1;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j] === "  }" && lines[j - 1] === "    return;") { end = j; break; }
  }
  if (end < 0) { console.error("块未闭合:", lines[i].trim().slice(0, 60)); continue; }
  blocks.push({ start: i, end, text: lines.slice(i, end + 1).join("\n") });
  i = end;
}
console.log(`找到 ${blocks.length} 个 ${prefix} 块`);

// 生成域文件
const header = `// ${prefix} 域路由（纵向拆分：/api/${prefix}* 从 widget.mjs 迁出）
import { readBody } from "../widget-core.mjs";
import * as jobsApi from "../jobs.mjs";
import * as zhentiApi from "../zhenti.mjs";
import * as ojApi from "../oj.mjs";
import * as focusApi from "../focus.mjs";
import * as mailApi from "../mail.mjs";
import * as rssApi from "../rss.mjs";
import { memory } from "../memory.mjs";

export function register${prefix[0].toUpperCase() + prefix.slice(1)}Routes(router, { getCorsOrigin = () => "*" } = {}) {
  const PORT = Number(process.env.MIANSHI_PORT) || 8899;
  const sseHeaders = (req) => ({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": getCorsOrigin(req),
  });
`;
let body = blocks.map((b) => {
  let t = b.text;
  // 去掉外层 if 缩进（每行前 2 空格）并包成 router.route
  const inner = t.split("\n").map((l) => l.slice(2)).join("\n");
  // 分段解析：head（path + 可选 method）+ tail（return; }），绕开复杂正则的组合问题
  const headM = inner.match(/^if \(url\.pathname === "([^"]+)"\)(?: && req\.method === "([A-Z]+)")? \{\n/);
  if (!headM || !inner.endsWith("\n  return;\n}")) {
    console.error("块解析失败:", inner.slice(0, 80));
    return "";
  }
  const path = headM[1];
  const method = headM[2] || null;
  const handler = inner.slice(headM[0].length, inner.length - "\n  return;\n}".length);
  // corsOrigin → getCorsOrigin(req)
  const h2 = handler.split("\n").map((l) => l.includes('"Access-Control-Allow-Origin": corsOrigin,') ? l.replace('corsOrigin', 'getCorsOrigin(req)') : l).join("\n");
  const route = method ? `router.route("${path}", "${method}", (req, res) => {${h2}\n  });`
                      : `router.route("${path}", (req, res) => {${h2}\n  });`;
  return route;
}).join("\n");
const footer = `}
`;
writeFileSync(`lib/routes/${prefix}.mjs`, header + body + footer, "utf8");
console.log(`已生成 lib/routes/${prefix}.mjs（${body.split("\n").length} 行）`);

// 从 widget.mjs 删除块（倒序删避免行号偏移）
const removeIdx = blocks.map((b) => [b.start, b.end]);
for (const [s, e] of removeIdx.reverse()) {
  // 删除块 + 块前的空行（若块前有空行）
  let s2 = s;
  while (s2 > 0 && lines[s2 - 1].trim() === "") s2--;
  lines.splice(s2, e - s2 + 1);
}
writeFileSync("widget.mjs", lines.join("\n"), "utf8");
console.log(`widget.mjs 剩余 ${lines.length} 行`);
