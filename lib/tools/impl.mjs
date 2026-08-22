// lib/tools/impl.mjs —— 工具实现（纵向拆分：从 lib/agent.mjs 迁出）
// 每个工具函数只依赖 lib 外部模块（memory/ai/fetch-page/career/study/...），
// 由 lib/agent.mjs 的 executeTool 分发调用；结果回填由 agent 统一处理
import { config } from "../../config.mjs";
import { fetchPage, assertPublicUrl } from "../fetch-page.mjs";
import { solveQuestion, detectQuestions } from "../ai.mjs";
import { memory } from "../memory.mjs";
import { wrapUntrusted } from "../prompt-guard.mjs";
import { getCareerProfile } from "../career.mjs";

export async function toolDetectQuestions({ title, text }) {
  const r = await detectQuestions({ title, text });
  memory.markSeen(title); // 记录已处理
  // 提取的题目来自外部页面，包裹为不可信数据（防恶意页面注入持久化到后续轮次）
  if (r?.questions?.length) {
    r.questions = r.questions.map((q) => ({ ...q, question: wrapUntrusted(q.question) }));
  }
  return r;
}

export async function toolGetStudyPlan() {
  try {
    const { getPlan } = await import("../study.mjs");
    const plan = getPlan();
    const items = (plan.items || []).map((i) => ({
      topic: i.topic,
      done: !!i.done,
      reviewed: !!i.reviewed,
      why: i.why,
    }));
    return { items, hint: "面试前可优先考察未完成项" };
  } catch (e) {
    return { error: e.message };
  }
}

