// discover 模式：AI 逛牛客
// 用法: node discover.mjs [起始列表页URL] [要选的帖子数]
// 流程: 抓列表页 → 提取帖子链接 → AI 根据标题挑选最有价值的 N 篇 → 抓正文 → 分类 → 完整讲解 → 归档
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { fetchPage, fetchPages, closeBrowser } from "./lib/fetch-page.mjs";
import { classifyPage, solveQuestion, pickPosts, summarizeQiuzhao, detectQuestions } from "./lib/ai.mjs";

const DEFAULT_STARTS = [
  // ===== 牛客（前端/Agent 搜索） =====
  "https://www.nowcoder.com/discuss?type=2&query=%E5%89%8D%E7%AB%AF",
  "https://www.nowcoder.com/discuss?type=2&query=Agent",
  "https://www.nowcoder.com/discuss?type=2&query=%E5%89%8D%E7%AB%AF%20%E9%9D%A2%E7%BB%8F",
  // ===== 掘金（前端面经大户） =====
  "https://juejin.cn/search?query=%E5%89%8D%E7%AB%AF%E9%9D%A2%E7%BB%8F",
  "https://juejin.cn/search?query=Agent%20%E9%9D%A2%E7%BB%8F",
  // ===== CSDN（前端/AI 面经） =====
  "https://so.csdn.net/so/search?q=%E5%89%8D%E7%AB%AF%E9%9D%A2%E7%BB%8F",
  "https://so.csdn.net/so/search?q=Agent%20%E9%9D%A2%E7%BB%8F",
];
const TARGET_COUNT = 5; // 每个起始页挑几篇（多爬点：3→5）
// 重点方向：不限制岗位范围；笔试类优先，面经/招聘兼顾
const FOCUS = ["前端", "React", "Vue", "浏览器", "CSS", "JavaScript", "TypeScript", "全栈", "Agent", "AI应用", "大模型前端"];

// URL 规范 key（去 query/hash；牛客帖按 discuss id）
function keyOf(url) {
  const m = String(url || "").match(/\/discuss\/(\d+)/);
  if (m) return "discuss:" + m[1];
  return String(url || "").split("?")[0].split("#")[0];
}

// 加载历史已爬链接（all_links.md 全部行 + 记忆 seenUrls），用于跨次去重
function loadHistoryUrls() {
  const seen = new Set();
  try {
    const linksFile = path.join(config.outputDir, "all_links.md");
    if (existsSync(linksFile)) {
      for (const line of readFileSync(linksFile, "utf8").split("\n")) {
        const m = line.match(/^- (https?:\/\/\S+)/);
        if (m) seen.add(keyOf(m[1]));
      }
    }
  } catch { /* ignore */ }
  try {
    const memFile = path.join(import.meta.dirname, "data", "agent-memory.json");
    if (existsSync(memFile)) {
      const mem = JSON.parse(readFileSync(memFile, "utf8"));
      for (const u of mem.seenUrls || []) seen.add(keyOf(u));
    }
  } catch { /* ignore */ }
  return seen;
}

function dedupePosts(posts) {
  const seen = new Set();
  const out = [];
  for (const p of posts) {
    const key = keyOf(p.href);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}


// ===== 爬取进度上报（桌宠轮询展示） =====
const PROGRESS_FILE = "D:/mianshi-agent/progress.json";

function writeProgress(p) {
  try {
    writeFileSync(PROGRESS_FILE, JSON.stringify({ ...p, ts: Date.now() }), "utf8");
  } catch { /* ignore */ }
}

function clearProgress() {
  try { writeFileSync(PROGRESS_FILE, JSON.stringify({ status: "idle", ts: Date.now() }), "utf8"); } catch { /* ignore */ }
}

// 优雅退出时清进度
process.on("exit", () => clearProgress());
process.on("SIGINT", () => { clearProgress(); process.exit(0); });

// 各站点"内容帖"链接模式：牛客 /discuss/、掘金 /post/、CSDN /article/details/、知乎 /question/ 等
const POST_URL_RE =
  /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+)/;

function cleanHref(href) {
  // 去掉搜索跟踪参数（searchId 等），保留纯净链接
  return href
    .replace(/[?&]searchId=[^&]*/g, "")
    .replace(/[?&]ops_request_misc=[^&]*/g, "")
    .split("?")[0];
}

