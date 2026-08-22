// 导入 CodeTop 高频题 Top 400 到本地题库（challenges 表）
// 数据源：
//   1) CodeTop API https://codetop.cc/api/questions/?page=N&ordering=-frequency
//      字段：leetcode.frontend_question_id（题号）/title（中文题名）/level（1-3）/content（HTML 题目描述）
//           slug_title（LeetCode slug，用于拿 JS 函数签名）/value（大厂出现次数，归一化为频率）
//   2) LeetCode GraphQL https://leetcode.cn/graphql/（匿名）——每题的 JavaScript 函数签名
// 用法：node scripts/import-codetop-top400.mjs [--limit 400]
// 幂等：INSERT OR REPLACE（重复导入覆盖更新，不重复计数）
import { importChallengesData } from "../lib/ai-career.mjs";

const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || 400);
const CONCURRENCY = 8; // LeetCode 签名并发（避免触发限流）

// ---------- 1) CodeTop 拉题 ----------
const items = [];
for (let p = 1; items.length < LIMIT; p++) {
  const r = await fetch(`https://codetop.cc/api/questions/?page=${p}&ordering=-frequency`);
  if (!r.ok) throw new Error(`CodeTop page ${p} HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.list?.length) break;
  items.push(...j.list);
}
const list = items.slice(0, LIMIT);
console.log(`📦 CodeTop 拉到 ${items.length} 题，取前 ${list.length}`);

// ---------- 2) LeetCode JS 签名（并发 + 失败隔离） ----------
const slugSet = [...new Set(list.map((x) => x.leetcode.slug_title).filter(Boolean))];
const snippetCache = new Map(); // slug -> js snippet
let idx = 0;
async function worker() {
  while (idx < slugSet.length) {
    const slug = slugSet[idx++];
    if (snippetCache.has(slug)) continue;
    try {
      const r = await fetch("https://leetcode.cn/graphql/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        body: JSON.stringify({
          query: `query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { codeSnippets { langSlug code } } }`,
          variables: { titleSlug: slug },
        }),
      });
      const j = await r.json();
      const js = j?.data?.question?.codeSnippets?.find((s) => s.langSlug === "javascript");
      snippetCache.set(slug, js?.code || "");
    } catch {
      snippetCache.set(slug, ""); // 失败留空签名（不阻断导入）
    }
    await new Promise((r) => setTimeout(r, 120)); // 轻节流
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const withSnippet = [...snippetCache.values()].filter(Boolean).length;
console.log(`🔧 LeetCode JS 签名拿到 ${withSnippet}/${slugSet.length}`);

// ---------- 3) 转换 + 入库 ----------
const LEVEL_NAME = { 1: "简单", 2: "中等", 3: "困难" };
// 频率归一化：value 范围约 8~1185 → 1-5 档（对数压缩，前端按 frequency 排序展示热度）
const valueToFreq = (v) => Math.max(1, Math.min(5, Math.round(Math.log10(Number(v) || 1) * 2.2)));
const htmlToText = (html) => String(html || "")
  .replace(/<pre>[\s\S]*?<\/pre>/g, (m) => "\n【示例】" + m.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\n") // 示例保留为文本块
  .replace(/<[^>]+>/g, " ") // 其余标签去掉
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

const challenges = list.map((x) => {
  const lc = x.leetcode || {};
  const id = `codetop-${String(lc.frontend_question_id || "").padStart(4, "0")}`;
  const title = String(lc.title || `LeetCode ${lc.frontend_question_id}`).slice(0, 100);
  return {
    id,
    title,
    category: "algorithm",                       // CodeTop 全为算法题（沿用现有分类）
    difficulty: Number(lc.level) || 1,           // 1=简单 2=中等 3=困难
    frequency: valueToFreq(x.value),             // 大厂出现次数 → 1-5 热度档
    timeLimit: 15,                               // 算法题沙箱 15s（与 ai-career 默认一致）
    description: `${title}（CodeTop 高频 #${lc.frontend_question_id}，大厂出现 ${x.value} 次，难度：${LEVEL_NAME[lc.level] || "未知"}）\n\n${htmlToText(lc.content).slice(0, 4000)}`,
    skeleton: snippetCache.get(lc.slug_title) || `// 未获取到官方函数签名，请按题意自行实现\n// LeetCode #${lc.frontend_question_id} ${title}`,
    testCode: "",                                // 算法题无官方单测；练习走"写码 → 手动标记/答错回流复习卡"闭环
    source: "codetop",                           // 新数据源标记（与 ai-career 区分）
  };
});

const r = importChallengesData(challenges);
if (!r.ok) { console.error("❌ 导入失败:", r.error); process.exit(1); }
console.log(`✅ 已导入 ${r.imported} 道 CodeTop 题（幂等覆盖；source=codetop）`);
console.log(`   难度分布：简单 ${challenges.filter((c) => c.difficulty === 1).length} / 中等 ${challenges.filter((c) => c.difficulty === 2).length} / 困难 ${challenges.filter((c) => c.difficulty === 3).length}`);
console.log(`   签名覆盖：${withSnippet}/${list.length}`);