/** 对话 → 学习清单反哺：把知识点加入清单（闭环：用户说"想学 X/提升 Y"时调用） */
export async function toolAddStudyItems({ items }) {
  try {
    const { addPlanItems } = await import("../study.mjs");
    const clean = (items || [])
      .map((it) => ({
        topic: String(it?.topic || "").trim(),
        why: String(it?.why || "").trim() || "对话中用户提出想学",
        verify_question: String(it?.verify_question || "").trim(),
        level: ["必会", "进阶", "拓展"].includes(it?.level) ? it.level : "必会",
        group: String(it?.group || "").trim() || undefined,
        fromInterview: false, // 对话添加非面试来源
      }))
      .filter((it) => it.topic);
    if (!clean.length) return { ok: false, error: "没有有效的知识点（topic 必填）" };
    const r = addPlanItems(clean);
    return {
      ok: true,
      added: r.added || 0,
      topics: clean.map((it) => it.topic),
      hint: "已加入学习清单，可让用户去面板查看；后续可讲解/复盘/面试考察",
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** 对话 → 复习卡：为用户建 FSRS 间隔复习卡（到期提醒） */
export async function toolCreateReviewCard({ topic, question, answer }) {
  try {
    const { review } = await import("../review.mjs");
    const t = String(topic || "").trim();
    if (!t) return { ok: false, error: "topic 必填" };
    const q = String(question || "").trim() || `请完整讲讲：${t}`;
    review.addCard({
      topic: t,
      question: q,
      answer: String(answer || "").slice(0, 500),
      source: "对话",
    });
    return { ok: true, topic: t, hint: "已建复习卡（FSRS 间隔复习，到期自动提醒）" };
  } catch (e) {
    return { error: e.message };
  }
}

export async function toolGetRecentOutputs() {
  try {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const outDir = path.join(config.outputDir);
    const files = [];
    const walk = (dir, depth = 0) => {
      if (depth > 3) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".md") && !e.name.startsWith("00_")) {
          try { const st = statSync(p); if (st.size > 300 && st.size < 50000) files.push(p); } catch { /* ignore */ }
        }
      }
    };
    walk(outDir);
    files.sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime());
    const latest = files.slice(0, 5).map((f) => {
      const c = readFileSync(f, "utf8");
      const title = path.basename(f).replace(/\.md$/, "").slice(0, 40);
      // 提取 ## 标题作为知识点线索
      const heads = [...c.matchAll(/^#{2,3}\s+(.+)$/gm)].slice(0, 6).map((m) => m[1].trim());
      return { file: title, topics: heads, preview: c.slice(0, 300) };
    });
    return { outputs: latest, hint: "这些是最近爬取的面经/题目，出题可参考真实考点" };
  } catch (e) {
    return { error: e.message };
  }
}

export async function toolRecordInterviewTopics(topics, company) {
  const added = [], existing = [], skipped = [];
  for (const t of (topics || []).slice(0, 8)) {
    const rawTopic = String(t || "").trim().slice(0, 40);
    if (!rawTopic) continue;
    // 伪知识点过滤 + 规范化（用清洗后的 topic，保证与薄弱点口径一致）
    const topic = memory._cleanTopic ? memory._cleanTopic(rawTopic) : rawTopic;
    if (!topic) { skipped.push({ topic: rawTopic, reason: "非具体知识点" }); continue; }
    try {
      const { addPlanItems } = await import("../study.mjs");
      const r = addPlanItems([{
        topic,
        why: "真实面试中被问住，需优先补强",
        source: company ? `面试实录(${company})` : "面试实录",
        verify_question: `请完整回答并讲清原理：${topic}`,
        level: "必会",
      }]);
      if (r.added > 0) {
        added.push(topic);
        // 自动建复习卡
        try {
          const { review } = await import("../review.mjs");
          review.addCard({ topic, question: `请完整回答并讲清原理：${topic}`, answer: "", source: "面试实录" });
        } catch { /* ignore */ }
      } else {
        existing.push(topic);
      }
    } catch (e) {
      skipped.push({ topic, reason: e.message });
    }
  }
  return {
    ok: true,
    added, existing, skipped,
    hint: `已把 ${added.length} 个知识点加入学习清单（必会），可在面板「📋 学习清单」点「💡 讲解」生成详细讲解`,
  };
}

export async function toolSearchPosts(query, site = "auto") {
  const searchUrls = {
    nowcoder: `https://www.nowcoder.com/discuss?type=2&query=${encodeURIComponent(query)}`,
    juejin: `https://juejin.cn/search?query=${encodeURIComponent(query)}`,
    csdn: `https://so.csdn.net/so/search?q=${encodeURIComponent(query)}`,
    // Bing 作为面经站的搜索引擎入口：搜索词带面经关键词，结果按面经站白名单过滤
    bing: `https://cn.bing.com/search?q=${encodeURIComponent(query + " 面经 面试题 笔试")}`,
  };
  // auto = 牛客 + 掘金(API) + Bing（掘金搜索页是 SPA，走 API 拦截绕过风控；Bing 通用兜底）
  const sites = site === "auto" ? ["nowcoder", "juejin", "bing"] : [site];
  const re = /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+)/;
  // 标题级方向过滤：方向排除词来自方向画像 ignoreNote（转方向/开源自动跟随）+ 与方向无关的噪音词（保留）
  const profile = getCareerProfile();
  const noiseRe = /嵌入式|单片机|硬件|驱动|PCB|STM32|ESP32|ARM|芯片|FPGA|物联网|上位机|爬虫开发|知乎|百度知道|CSDN博客-搜索/;
  const ignoreWords = String(profile.ignoreNote || "")
    .split(/[/、,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/[（()）]/.test(s));
  const dirRe = ignoreWords.length
    ? new RegExp(ignoreWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
    : null;
  const EXCLUDE_TITLE = dirRe ? new RegExp(`${noiseRe.source}|${dirRe.source}`, "i") : noiseRe;
  // 并行抓取所有站
  const results = await Promise.all(
    sites.map(async (s) => {
      try {
        if (s === "juejin") {
          // 掘金：真实浏览器打开搜索页 → 拦截 search_api 响应（绕过 API 风控）
          const page = await fetchPage(searchUrls.juejin, {
            maxTextChars: 800, collectLinks: false,
            waitSelector: ".search-result, .search-title, .result-content",
            apiPattern: "search_api/v1/search",
          });
          const articles = [];
          for (const j of page.apiResponses || []) {
            for (const d of j?.data || []) {
              const info = d?.result_model?.article_info || {};
              if (info?.article_id) {
                const t = String(info.title || "").replace(/<[^>]+>/g, "").trim();
                articles.push({ title: t.slice(0, 80), url: `https://juejin.cn/post/${info.article_id}`, site: "juejin", ctime: Number(info.ctime || 0) });
              }
            }
          }
          // 按发布时间降序：近一年优先（2026 秋招看新帖），不足用旧的补齐
          articles.sort((a, b) => b.ctime - a.ctime);
          const cutoff = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
          const recent = articles.filter((a) => a.ctime >= cutoff);
          const older = articles.filter((a) => a.ctime < cutoff);
          return [...recent, ...older].slice(0, 6).map(({ ctime: _ctime, ...p }) => p);
        }
        const page = await fetchPage(searchUrls[s], { maxTextChars: 2000, collectLinks: true, waitUntil: "networkidle" });
        if (s === "bing") {
          // Bing：面经站白名单过滤（官网/百科/教程/字典站自然滤掉）
          const MIANJING_HOSTS = /nowcoder\.com\/discuss|juejin\.cn\/post|blog\.csdn\.net\/[^/]+\/article|zhihu\.com|cnblogs\.com\/[^/]+\/p\/|segmentfault\.com\/a\/|my\.oschina\.net|blog\.51cto\.com|yuque\.com\/[^/]+\/|mp\.weixin\.qq\.com\/s\?/;
          return (page.links || [])
            .filter((l) => MIANJING_HOSTS.test(l.href) && l.text.length > 5 && !EXCLUDE_TITLE.test(l.text))
            .slice(0, 8)
            .map((l) => ({ title: l.text.slice(0, 80), url: l.href.split("?")[0], site: "bing" }));
        }
        return page.links
          .filter((l) => re.test(l.href) && l.text.length > 5 && !EXCLUDE_TITLE.test(l.text))
          .slice(0, 6)
          .map((l) => ({ title: l.text.slice(0, 80), url: l.href.replace(/[?&]searchId=[^&]*/g, "").split("?")[0], site: s }));
      } catch (e) {
        return [{ error: `${s} 搜索失败: ${e.message}` }];
      }
    })
  );
  // 合并 + 双重去重（URL 去重 + 标题归一化去重，跨源同帖只留一条；排除已看过的）
  const all = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  for (const list of results) {
    for (const p of list) {
      if (p.error) { all.push(p); continue; }
      if (seenUrl.has(p.url)) continue;
      seenUrl.add(p.url);
      // 标题归一化去重：去括号内容（转载/已过/精华等后缀）+ 空白/标点后比较
      // （牛客/掘金转载同帖标题带"（转载）"等差异，不剥离会重复收录）
      const titleKey = String(p.title)
        .replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "")
        .replace(/[\s，。！？、：:""''（）()\-—_]+/g, "")
        .slice(0, 20);
      if (seenTitle.has(titleKey)) continue;
      seenTitle.add(titleKey);
      if (memory.isSeen(p.url)) continue;   // 已看过的跳过
      all.push(p);
    }
  }
  // 相关性排序：标题含 query 核心词的排前（牛客等搜索引擎相关性弱）
  const coreWord = String(query).split(/\s+/)[0]?.slice(0, 6) || "";
  all.sort((a, b) => {
    const sa = coreWord && a.title.includes(coreWord) ? 1 : 0;
    const sb = coreWord && b.title.includes(coreWord) ? 1 : 0;
    return sb - sa;
  });
  // AI 挑帖：从候选里挑与 query 相关的技术面经/笔试（排除求职咨询/闲聊/泛泛内容）
  // 候选少时直接返回；多时用 LLM 判断，避免关键词穷举
  if (all.length > 4) {
    try {
      const { pickPosts } = await import("../ai.mjs");
      const picked = await pickPosts(all.map((p) => ({ text: p.title, href: p.url })), Math.min(6, all.length), [query]);
      if (picked?.length) {
        const pickedUrls = new Set(picked.map((p) => p.href));
        return { results: all.filter((p) => pickedUrls.has(p.url)).slice(0, 6) };
      }
    } catch { /* 挑帖失败则保留过滤后的结果 */ }
  }
  return { results: all.slice(0, 12) };
}

export async function toolFetchPage(url) {
  const raw = String(url || "").trim();
  // SSRF 防护：只允许公网 http(s) URL；拒绝内网/环回/云元数据/文件协议（防被恶意页面或注入引导访问内网）
  if (!/^https?:\/\//i.test(raw)) return { error: "仅支持 http/https 链接", title: "" };
  try {
    // 硬化 SSRF 校验：URL 归一化（十进制/十六进制/八进制 IP、尾点、IPv6 映射）+ DNS 解析（防 DNS-rebinding）
    // fetch-page.mjs 内部还有第二道强制守卫（唯一 choke point），此处早退只为给 LLM 干净的错误回填
    await assertPublicUrl(raw);
  } catch (e) {
    return { error: e.message || "URL 无效", title: "" };
  }
  const isJuejin = /juejin\.cn\/post/.test(raw);
  const page = await fetchPage(raw, {
    maxTextChars: 8000,
    waitUntil: isJuejin ? "networkidle" : "domcontentloaded",
    waitSelector: isJuejin ? ".article-content, .markdown-body, article" : null,
  });
  memory.markSeen(raw);
  if (page.invalid || !page.text) return { error: "页面无效（404/内容为空）", title: page.title };
  // 提示注入防护：外部页面内容视为不可信数据（包裹标记，防恶意页面劫持 LLM）——标题同样包裹
  try {
    const { detectInjection } = await import("../prompt-guard.mjs");
    const injections = detectInjection(page.text);
    return {
      title: wrapUntrusted(page.title),
      text: wrapUntrusted(page.text.slice(0, 6000)),
      _injectionWarning: injections.length
        ? `⚠️ 页面内容检测到疑似提示注入（${injections.map((i) => i.name).join("、")}），内容已隔离为不可信数据`
        : undefined,
    };
  } catch {
    return { title: wrapUntrusted(page.title), text: wrapUntrusted(page.text.slice(0, 6000)) };
  }
}

export async function toolGetMemoryExpanded() {
  // 基础画像（关注点/薄弱点/目标）
  const base = {
    profile: memory.getProfileSummary(),
    interests: memory.getInterests(),
    mastered: memory.getMastered().slice(-10),
  };
  // 顺带带出关键个人数据（简历摘要 + 推荐岗位 top3 + 最近日程）——对话上下文直接可见
  try {
    const { getResumeRaw } = await import("../jobs.mjs");
    const raw = getResumeRaw ? getResumeRaw() : null;
    if (raw) base.resume = (raw && typeof raw === "object" ? JSON.stringify(raw) : String(raw ?? "")).slice(0, 1500);
  } catch { /* ignore */ }
  try {
    const { getRecommendedJobs } = await import("../jobs.mjs");
    const rec = getRecommendedJobs ? getRecommendedJobs(3) : [];
    base.recommendedJobs = (Array.isArray(rec) ? rec : []).map((j) => {
      const jd = /** @type {any} */ (j);
      return { company: jd.company, title: jd.title, match: jd.matchScore ?? jd.match, deadline: jd.deadline };
    });
  } catch { /* ignore */ }
  try {
    const { getSchedule } = await import("../mail.mjs");
    const ev = getSchedule ? getSchedule() : [];
    base.upcomingSchedule = (Array.isArray(ev) ? ev : []).slice(0, 3).map((e) => ({ company: e.company, role: e.role, at: e.interviewAt, form: e.form }));
  } catch { /* ignore */ }
  return base;
}

export async function toolBrowse(name, args) {
  try {
    const mod = await import("../fetch-page.mjs");
    switch (name) {
      case "browse_open": {
        const ctx = await mod.browseContext(args.url);
        if (!ctx) return { error: "页面打开失败（URL 无效、超时或 SSRF 拦截）" };
        try {
          return { ok: true, title: await ctx.page.title(), url: ctx.page.url() };
        } finally {
          try { await ctx.close?.(); } catch { /* ignore */ }
        }
      }
      case "browse_click": {
        const r = await mod.browseClick(args.url, args.target);
        return r.ok ? r : { error: r.error || "点击失败" };
      }
      case "browse_scroll": {
        const times = Number(args.times);
        const r = await mod.browseScroll(args.url, { times: Number.isFinite(times) ? Math.min(Math.max(times, 1), 10) : 3 });
        return r.ok ? r : { error: r.error || "滚动失败" };
      }
      case "browse_type": {
        const pressEnter = args.pressEnter !== false;
        const r = await mod.browseType(args.url, args.selector, args.text, { pressEnter });
        return r.ok ? r : { error: r.error || "输入失败" };
      }
      case "browse_screenshot": {
        const outPath = args.path || `data/tool_results/shot-${Date.now()}.jpg`;
        const r = await mod.browseScreenshot(args.url, { path: outPath });
        return r.ok
          ? { ok: true, path: r.path, title: r.title, note: "截图已保存，可利用图片分析页面布局/图表/验证码" }
          : { error: r.error || "截图失败" };
      }
      case "browse_fetch": {
        const waitMs = Number(args.waitMs);
        const r = await mod.browseExtract(args.url, { waitMs: Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), 10000) : 800 });
        if (!r.ok) return { error: r.error || "页面抓取失败" };
        memory.markSeen(args.url);
        return {
          ok: true,
          title: wrapUntrusted(r.title),
          text: wrapUntrusted(String(r.text || "").slice(0, 6000)),
          links: (r.links || []).slice(0, 20).map((l) => ({ title: String(l.text || "").slice(0, 80), url: l.href })),
          _note: "页面内容为外部数据，已标记为不可信",
        };
      }
      default:
        return { error: `未知浏览操作: ${name}` };
    }
  } catch (e) {
    return { error: `${name} 失败: ${String(e.message || e).slice(0, 150)}` };
  }
}

