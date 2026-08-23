// discover 模式：AI 逛牛客（管线化：阶段显式、可观测、可测试）
// 用法: node discover.mjs [起始列表页URL] [要选的帖子数]
// 流程管线: init → collect_posts → fetch_pages → classify → solve → finalize
// 每个阶段是独立函数（导出供测试），中间产物在 ctx 传递；非 fatal 阶段失败不中断
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { config } from "./config.mjs";
import { fetchPage, fetchPages, closeBrowser } from "./lib/fetch-page.mjs";
import { classifyPage, solveQuestion, pickPosts, summarizeQiuzhao, detectQuestions } from "./lib/ai.mjs";
import { runPipeline, pipelineSummary } from "./lib/pipeline.mjs";

const DEFAULT_STARTS = [
  // ===== 拼多多（PDD）笔试/面经专项——用户近期参加 =====
  "https://www.nowcoder.com/discuss?type=2&query=%E6%8B%BC%E5%A4%9A%E5%A4%9A%20%E7%AC%94%E8%AF%95",
  "https://www.nowcoder.com/discuss?type=2&query=%E6%8B%BC%E5%A4%9A%E5%A4%9A%20%E5%89%8D%E7%AB%AF",
  "https://www.nowcoder.com/discuss?type=2&query=PDD%20%E7%AC%94%E8%AF%95",
  "https://juejin.cn/search?query=%E6%8B%BC%E5%A4%9A%E5%A4%9A%20%E7%AC%94%E8%AF%95",
  "https://so.csdn.net/so/search?q=%E6%8B%BC%E5%A4%9A%E5%A4%9A%20%E7%AC%94%E8%AF%95",
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
  // ===== 思否 SegmentFault（服务端渲染，面经汇总多，实测稳定可抓） =====
  "https://segmentfault.com/search?q=%E5%89%8D%E7%AB%AF%E9%9D%A2%E7%BB%8F",
  "https://segmentfault.com/search?q=Agent%20%E9%9D%A2%E7%BB%8F",
];
const TARGET_COUNT = 5; // 每个起始页挑几篇（多爬点：3→5）
// 重点方向：不限制岗位范围；笔试类优先，面经/招聘兼顾
const FOCUS = ["前端", "React", "Vue", "浏览器", "CSS", "JavaScript", "TypeScript", "全栈", "Agent", "AI应用", "大模型前端"];

// URL 规范 key（去 query/hash；牛客帖按 discuss id）
export function keyOf(url) {
  const m = String(url || "").match(/\/discuss\/(\d+)/);
  if (m) return "discuss:" + m[1];
  return String(url || "").split("?")[0].split("#")[0];
}