async function main() {
  const startUrls = (process.argv[2] ? process.argv[2].split(",") : DEFAULT_STARTS).filter(Boolean);
  const want = parseInt(process.argv[3] || String(TARGET_COUNT), 10);
  // 历史已爬链接（跨次去重：这次只爬新的）
  const history = loadHistoryUrls();
  console.log(`历史已爬链接 ${history.size} 条，本次只挑选新帖子`);
  writeProgress({ status: "running", step: "start", message: "开始爬取", current: 0, total: startUrls.length });

  // 每个起始页：抓列表 → AI 挑帖
  const allPicked = [];
  for (const startUrl of startUrls) {
    const si = startUrls.indexOf(startUrl) + 1;
    writeProgress({ status: "running", step: "list", message: "抓取列表页 " + si + "/" + startUrls.length, current: si, total: startUrls.length });
    console.log(`\n🔍 起始页: ${startUrl}\n抓取列表页...`);
    const list = await fetchPage(startUrl, { maxTextChars: 4000, collectLinks: true });
    if (!list || !list.text || list.length === 0) {
      console.error("列表页抓取失败:", list?.error || "无正文内容");
      continue;
    }

    // 提取帖子链接（通用模式），去重 + 清洗 + 过滤已爬过的
    const posts = dedupePosts(
      list.links
        .filter((l) => POST_URL_RE.test(l.href) && l.text.length > 5)
        .map((l) => ({ text: l.text.slice(0, 120), href: cleanHref(l.href) }))
    ).filter((p) => !history.has(keyOf(p.href)));
    console.log(`列表页发现 ${posts.length} 篇新帖子（过滤已爬 ${list.links.filter((l) => POST_URL_RE.test(l.href)).length - posts.length} 篇）`);
    if (posts.length === 0) {
      console.log("⏭️ 该页没有新帖子，跳过");
      continue;
    }

    // AI 挑选最有价值的帖子（按重点方向优先）
    const picked = await pickPosts(posts, want, FOCUS);
    writeProgress({ status: "running", step: "pick", message: "AI 挑选帖子（" + si + "/" + startUrls.length + "）", current: si, total: startUrls.length });
    console.log(`AI 选中 ${picked.length} 篇：`);
    picked.forEach((p, i) => console.log(`  ${i + 1}. [${p.reason?.slice(0, 30) || ""}] ${p.text.slice(0, 45)}`));
    allPicked.push(...picked.map((p) => ({ ...p, from: startUrl })));
  }

  if (allPicked.length === 0) {
    console.log("没有选中任何帖子。");
    await closeBrowser();
    return;
  }

  // 抓取选中的帖子（跨页去重）
  const seen = new Set();
  const unique = allPicked.filter((p) => {
    const id = p.href.match(/\/discuss\/(\d+)/)?.[1] || p.href;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  writeProgress({ status: "running", step: "fetch", message: "抓取正文（共 " + unique.length + " 篇）", current: 0, total: unique.length });
  const pages = await fetchPages(unique.map((p) => p.href));
  // 跳过无效页面（404/空内容）
  const okPages = pages.filter((p) => p.ok && !p.invalid && p.text && p.text.length > 100);
  console.log(`\n抓取成功 ${okPages.length}/${unique.length} 篇（跳过无效 ${pages.length - okPages.length}）`);

  // 分类 + 前端方向硬过滤 + 具体题目检测
  const items = [];
  const qiuItems = []; // 秋招情报类
  const GOOD_DIRS = ["frontend", "agent"];
  for (const p of okPages) {
    const cls = await classifyPage({ title: p.title, text: p.text });
    const dir = cls.direction || "other";
    console.log(`  [${cls.type}/${dir}] ${cls.company || "-"} | ${p.title.slice(0, 40)} | worth=${cls.worth}`);
    // 只保留前端/Agent 方向；其他方向（backend/embedded/algorithm）直接丢弃
    if (!GOOD_DIRS.includes(dir) || cls.worth < 40) {
      console.log(`    ⏭️ 跳过（非前端/Agent 方向）`);
      continue;
    }
    if (cls.type === "zhaopin") {
      qiuItems.push({ ...p, cls });
      continue;
    }
    // 具体题目检测：攻略文/流水账/时间分配类 → 跳过，只讲具体题
    const dq = await detectQuestions({ title: p.title, text: p.text });
    if (!dq.hasQuestion || !dq.questions?.length) {
      console.log(`    ⏭️ 跳过（无具体题目：${dq.reason || "攻略/流水账"}）`);
      continue;
    }
    items.push({ ...p, cls, questions: dq.questions.slice(0, 3) });
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(config.outputDir, `${date}_discover`);
  mkdirSync(outDir, { recursive: true });

  // 秋招情报速递（招聘类汇总）
  if (qiuItems.length > 0) {
    console.log(`\n=== 秋招情报整理（${qiuItems.length} 篇）===`);
    const infoParts = [`# 秋招情报速递 ${date}`, ""];
    for (const it of qiuItems) {
      console.log(`\n--- 情报: ${it.title.slice(0, 50)} ---`);
      try {
        const card = await summarizeQiuzhao({
          title: it.title,
          text: it.text,
          company: it.cls.company,
          sourceUrl: it.url,
        });
        infoParts.push(card, "\n---\n");
      } catch (e) {
        console.log(`  [情报失败] ${e.message}`);
      }
    }
    writeFileSync(path.join(outDir, "00_秋招情报速递.md"), infoParts.join("\n"), "utf8");
    console.log(`✅ 秋招情报速递: ${outDir}/00_秋招情报速递.md`);
  }

  if (items.length === 0) {
    console.log("没有值得讲解的帖子。");
    await closeBrowser();
    return;
  }

  console.log(`\n=== 完整讲解（${items.length} 篇）===`);
  const summary = [`# 秋招面经 AI 逛网合集 ${date}`, "", `起始: ${startUrls.join(" , ")}`, `共 ${items.length} 篇`, ""];

  for (const it of items) {
    const ii = items.indexOf(it) + 1;
    const questionText = it.questions?.length
      ? it.questions.map((q, qi) => `【题${qi + 1}】${q.question}`).join("\n")
      : it.text;
    writeProgress({ status: "running", step: "solve", message: "完整讲解 " + ii + "/" + items.length + "：" + it.title.slice(0, 20), current: ii, total: items.length });
    console.log(`\n--- 讲解中: ${it.title.slice(0, 50)} ---`);
    try {
      const md = await solveQuestion({
        title: it.title,
        text: questionText, // 只讲检测出的具体题目，不灌整篇攻略文
        company: it.cls.company,
        position: it.cls.position,
        sourceUrl: it.url,
      });
      const fname = `${String(items.indexOf(it) + 1).padStart(2, "0")}_${(it.cls.company || it.cls.type).replace(/[\\/:*?"<>|]/g, "_")}_${it.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 30)}.md`;
      writeFileSync(path.join(outDir, fname), `# ${it.title}\n\n> 来源: ${it.url}\n\n${md}\n`, "utf8");
      summary.push(`- [${it.cls.company || it.cls.type}] ${it.title} → ${fname}`);
    } catch (e) {
      console.log(`  [讲解失败] ${e.message}`);
      summary.push(`- [失败] ${it.title}: ${e.message}`);
    }
  }

  writeFileSync(path.join(outDir, "00_README.md"), summary.join("\n"), "utf8");
  try {
    appendFileSync(path.join(config.outputDir, "all_links.md"), `\n## ${date} (discover)\n` + okPages.map((p) => `- ${p.url}`).join("\n") + "\n", "utf8");
  } catch { /* ignore */ }
  // 标记本次已看（记忆模块 seenUrls，供 agent 侧去重参考）
  try {
    const { memory } = await import("./lib/memory.mjs");
    for (const p of okPages) memory.markSeen(p.url);
  } catch { /* ignore */ }

  writeProgress({ status: "done", step: "done", message: "爬取完成！共 " + items.length + " 篇讲解 + " + qiuItems.length + " 条情报", current: items.length, total: items.length, outDir });
  console.log(`\n✅ 完成！输出目录: ${outDir}`);
  await closeBrowser();
}

main().catch((e) => {
  console.error("运行出错:", e);
  process.exit(1);
});
