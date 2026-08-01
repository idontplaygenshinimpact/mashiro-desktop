// mianshi-agent 主入口
// 用法: node run.mjs [links.txt路径]
// 流程: 读链接 → Playwright 抓取 → AI 分类 → 值得解的题完整讲解 → 按公司归档 Markdown
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { fetchPages, closeBrowser } from "./lib/fetch-page.mjs";
import { classifyPage, solveQuestion } from "./lib/ai.mjs";

function readLinks(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && /^https?:\/\//.test(l));
}

function sanitize(name) {
  return String(name || "未分类").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
}

async function main() {
  const linksFile = process.argv[2] || config.linksFile;
  const urls = readLinks(linksFile);
  if (urls.length === 0) {
    console.log(`没有找到链接。请把 URL 逐行写入 ${linksFile}（# 开头为注释）`);
    return;
  }
  console.log(`共 ${urls.length} 个链接，开始抓取...`);

  const pages = await fetchPages(urls);
  const okPages = pages.filter((p) => p.ok);
  const failPages = pages.filter((p) => !p.ok);
  for (const f of failPages) console.log(`  [抓取失败] ${f.url}: ${f.error}`);

  // 分类
  console.log("\n=== AI 分类 ===");
  const items = [];
  for (const p of okPages) {
    const cls = await classifyPage({ title: p.title, text: p.text });
    console.log(`  [${cls.type}] ${cls.company || "-"} | ${p.title.slice(0, 40)} | worth=${cls.worth}`);
    if (cls.type !== "other" && cls.worth >= 40) {
      items.push({ ...p, cls });
    }
  }
  if (items.length === 0) {
    console.log("没有值得处理的页面。");
    await closeBrowser();
    return;
  }

  // 讲解
  console.log(`\n=== 完整讲解（${items.length} 篇，每篇约 1-3 分钟）===`);
  const date = new Date().toISOString().slice(0, 10);
  const outDir = path.join(config.outputDir, date);
  mkdirSync(outDir, { recursive: true });
  const summary = [`# 秋招面经+笔试讲解合集 ${date}`, "", `共 ${items.length} 篇`, ""];

  for (const it of items) {
    console.log(`\n--- 讲解中: ${it.title.slice(0, 50)} ---`);
    try {
      const md = await solveQuestion({
        title: it.title,
        text: it.text,
        company: it.cls.company,
        position: it.cls.position,
        sourceUrl: it.url,
      });
      const fname = `${String(items.indexOf(it) + 1).padStart(2, "0")}_${sanitize(it.cls.company || it.cls.type)}_${sanitize(it.title).slice(0, 30)}.md`;
      writeFileSync(path.join(outDir, fname), `# ${it.title}\n\n> 来源: ${it.url}\n\n${md}\n`, "utf8");
      summary.push(`- [${it.cls.company || it.cls.type}] ${it.title} → ${fname}`);
    } catch (e) {
      console.log(`  [讲解失败] ${e.message}`);
      summary.push(`- [失败] ${it.title}: ${e.message}`);
    }
  }

  writeFileSync(path.join(outDir, "00_README.md"), summary.join("\n"), "utf8");
  try {
    appendFileSync(
      path.join(config.outputDir, "all_links.md"),
      `\n## ${date}\n` + okPages.map((p) => `- ${p.url}`).join("\n") + "\n",
      "utf8"
    );
  } catch { /* ignore */ }

  console.log(`\n✅ 完成！输出目录: ${outDir}`);
  await closeBrowser();
}

main().catch((e) => {
  console.error("运行出错:", e);
  process.exit(1);
});