// 加载历史已爬链接（all_links.md 全部行 + 记忆 seenUrls），用于跨次去重
export function loadHistoryUrls() {
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

export function dedupePosts(posts) {
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
const PROGRESS_FILE = path.join(import.meta.dirname, "progress.json");

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

// 各站点"内容帖"链接模式：牛客 /discuss/、掘金 /post/、CSDN /article/details/、知乎 /question/、
// 思否 /a/（面经汇总帖）、博客园 /p/（实测 zzk 搜索对 headless 反爬，保留模式备用）
const POST_URL_RE =
  /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+|segmentfault\.com\/a\/\d+|cnblogs\.com\/p\/\d+|zhihu\.com\/question\/\d+)/;

// 标题级方向过滤：嵌入式/硬件/算法/后端等非前端方向 + 简历/求职咨询/闲聊（列表页收集时就过滤，省 AI 挑帖额度）
const EXCLUDE_TITLE = /嵌入式|单片机|硬件|驱动|PCB|STM32|ESP32|ARM|芯片|FPGA|物联网|上位机|爬虫开发/;

function cleanHref(href) {
  // 去掉搜索跟踪参数（searchId 等），保留纯净链接
  return href
    .replace(/[?&]searchId=[^&]*/g, "")
    .replace(/[?&]ops_request_misc=[^&]*/g, "")
    .split("?")[0];
}

/**
 * 从掘金搜索 API 响应中提取帖子链接
 * 掘金搜索 API 响应结构（api.juejin.cn/search_api/v1/search）常见字段路径：
 *   resp.data[].result_model = "article" → result.article_info.{article_id, title}
 * 兼容不同版本的响应包裹结构
 */
function extractJuejinLinks(apiResponses) {
  const links = [];
  for (const resp of apiResponses) {
    const dataArr = resp?.data || resp?.result || [];
    const items = Array.isArray(dataArr) ? dataArr : (dataArr?.data || []);
    for (const item of items) {
      const resultObj = item?.result || item?.result_model || item;
      const articleInfo = resultObj?.article_info || resultObj || item;
      const articleId = articleInfo?.article_id;
      const title = articleInfo?.title || "";
      if (articleId && title) {
        links.push({
          text: String(title).slice(0, 120),
          href: `https://juejin.cn/post/${articleId}`,
        });
      }
    }
  }
  return links;
}

// ============ 管线阶段 ============

/** 阶段0：初始化 ctx（参数解析、历史加载、进度初始化） */
export async function initStage(ctx) {
  ctx.startUrls = (process.argv[2] ? process.argv[2].split(",") : DEFAULT_STARTS).filter(Boolean);
  ctx.want = parseInt(process.argv[3] || String(TARGET_COUNT), 10);
  ctx.history = loadHistoryUrls();
  console.log(`历史已爬链接 ${ctx.history.size} 条，本次只挑选新帖子`);
  writeProgress({ status: "running", step: "start", message: "开始爬取", current: 0, total: ctx.startUrls.length });
}

/** 阶段1：遍历起始页抓列表 → 提取/去重/过滤 → AI 挑帖（列表页 3 并发，提速不增加风控面） */
export async function collectPostsStage(ctx) {
  const { startUrls, want, history } = ctx;
  const allPicked = [];
  const CONCURRENCY = 3;
  let idx = 0;
  const processOne = async () => {
    while (idx < startUrls.length) {
      const si = idx + 1;
      const startUrl = startUrls[idx++];
      writeProgress({ status: "running", step: "list", message: "抓取列表页 " + si + "/" + startUrls.length, current: si, total: startUrls.length });
      console.log(`\n🔍 起始页(${si}/${startUrls.length}): ${startUrl}\n抓取列表页...`);

      // 掘金搜索页：SPA 渲染，用 apiPattern 拦截搜索 XHR API + 延长等待
      const isJuejinSearch = startUrl.includes("juejin.cn/search");
      const listOpts = { maxTextChars: 4000, collectLinks: true };
      if (isJuejinSearch) {
        listOpts.waitUntil = "networkidle";
        listOpts.waitMs = 4000;
        listOpts.apiPattern = "api.juejin.cn/search_api";
      }

      // 修复：单起始页 fetchPage 抛错不再杀整个 collect_posts 阶段——
      // 包 try/catch，失败 console.error 后 continue 处理下一个起始页
      let list;
      try {
        list = await fetchPage(startUrl, listOpts);
      } catch (e) {
        console.error("列表页抓取失败:", String(e?.message || e).slice(0, 120));
        continue;
      }
      // fetchPage 返回结构确认：单页路径无 ok 字段，失败态用 invalid:true 标记
      // （安全验证页/404）；空正文也视为失败
      if (!list || list.invalid || (!list.text && list.length === 0)) {
        console.error("列表页抓取失败:", list?.invalid ? "无效页面（安全验证/404）" : "无正文内容");
        continue;
      }

      // 掘金搜索：若 DOM 链接为空但 API 响应有数据，从 API 响应提取链接
      let allLinks = list.links;
      if (isJuejinSearch && allLinks.length === 0 && list.apiResponses?.length) {
        const apiLinks = extractJuejinLinks(list.apiResponses);
        if (apiLinks.length > 0) {
          console.log(`  掘金 API 拦截成功，提取 ${apiLinks.length} 条链接`);
          allLinks = apiLinks;
        }
      }

      // 提取帖子链接（通用模式），去重 + 清洗 + 过滤已爬过的 + 标题方向过滤
      const posts = dedupePosts(
        allLinks
          .filter((l) => POST_URL_RE.test(l.href) && l.text.length > 5 && !EXCLUDE_TITLE.test(l.text))
          .map((l) => ({ text: l.text.slice(0, 120), href: cleanHref(l.href) }))
      ).filter((p) => !history.has(keyOf(p.href)));
      console.log(`列表页发现 ${posts.length} 篇新帖子（过滤已爬 ${allLinks.filter((l) => POST_URL_RE.test(l.href)).length - posts.length} 篇）`);
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
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, startUrls.length) }, processOne));
  ctx.allPicked = allPicked;
}