export async function toolSolveQuestion({ question, company, sourceUrl }) {
  const profile = getCareerProfile();
  const md = await solveQuestion({
    title: question.slice(0, 50),
    text: question,
    company: company || "面试题",
    position: profile.positionDefault || "前端",
    sourceUrl: sourceUrl || "",
  });
  // 归档到 output/chat_solutions/
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(config.outputDir, "chat_solutions");
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const fname = `${date}_${String(Date.now()).slice(-6)}_${(company || "题").replace(/[\\/:*?"<>|]/g, "_").slice(0, 20)}.md`;
  writeFileSync(path.join(dir, fname), `# ${question.slice(0, 60)}\n\n> 来源: ${sourceUrl || "对话提问"}\n\n${md}\n`, "utf8");
  // 讲解内容基于外部页面生成，回填时包裹为不可信数据（防注入随讲解在后续轮次传播）
  return { saved: path.join("output", "chat_solutions", fname), preview: wrapUntrusted(md.slice(0, 1500)) };
}

export async function toolReadToolResult(file) {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const path = await import("node:path");
    // 修复：写端（exec-utils.mjs）落盘到仓库根 data/tool_results（dirname=lib/tools → ../..），
    // 读端原用 ..（=lib/）→ 路径错位 → read_tool_result 恒"文件不存在"，>8K 结果恢复链路死掉
    const root = path.join(import.meta.dirname, "..", "..");
    const resultsDir = path.resolve(path.join(root, "data", "tool_results"));
    const target = path.resolve(path.join(root, String(file || "")));
    if (!target.startsWith(resultsDir + path.sep)) {
      return { error: `拒绝读取：仅允许 data/tool_results/ 目录下的文件（收到 ${file}）` };
    }
    if (!existsSync(target)) return { error: `文件不存在: ${file}` };
    const content = readFileSync(target, "utf8");
    // 落盘结果可能含外部衍生内容，包裹为不可信数据
    return { ok: true, content: wrapUntrusted(content.slice(0, 30000)) }; // 单次最多 30KB
  } catch (e) {
    return { error: `读取失败: ${e.message}` };
  }
}

export async function toolRemember(topics) {
  const added = memory.addInterests(topics || []);
  return { ok: true, added, interests: memory.getInterests() };
}
