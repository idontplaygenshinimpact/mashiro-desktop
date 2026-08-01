// agent 核心：对话式工具调用循环 + 任务规划
// 用户自然语言指令 → LLM 决策 → 工具执行 → 结果回填 → 继续/回答
// 复杂请求自动拆解为多步计划执行
import { config } from "../config.mjs";
import { fetchPage } from "./fetch-page.mjs";
import { classifyPage, solveQuestion, summarizeQiuzhao, detectQuestions } from "./ai.mjs";
import { memory } from "./memory.mjs";
import * as interviewApi from "./interview.mjs";

const MAX_ROUNDS = 6; // 工具循环最多轮数（防死循环）
const AGENT_TIMEOUT_MS = 180000; // 整个 agent 对话超时（3 分钟）

// ---------- 工具定义（DeepSeek function calling 格式） ----------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "plan_task",
      description: "把用户的复杂请求拆解成多步执行计划。调用后你会看到计划，然后逐步执行（每步调对应工具）。用于：搜索+讲解+归档组合任务、多篇面经整理、学习计划生成等。",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "用户请求的目标" },
          steps: { type: "array", items: { type: "string" }, description: "2-5 个具体步骤，每步一个动作" },
        },
        required: ["goal", "steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_posts",
      description: "搜索面经/笔试/招聘帖子，返回候选帖子列表（标题+链接+来源站）。支持牛客、掘金、CSDN。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，如：React 面经 / 前端 笔试 / Agent 面经 / 某公司 招聘" },
          site: { type: "string", enum: ["auto", "nowcoder", "juejin", "csdn"], description: "指定来源站，默认 auto" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "抓取一个网页的正文内容（用于查看帖子详情、提取题目）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "帖子完整 URL" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "solve_question",
      description: "完整讲解一道面试/笔试题（前端格式：结论/原理/实现JS/边界）。结果归档到 output 目录。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "题目或面经内容" },
          company: { type: "string", description: "公司名（可空）" },
          sourceUrl: { type: "string", description: "来源链接（可空）" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "detect_questions",
      description: "判断页面内容里是否有具体可作答的题目，并提取题目列表。用于从面经/攻略文中筛出真题目。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "页面标题" },
          text: { type: "string", description: "页面正文" },
        },
        required: ["title", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "记住用户关注点（话题/公司/方向），用于后续主动推送相关内容。",
      parameters: {
        type: "object",
        properties: {
          topics: { type: "array", items: { type: "string" }, description: "关注点列表，如 ['React', '字节']" },
        },
        required: ["topics"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weak_points",
      description: "查看用户的学习薄弱点（复盘验证中答错/答不好的知识点）。生成学习计划时应优先覆盖薄弱点。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory",
      description: "查看用户画像/关注点/学习进度等记忆信息。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_study_plan",
      description: "查看当前学习清单（待学知识点）。面试前调用，优先考清单里的未完成项。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_outputs",
      description: "查看最近爬取整理的面经/题目（output 目录最新产出摘要）。面试出题时参考真实高频考点。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_interview",
      description: "开始一场模拟面试。AI 面试官生成第一个问题（含考察维度、合格标准）。之后用户每回答一轮，调用 submit_answer 推进。",
      parameters: {
        type: "object",
        properties: {
          position: { type: "string", description: "目标岗位，如：前端实习生 / React 前端 / 全栈" },
          role: { type: "string", enum: ["温和引导型", "压力追问型", "技术深挖型"], description: "面试官风格，默认技术深挖型" },
          resume: { type: "string", description: "简历内容（可选，面试官会基于简历追问项目经历）" },
        },
        required: ["position"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_answer",
      description: "提交当前问题的回答。AI 面试官给本轮评分（技术/表达/深度/边界/复盘意识）+ 下一问或追问。用户说结束/答完了时调用。",
      parameters: {
        type: "object",
        properties: {
          answer: { type: "string", description: "用户的回答内容" },
        },
        required: ["answer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_interview",
      description: "结束模拟面试，生成复盘报告（总体评价/优势/短板/学习方向/可投递性），并把薄弱点写入记忆。",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ---------- 工具执行（带 Repair：失败自动重试/降级） ----------
async function executeTool(name, args) {
  console.log(`[agent] 工具调用: ${name}(${JSON.stringify(args).slice(0, 120)})`);
  try {
    switch (name) {
      case "plan_task":
        return { ok: true, goal: args.goal, steps: args.steps || [], message: "计划已确认，请按步骤逐步执行，每完成一步告诉用户进展" };
      case "search_posts":
        return await withRetry(() => toolSearchPosts(args.query, args.site), 2);
      case "fetch_page":
        return await withRetry(() => toolFetchPage(args.url), 2);
      case "solve_question":
        return await withRetry(() => toolSolveQuestion(args), 1);
      case "detect_questions":
        return await toolDetectQuestions(args);
      case "remember":
        return await toolRemember(args.topics);
      case "get_weak_points":
        // 合并：记忆薄弱点 + 知识点树薄弱项（双源）
        try {
          const { getWeakKps } = await import("./knowledge.mjs");
          const kps = getWeakKps(5);
          return { weakPoints: memory.getWeakPoints(), weakKps: kps.map((k) => ({ topic: k.title, score: k.score })) };
        } catch {
          return { weakPoints: memory.getWeakPoints() };
        }
      case "get_memory":
        return { profile: memory.getProfileSummary(), interests: memory.getInterests(), mastered: memory.getMastered().slice(-10) };
      case "get_study_plan":
        return await toolGetStudyPlan();
      case "get_recent_outputs":
        return await toolGetRecentOutputs();
      case "start_interview":
        return await withRetry(() => interviewApi.startInterview(args), 1);
      case "submit_answer":
        return await withRetry(() => interviewApi.submitAnswer(args.answer), 1);
      case "end_interview":
        return await withRetry(() => interviewApi.endInterview(), 1);
      default:
        return { error: `未知工具: ${name}` };
    }
  } catch (e) {
    return { error: `${name} 执行失败: ${e.message}` };
  }
}

// Repair：失败重试（带退避），仍失败返回可操作的降级信息
async function withRetry(fn, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  // 降级提示：告诉 LLM 换个方式（换站/换关键词）
  return {
    error: `执行失败（已重试）: ${lastErr.message}`,
    hint: "可以尝试：换一个关键词重新搜索，或换 site 参数（nowcoder/juejin/csdn）",
  };
}

// 题目检测工具
async function toolDetectQuestions({ title, text }) {
  const r = await detectQuestions({ title, text });
  memory.markSeen(title); // 记录已处理
  return r;
}

// 学习清单工具
async function toolGetStudyPlan() {
  try {
    const { getPlan } = await import("./study.mjs");
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

// 最近产出摘要工具
async function toolGetRecentOutputs() {
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
    files.sort((a, b) => statSync(b).mtime - statSync(a).mtime);
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

// 搜索帖子：牛客/掘金（并行抓取加速）
async function toolSearchPosts(query, site = "auto") {
  const searchUrls = {
    nowcoder: `https://www.nowcoder.com/discuss?type=2&query=${encodeURIComponent(query)}`,
    juejin: `https://juejin.cn/search?query=${encodeURIComponent(query)}`,
    csdn: `https://so.csdn.net/so/search?q=${encodeURIComponent(query)}`,
  };
  const sites = site === "auto" ? ["nowcoder", "juejin"] : [site]; // auto 只搜 2 站，避免过慢
  const re = /(\/discuss\/\d+|\/post\/\d+|\/article\/details\/\d+|juejin\.cn\/post\/\d+|blog\.csdn\.net\/[^/]+\/article\/details\/\d+)/;
  // 并行抓取所有站
  const results = await Promise.all(
    sites.map(async (s) => {
      try {
        const page = await fetchPage(searchUrls[s], { maxTextChars: 2000, collectLinks: true });
        return page.links
          .filter((l) => re.test(l.href) && l.text.length > 5)
          .slice(0, 6)
          .map((l) => ({ title: l.text.slice(0, 80), url: l.href.replace(/[?&]searchId=[^&]*/g, "").split("?")[0], site: s }));
      } catch (e) {
        return [{ error: `${s} 搜索失败: ${e.message}` }];
      }
    })
  );
  // 合并 + 去重（排除已看过的帖子）
  const all = [];
  const seen = new Set();
  for (const list of results) {
    for (const p of list) {
      if (p.error) { all.push(p); continue; }
      if (seen.has(p.url)) continue;
      seen.add(p.url);
      if (memory.isSeen(p.url)) continue; // 已看过的跳过
      all.push(p);
    }
  }
  return { results: all.slice(0, 12) };
}

// 抓取页面正文（标记已看）
async function toolFetchPage(url) {
  const page = await fetchPage(url, { maxTextChars: 8000 });
  memory.markSeen(url);
  if (page.invalid || !page.text) return { error: "页面无效（404/内容为空）", title: page.title };
  return { title: page.title, text: page.text.slice(0, 6000) };
}

// 讲解题目 + 归档
async function toolSolveQuestion({ question, company, sourceUrl }) {
  const md = await solveQuestion({
    title: question.slice(0, 50),
    text: question,
    company: company || "面试题",
    position: "前端",
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
  return { saved: path.join("output", "chat_solutions", fname), preview: md.slice(0, 1500) };
}

// 记住关注点
async function toolRemember(topics) {
  const added = memory.addInterests(topics || []);
  return { ok: true, added, interests: memory.getInterests() };
}

// ---------- LLM 对话（带工具循环 + 任务规划 + 跨会话记忆） ----------
export async function chatWithAgent(userMsg, history = []) {
  const profile = memory.getProfileSummary();
  // 跨会话记忆：前端没传 history 时，用持久化的最近对话（记住上次聊过什么）
  const effectiveHistory = history?.length
    ? history
    : memory.getChatHistory()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 500) }))
        .slice(-6);
  const messages = [
    {
      role: "system",
      content:
        "你是桌宠真白，一名前端秋招辅导 agent。你的特点：\n" +
        "1) 用户请求需要查资料时，先调用工具获取信息再回答；复杂请求先调用 plan_task 拆解计划，再逐步执行（搜索→抓取→提炼题目→讲解→总结）。\n" +
        "2) 讲解题目用前端格式：结论/原理/实现JS/边界，代码用 JavaScript/TypeScript。\n" +
        "3) 不要只给链接——用户要的是结果：抓取内容、提炼题目、给出答案。\n" +
        "4) 回答简洁有用，中文，有真白语气但不过度卖萌。\n" +
        "5) 重要：拿到足够信息后立即总结回复，不要重复调用工具；一次搜索通常就够了。\n" +
        "6) 如果用户提到之前聊过的话题，结合对话记忆延续，不要假装不认识。\n" +
        "7) 回复末尾另起一行输出语音稿，格式：【语音】+ 一句 20-40 字的真白口吻口语（可爱、天然呆、简短，用于朗读）。例如：【语音】嗯……这个知识点其实很简单的哦，慢慢来就好啦~ 如果不需要朗读输出【语音】无。\n" +
        "8) 学习闭环：用户要模拟面试时，先调用 get_study_plan 和 get_recent_outputs 了解待学知识点和最近面经，再 start_interview（把重点方向告诉面试官）；面试结束后复盘会回流学习清单。\n" +
        `用户画像：${profile}`,
    },
    ...effectiveHistory,
    { role: "user", content: userMsg },
  ];

  let reply = "";
  let rounds = 0;
  const deadline = Date.now() + AGENT_TIMEOUT_MS;
  for (; rounds < MAX_ROUNDS; rounds++) {
    if (Date.now() > deadline) { reply = "⏱️ 任务耗时较长，我先汇总当前结果，你可以让我继续深入某一环节。"; break; }
    const res = await callLLM(messages);
    const msg = res.choices?.[0]?.message;

    // 有工具调用 → 执行并回填
    if (msg?.tool_calls?.length) {
      messages.push(msg); // assistant 消息（含 tool_calls）
      for (const tc of msg.tool_calls) {
        const args = safeParse(tc.function?.arguments);
        const result = await executeTool(tc.function?.name, args);
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 8000) });
      }
      continue; // 继续循环让 LLM 基于工具结果决策
    }

    // 无工具调用 → 最终回答
    reply = msg?.content || "";
    break;
  }
  if (rounds >= MAX_ROUNDS && !reply) reply = "任务步骤较多，我先完成了关键部分，你可以继续追问具体环节。";

  // 记忆对话
  memory.appendChat("user", userMsg);
  memory.appendChat("assistant", reply.slice(0, 500));

  // 解析语音稿（【语音】...）
  let voice = "";
  const vm = reply.match(/【语音】\s*([^\n]+)/);
  if (vm && vm[1] && vm[1].trim() !== "无") {
    voice = vm[1].trim();
    reply = reply.replace(/【语音】\s*[^\n]*\n?/, "").trim();
  }
  return { reply, voice, history: messages.slice(-6) };
}

async function callLLM(messages) {
  const body = {
    model: config.model,
    messages,
    tools: TOOLS,
    temperature: 0.4,
    max_tokens: 6000,
    stream: false,
  };
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`LLM API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

function safeParse(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