/** 阶段2：抓取选中帖子的正文（跨页去重 + 无效页过滤）
 *  牛客链接走 Edge 登录态会话（复用真实浏览器登录态），其他域走原 headless 逻辑 */
export async function fetchPagesStage(ctx) {
  const { allPicked } = ctx;
  if (!allPicked?.length) return;
  const seen = new Set();
  const unique = allPicked.filter((p) => {
    const id = p.href.match(/\/discuss\/(\d+)/)?.[1] || p.href;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  ctx.unique = unique;
  writeProgress({ status: "running", step: "fetch", message: "抓取正文（共 " + unique.length + " 篇）", current: 0, total: unique.length });

  // 分流：牛客 → Edge 会话；其他 → 原 headless
  const nowcoderUrls = unique.filter((p) => p.href.includes("nowcoder.com"));
  const otherUrls = unique.filter((p) => !p.href.includes("nowcoder.com"));
  const pages = [];

  // 牛客链接走 Edge 登录态
  if (nowcoderUrls.length > 0) {
    let edgeSession = null;
    try {
      const { getEdgeSession } = await import("./lib/edge-session.mjs");
      edgeSession = await getEdgeSession();
    } catch (e) {
      console.log(`[Edge 会话] 加载失败: ${e.message}，降级到 headless`);
    }

    if (edgeSession?.ok) {
      for (const url of nowcoderUrls.map((p) => p.href)) {
        try {
          const r = await edgeSession.fetchWithEdge(url);
          pages.push({ ok: true, ...r });
          console.log(`  [Edge] ${r.title?.slice(0, 40) || url.slice(0, 50)} | ${r.length} 字符${r.invalid ? " (无效)" : ""}`);
        } catch (e) {
          console.log(`  [Edge 失败] ${url.slice(0, 50)}: ${e.message} → 降级 headless`);
          // 降级回原 fetchPage
          try {
            const r = await fetchPage(url);
            pages.push({ ok: true, ...r });
          } catch (e2) {
            pages.push({ ok: false, url, error: e2.message });
          }
        }
        await new Promise((r) => setTimeout(r, 800)); // 串行+延迟（避免触发牛客风控）
      }
    } else {
      console.log(`[Edge 会话] 不可用（${edgeSession?.reason || "未知"}），牛客链接降级到 headless`);
      const regular = await fetchPages(nowcoderUrls.map((p) => p.href));
      pages.push(...regular);
    }
  }

  // 其他域走原逻辑
  if (otherUrls.length > 0) {
    const regular = await fetchPages(otherUrls.map((p) => p.href));
    pages.push(...regular);
  }

  // 跳过无效页面（404/空内容/安全验证页）
  const okPages = pages.filter((p) => p.ok && !p.invalid && p.text && p.text.length > 100);
  console.log(`\n抓取成功 ${okPages.length}/${unique.length} 篇（跳过无效 ${pages.length - okPages.length}）`);
  ctx.okPages = okPages;
}

/** 阶段3：分类 + 前端方向硬过滤 + 具体题目检测（zhaopin 分流到情报）；LLM 步骤 3 并发提速 */
export async function classifyStage(ctx) {
  const { okPages = [] } = ctx;
  const items = [];
  const qiuItems = []; // 秋招情报类
  const GOOD_DIRS = ["frontend", "agent"];
  const CONCURRENCY = 3;
  let idx = 0;
  const results = []; // 顺序保留（按 okPages 下标）
  const processOne = async () => {
    while (idx < okPages.length) {
      const i = idx++;
      const p = okPages[i];
      const rec = { p, item: null, qiu: null, log: "" };
      try {
        const cls = await classifyPage({ title: p.title, text: p.text });
        const dir = cls.direction || "other";
        rec.log = `  [${cls.type}/${dir}] ${cls.company || "-"} | ${p.title.slice(0, 40)} | worth=${cls.worth}`;
        // 只保留前端/Agent 方向；其他方向（backend/embedded/algorithm）直接丢弃
        if (!GOOD_DIRS.includes(dir) || cls.worth < 40) {
          rec.log += `\n    ⏭️ 跳过（非前端/Agent 方向）`;
        } else if (cls.type === "zhaopin") {
          rec.qiu = { ...p, cls };
        } else {
          // 具体题目检测：攻略文/流水账/时间分配类 → 跳过，只讲具体题
          const dq = await detectQuestions({ title: p.title, text: p.text });
          if (!dq.hasQuestion || !dq.questions?.length) {
            rec.log += `\n    ⏭️ 跳过（无具体题目：${dq.reason || "攻略/流水账"}）`;
          } else {
            rec.item = { ...p, cls, questions: dq.questions.slice(0, 3) };
          }
        }
      } catch (e) {
        rec.log += `\n    ⚠️ 分类异常: ${String(e.message || e).slice(0, 80)}`;
      }
      results[i] = rec;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, okPages.length) }, processOne));
  for (const rec of results) {
    if (rec.log) console.log(rec.log);
    if (rec.item) items.push(rec.item);
    if (rec.qiu) qiuItems.push(rec.qiu);
  }
  ctx.items = items;
  ctx.qiuItems = qiuItems;
}

