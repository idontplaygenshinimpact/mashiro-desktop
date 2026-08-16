// 静态检查：lib/routes/*.mjs 中使用的命名空间/标识符是否都有导入
// 检查对象：所有 import 语句 + 各文件体内出现的候选标识符
import { readFileSync, readdirSync } from "node:fs";

const candidates = [
  "jobsApi", "zhentiApi", "ojApi", "focusApi", "mailApi", "rssApi",
  "studyApi", "learningApi", "knowledgeApi", "ragApi", "reviewApi",
  "memory", "db", "config", "laneSubmit", "chatWithAgent",
  "readBody", "scanNewestFiles", "latestOutputs", "buildHealthPayload",
  "getLLMStats", "getRecentTools", "getPendingApprovals", "resolveApproval",
  "getSessionApproved", "pickEmotion", "EMOTIONS", "startInterview",
  "submitAnswer", "endInterview", "createCrawlMutex", "checkBearerAuth",
  "loadOrCreateToken",
];

let bad = 0;
for (const f of readdirSync("lib/routes").filter((x) => x.endsWith(".mjs"))) {
  const s = readFileSync(`lib/routes/${f}`, "utf8");
  const importNames = new Set();
  for (const im of s.matchAll(/import\s+(?:\*\s+as\s+(\w+)|\{([^}]+)\}|(\w+))\s+from/g)) {
    if (im[1]) importNames.add(im[1]);
    if (im[2]) for (const n of im[2].split(",")) importNames.add(n.trim().split(/\s+as\s+/).pop());
    if (im[3]) importNames.add(im[3]);
  }
  for (const c of candidates) {
    if (importNames.has(c)) continue; // 已导入
    const re = new RegExp(`(?<!\\.)\\b${c}\\b`, "g"); // 排除 xxxApi.属性 访问
    const hits = s.match(re);
    if (hits && hits.length > 0) {
      console.log(`${f}: 使用了 ${c}（${hits.length} 次）但未导入`);
      bad++;
    }
  }
}
console.log(bad ? `共 ${bad} 处问题` : "全部路由文件符号检查通过 ✓");