/** 阶段4：秋招情报整理 + 完整讲解 → 写产出文件 */
export async function solveStage(ctx) {
  const { items = [], qiuItems = [], startUrls = [] } = ctx;
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(config.outputDir, `${date}_discover`);
  mkdirSync(outDir, { recursive: true });
  ctx.date = date;
  ctx.outDir = outDir;

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
    ctx.summary = [];
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
  ctx.summary = summary;
}

/** 阶段5：收尾（README / all_links / 记忆标记 / 进度完成） */
export async function finalizeStage(ctx) {
  const { okPages = [], items = [], qiuItems = [], date, outDir, summary = [] } = ctx;
  if (date && outDir) {
    writeFileSync(path.join(outDir, "00_README.md"), summary.join("\n"), "utf8");
    try {
      appendFileSync(path.join(config.outputDir, "all_links.md"), `\n## ${date} (discover)\n` + okPages.map((p) => `- ${p.url}`).join("\n") + "\n", "utf8");
    } catch { /* ignore */ }
  }
  // 标记本次已看（记忆模块 seenUrls，供 agent 侧去重参考）
  try {
    const { memory } = await import("./lib/memory.mjs");
    for (const p of okPages) memory.markSeen(p.url);
  } catch { /* ignore */ }

  writeProgress({ status: "done", step: "done", message: "爬取完成！共 " + items.length + " 篇讲解 + " + qiuItems.length + " 条情报", current: items.length, total: items.length, outDir });
  if (outDir) console.log(`\n✅ 完成！输出目录: ${outDir}`);
}

/** 管线定义（导出供测试/复用） */
export const PIPELINE = [
  { name: "init", run: initStage, fatal: true },
  { name: "collect_posts", run: collectPostsStage },
  { name: "fetch_pages", run: fetchPagesStage },
  { name: "classify", run: classifyStage },
  { name: "solve", run: solveStage },
  { name: "finalize", run: finalizeStage },
];

/** 入口：组装管线执行 */
export async function main() {
  const ctx = {};
  await runPipeline(PIPELINE, ctx, {
    onStage: (name, c, ms) => console.log(`\n[阶段 ${name}] 完成（${(ms / 1000).toFixed(1)}s）`),
  });
  console.log("\n" + pipelineSummary(ctx));
  await closeBrowser();
}

// 仅 CLI 直接运行时执行（测试 import 时跳过）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("运行出错:", e);
    process.exit(1);
  });
}
