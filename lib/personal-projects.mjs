// lib/personal-projects.mjs —— 简历个人项目源码 → 项目档案（模拟面试拷打素材）
// 思路：简历项目源码是"模型训练数据里没有、但面试官必须深挖"的独家信息。
// 扫描用户配置的项目目录，生成结构化"项目档案"（技术栈/目录树/README 摘要/核心源码预览）
// 存 knowledge_items（source=project:<name>, kind=project），模拟面试 startInterview 检索注入，
// 让面试官基于真实代码拷打（为什么用 X 不用 Y / 这个模块怎么实现），而非简历里一句话。
// 用法：lib / 面板设置配置 personal_projects=[{name,dir}]；indexPersonalProjects() 重建。
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { db } from "./db.mjs";

// 自建知识库表（幂等；不依赖 rag.mjs 是否加载——个人项目档案独立可用）
try {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY, source TEXT, kind TEXT, title TEXT, content TEXT,
    vector BLOB, confidence REAL NOT NULL DEFAULT 0.5, evidence TEXT NOT NULL DEFAULT '',
    last_verified_at INTEGER, created_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(id UNINDEXED, title, content, tokenize='trigram')`);
} catch { /* 表已有/暂不可用 */ }

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".output", "output", "data", "release", ".cache", "target", "venv", "__pycache__", ".idea", ".vscode", ".github", ".husky"]);
const SRC_EXT = new Set([".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".vue", ".py", ".go", ".java", ".rs", ".cpp", ".c", ".h", ".css", ".scss", ".sql", ".sh"]);
const CONFIG_KEY = "personal_projects"; // settings JSON: [{name, dir}]

/** 读个人项目配置（面板设置可配） */
export function getPersonalProjects() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(CONFIG_KEY);
    const arr = row ? JSON.parse(String(row.value)) : [];
    return Array.isArray(arr) ? arr.filter((p) => p && p.name && p.dir && existsSync(p.dir)) : [];
  } catch { return []; }
}
export function savePersonalProjects(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((p) => ({ name: String(p.name || "").trim().slice(0, 40), dir: String(p.dir || "").trim() }))
    .filter((p) => p.name && p.dir && existsSync(p.dir));
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)").run(CONFIG_KEY, JSON.stringify(clean), Date.now());
  return { ok: true, projects: clean };
}

function readFirst(file, max) {
  try { return readFileSync(file, "utf8").slice(0, max); } catch { return ""; }
}

// 扫描源码目录树（过滤忽略；限深度/条目数防爆）
function scanTree(dir, baseDir, depth, acc) {
  if (depth > 3 || acc.length >= 120) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanTree(full, baseDir, depth + 1, acc);
    } else if (SRC_EXT.has(path.extname(e.name).toLowerCase())) {
      acc.push(path.relative(baseDir, full).replace(/\\/g, "/"));
    }
  }
}

// 从 package.json 提取技术栈（依赖名 + 引擎）
function techStack(dir) {
  const pkgFile = path.join(dir, "package.json");
  if (!existsSync(pkgFile)) {
    // 尝试 pyproject/requirements/cargo 等
    for (const f of ["pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"]) {
      const p = path.join(dir, f);
      if (existsSync(p)) return readFirst(p, 600).split("\n").slice(0, 25).join(" | ").replace(/[=\s]+/g, " ");
    }
    return "";
  }
  try {
    const pkg = JSON.parse(readFirst(pkgFile, 20000));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const names = Object.keys(deps);
    const engines = pkg.engines ? `（Node ${pkg.engines.node || "?"}）` : "";
    const scripts = Object.keys(pkg.scripts || {}).slice(0, 12).join("、");
    return `${names.slice(0, 40).join(", ")}${engines}${scripts ? `；脚本：${scripts}` : ""}${pkg.description ? `；说明：${pkg.description}` : ""}`;
  } catch { return ""; }
}

// 核心源码预览：排除测试/配置文件后**全部核心源码**（不是前 N 个——用户要求"搜集完全部"，
// 像通用 agent 一样看全源码）——并行读头部（Promise.all——快）
async function keySourcePreview(dir, files) {
  const EXCLUDE = /(^|\/)(e2e|__tests__|test|tests)(\/|$)|\.(spec|test)\.|next-env|playwright\.config|vitest\.config|jest\.config|\.d\.ts$/;
  const core = files.filter((f) => !EXCLUDE.test(f));
  const parts = await Promise.all(core.map(async (f) => {
    const full = path.join(dir, f);
    try {
      const size = statSync(full).size;
      const head = readFirst(full, 1000).split("\n").slice(0, 30).filter((l) => l.trim() && !l.trim().startsWith("//")).join("\n").slice(0, 800);
      return `--- ${f} (${size} B) ---\n${head}`;
    } catch { return ""; }
  }));
  return parts.filter(Boolean).join("\n\n");
}

/** 为单个项目生成档案文本（供 knowledge_items + 面试注入）——异步（并行读全部核心源码） */
export async function buildProjectArchive(proj) {
  const { name, dir } = proj;
  const tree = [];
  scanTree(dir, dir, 0, tree);
  const readme = (() => {
    for (const f of ["README.md", "readme.md", "Readme.md"]) {
      const p = path.join(dir, f);
      if (existsSync(p)) return readFirst(p, 2500).replace(/[#*`>]/g, "").replace(/\n{3,}/g, "\n").slice(0, 2000);
    }
    return "";
  })();
  const stack = techStack(dir);
  const preview = await keySourcePreview(dir, tree);
  const content = `# 项目：${name}（源码 ${dir}）\n` +
    (stack ? `\n【技术栈/依赖】\n${stack}\n` : "") +
    (tree.length ? `\n【源码结构】\n${tree.join("\n")}\n` : "（无源码文件）") +
    (readme ? `\n【README 摘要】\n${readme}\n` : "") +
    (preview ? `\n【核心源码预览】\n${preview}\n` : "");
  return { title: `项目·${name}`, content };
}

/** 重建全部个人项目档案进知识库（source=project:<name>；增量按扫描目录 mtime 判断可后续加） */
export async function indexPersonalProjects() {
  const projects = getPersonalProjects();
  const now = Date.now();
  let ok = 0, fail = 0;
  for (const p of projects) {
    try {
      const a = await buildProjectArchive(p);
      if (a.content.length < 200) { fail++; continue; } // 空目录/无源码跳过
      // 先删旧档案（幂等）再插新
      db.prepare("DELETE FROM knowledge_fts WHERE id IN (SELECT id FROM knowledge_items WHERE source=?)").run(`project:${p.name}`);
      db.prepare("DELETE FROM knowledge_items WHERE source=?").run(`project:${p.name}`);
      const id = `prj_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare("INSERT INTO knowledge_items (id, source, kind, title, content, vector, confidence, evidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, `project:${p.name}`, "project", a.title.slice(0, 200), a.content, null, 1.0, p.dir, now, now);
      db.prepare("INSERT INTO knowledge_fts (id, title, content) VALUES (?,?,?)").run(id, a.title.slice(0, 200), a.content);
      ok++;
    } catch (e) {
      fail++;
      console.log(`[personal-projects] ${p.name} 索引失败: ${String(e?.message || e).slice(0, 80)}`);
    }
  }
  return { ok, fail };
}

/** 按项目名取档案原文（面试注入用；返回 null 无） */
export function getProjectArchive(name) {
  try {
    const row = db.prepare("SELECT content FROM knowledge_items WHERE source=? ORDER BY updated_at DESC LIMIT 1").get(`project:${String(name)}`);
    return row ? String(row.content).slice(0, 8000) : null;
  } catch { return null; }
}

/**
 * 按清单条目匹配个人项目档案上下文（讲解/追问注入用）
 * 匹配升级（2026-08）：不再要求"简历项目名 == 配置档案名"——
 *   1) 候选名 = 档案名 + 目录 basename + package.json name（桥梁）
 *   2) 归一化包含：小写 + 去分隔符（空格/连字符/斜杠/括号等）后互相包含
 *      例：简历"CareerPilot / AI Career Studio" ↔ 目录 ai-career ↔ pkg name
 *      ai-career-studio → 归一化后 aicareerstudio 互相包含 ✓（此前断链需手动对齐名字）
 * @param {string} topic 清单条目主题（如"低代码平台"）
 * @param {string} [source] 条目来源（如"简历"/"产出"）
 * @returns {Promise<string>} 注入文本（无匹配返回空串；含项目名 + 档案内容）
 */
const NORM_RE = /[\s\-_/\\|（）()【】[\].:：·]/g;
const normKey = (s) => String(s || "").toLowerCase().replace(NORM_RE, "");

/** 项目匹配候选名：档案名 + 目录 basename + package.json name（package.json 读取失败忽略） */
function projectMatchKeys(p) {
  const keys = [p.name, path.basename(String(p.dir || ""))];
  try {
    const pkg = JSON.parse(readFileSync(path.join(p.dir, "package.json"), "utf8"));
    if (pkg?.name) keys.push(String(pkg.name));
  } catch { /* 无 package.json 的项目（纯脚本/其他语言）忽略 */ }
  return keys;
}

// 技术点匹配：在项目源码里搜关键词（面试答错回流的技术词——如"Zustand 状态管理"）——
// 命中返回 {file, snippet}（真实代码片段——讲解基于真实源码而非通用知识）
// 分词搜（"SSE 流式输出"拆"SSE"+"流式输出"——任一命中）+ 核心目录优先（stores/lib/hooks/components）
function findSourceByKeyword(proj, keyword) {
  const { dir } = proj;
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_EXT.has(path.extname(e.name))) files.push(p);
    }
  };
  walk(dir);
  // 分词（空格/斜杠拆分——"SSE 流式输出"→["SSE","流式输出"]；"iframe 沙箱"→["iframe","沙箱"]）
  const words = String(keyword || "").split(/[\s/、,，]+/).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2);
  if (!words.length) return null;
  // 核心目录优先（stores/lib/hooks/components——状态/逻辑/组件核心）
  const CORE_DIR = /(^|\/)(stores?|lib|hooks|components|core|services)(\/|$)/;
  const hits = [];
  for (const f of files) {
    try {
      const c = readFileSync(f, "utf8");
      const cl = c.toLowerCase();
      const matched = words.filter((w) => cl.includes(w));
      if (matched.length) {
        const idx = cl.indexOf(matched[0]);
        hits.push({
          file: path.relative(dir, f).replace(/\\/g, "/"),
          snippet: c.slice(Math.max(0, idx - 200), idx + 600),
          score: (CORE_DIR.test(f) ? 2 : 0) + matched.length, // 核心目录 + 命中词数
        });
      }
    } catch { /* 读取失败跳过 */ }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  return hits[0];
}

export async function getProjectArchiveContext(topic, source = "", force = false) {
  try {
    const projects = getPersonalProjects();
    if (!projects.length) return "";
    const t = normKey(topic);
    if (!t) return "";
    const src = String(source || "");
    const match = projects.find((p) => {
      const keys = projectMatchKeys(p).map(normKey);
      return keys.some((k) => k && (t.includes(k) || k.includes(t)));
    })
      // 兜底：source 标记简历/项目的条目，按档案名前缀匹配（历史行为保留）
      || (/(简历|项目|project)/i.test(src) ? projects.find((p) => t.includes(normKey(p.name).slice(0, 6))) : null);
    if (!match) {
      // 技术点匹配（2026-09 追加）：topic 是技术词（如"Zustand 状态管理"——面试答错回流清单）——
      // 项目名匹配失败 → 在项目源码里搜 topic 核心词 → 命中 → 注入对应文件片段（真实源码）
      // 讲解基于真实代码（"你的项目里 Zustand 是这样用的"）而非通用知识
      // 中英文映射（源码常为英文——"状态机"→"state machine|transition"、"沙箱"→"sandbox" 等）
      const EN_MAP = {
        "状态机": "state machine|transition|transitions",
        "沙箱": "sandbox",
        "防抖": "debounce",
        "节流": "throttle",
        "流式": "stream|sse|readablestream",
        "虚拟列表": "virtual",
        "懒加载": "lazy|dynamic",
        "缓存": "cache",
        "重试": "retry",
        "超时": "timeout|abort",
        "降级": "fallback|mock",
        "状态管理": "store|zustand|redux",
        "路由": "router|route",
        "权限": "permission|auth|guard",
        "国际化": "i18n|locale",
        "性能优化": "memo|memoize|performance",
      };
      const coreWord = String(topic || "").replace(/的区别|的原理|是什么|怎么用|如何用|常见问题|的理解|有哪些/g, "").trim();
      const searchWords = [];
      if (coreWord.length >= 2) searchWords.push(coreWord);
      for (const [zh, en] of Object.entries(EN_MAP)) {
        if (String(topic || "").includes(zh)) searchWords.push(en);
      }
      if (searchWords.length) {
        for (const p of projects) {
          const hit = findSourceByKeyword(p, searchWords.join(" "));
          if (hit) {
            return `\n【项目源码中的相关实现】（${p.name} 的 ${hit.file}——真实代码，讲解必须基于它：这个技术点在项目里怎么用的、为什么这么用、有什么坑；只引用【源码结构】里真实存在的文件，不编造文件名）\n${hit.snippet}\n`;
          }
        }
      }
      return "";
    }
    const archive = (await buildProjectArchive(match)).content;
    if (!archive || archive.length < 200) return "";
    // 学习文档缓存（验收问题 2：生成时间波动大 28.7s-120s+——前端 SSE 120s 可能超时。
    // 已生成的学习文档存在时直接读缓存返回（快——不重新 subagent 搜集）；force=true
    // （重新生成）才重新搜集 + 覆盖文档）
    if (!force) {
      try {
        const { studyNotesDir, sanitizeFilename } = await import("./study-files.mjs");
        const docPath = path.join(studyNotesDir(), `项目·${sanitizeFilename(match.name)}-学习文档.md`);
        if (existsSync(docPath)) {
          const cached = readFileSync(docPath, "utf8");
          if (cached.length > 500) {
            return `\n【本条目关联的本地项目源码档案】（${match.name} 的真实代码归档——学习文档缓存（subagent 已读完全部核心源码）；讲解**必须基于真实代码**：技术栈选型、目录结构、核心实现、可能的坑；只引用真实存在的文件，不编造文件名）\n${cached.slice(0, 14000)}\n`;
          }
        }
      } catch { /* 缓存读取失败——重新搜集 */ }
    }
    // subagent 并行搜集全部源码（2026-09：用户要求"搜集完全部的"——像通用 agent 一样：
    // 主进程读全部核心源码 → 分组 → subagent 并行理解每组 → 汇总 → 注入讲解。
    // subagent 失败/超时 → 降级 buildProjectArchive（读头部））
    try {
      const { runSubagent } = await import("./subagent.mjs");
      const EXCLUDE = /(^|\/)(e2e|__tests__|test|tests)(\/|$)|\.(spec|test)\.|next-env|playwright\.config|vitest\.config|jest\.config|\.d\.ts$/;
      const srcFiles = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (SRC_EXT.has(path.extname(e.name))) srcFiles.push(path.relative(match.dir, p).replace(/\\/g, "/"));
        }
      };
      walk(match.dir);
      const coreFiles = srcFiles.filter((f) => !EXCLUDE.test(f));
      // 核心目录优先（修复：walk 顺序配置文件/app 在前——interview-store/sandbox/fetch-ai 在
      // fullSummary 的 20000 后——八股提取 context 没含——状态机/postMessage/TextDecoder 漏——
      // 核心业务文件排前，fullSummary 前 20000 含核心业务）
      const CORE_DIR = /(^|\/)(stores?|lib|hooks|components|core|services)(\/|$)/;
      coreFiles.sort((a, b) => {
        const wa = CORE_DIR.test(a) ? 1 : 0;
        const wb = CORE_DIR.test(b) ? 1 : 0;
        return wb - wa;
      });
      // 分组（修复 2026-09：此前按"8 文件/组 × 前 3000 字符"——大文件只读头部约等于没读。
      // 改为**按字符预算分组 + 全文读取**：每组累计 ≤24000 字符（subagent 上下文可控），
      // 大文件全文读（单独/少数组），小文件合并——全部核心文件全文覆盖）
      const GROUP_BUDGET = 24000;
      const FILE_CAP = 30000; // 单文件上限（防超大文件爆上下文；>30KB 的文件仍截断——罕见）
      const groups = [];
      let cur = [], curLen = 0;
      for (const f of coreFiles) {
        let len = 0;
        try { len = Math.min(statSync(path.join(match.dir, f)).size, FILE_CAP); } catch { len = 0; }
        if (curLen + len > GROUP_BUDGET && cur.length) { groups.push(cur); cur = []; curLen = 0; }
        cur.push(f); curLen += len;
      }
      if (cur.length) groups.push(cur);
      // 串行执行（修复：并发 4 分批在 Ollama 负载高时排队卡死（120s+ 超时）——串行稳定不卡，
      // 慢但能完成；总超时 90s 兜底降级）
      const summaries = [];
      const collectAll = (async () => {
        for (let i = 0; i < groups.length; i += 1) {
          const batch = groups.slice(i, i + 1);
          const rs = await Promise.all(batch.map(async (g) => {
            const content = g.map((f) => {
              try { return `--- ${f} ---\n${readFileSync(path.join(match.dir, f), "utf8").slice(0, FILE_CAP)}`; } catch { return ""; }
            }).filter(Boolean).join("\n\n");
            const r = await runSubagent({
              name: "项目源码分析",
              // 任务 1（工单）：subagent task 扩展——除核心职责/实现/坑外，提取涉及的技术知识点（八股）
              task: "分析以下项目源码文件，提取每个文件的核心职责、关键实现（数据结构/算法/设计模式/状态管理）、可能的坑，以及**涉及的技术知识点（八股）**。精炼输出：每个文件 2-4 行要点，中文。末尾单独输出【八股清单】：每个知识点一行——【八股】<知识点>：项目里怎么用的（真实文件/代码）+ 面试官可能追问的问题。",
              context: content,
            });
            return r?.ok ? r.result : "";
          }));
          summaries.push(...rs);
        }
      })();
      await Promise.race([
        collectAll,
        new Promise((_, rej) => setTimeout(() => rej(new Error("源码搜集超时")), 600000)), // 串行 10 分钟上限（后台跑——完成不降级）
      ]);
      const fullSummary = summaries.filter(Boolean).join("\n\n");
      if (fullSummary.length > 500) {
        // 任务 2（工单）：汇总生成学习文档（幂等覆盖 study_notes/项目·xxx-学习文档.md）——
        // 项目概览 + 源码要点 + 涉及的全部八股（原理/项目用法/追问）+ 模拟面试问答
        try {
          const { studyNotesDir, sanitizeFilename } = await import("./study-files.mjs");
          const notesDir = studyNotesDir();
          mkdirSync(notesDir, { recursive: true }); // 目录可能不存在（writeFileSync 不建目录）
          const docPath = path.join(notesDir, `项目·${sanitizeFilename(match.name)}-学习文档.md`);
          // 八股段：**单独 subagent 专门提取**（修复：从汇总提取【八股】行不可靠——subagent 只对
          // 配置文件组提取了八股（ESLint/Next.js 配置），核心业务文件（interview-store.ts 等）的
          // 八股（Zustand/SSE/状态机/iframe 沙箱）没提取——学习文档缺核心八股，不能通过模拟面试）
          let baSection = "";
          try {
            const ba = await Promise.race([
              runSubagent({
                name: "八股提取",
                task: "基于以下项目源码要点，提取项目涉及的全部技术知识点（八股）——包括但不限于：状态管理（Zustand/Redux）、SSE 流式输出、有限状态机、iframe 沙箱、防抖节流、Next.js App Router、Web Worker、postMessage 通信、TextDecoder 流式解码、闭包/事件循环等。每个知识点一行：【八股】<知识点>：项目里怎么用的（真实文件/代码）+ 面试官可能追问的问题。至少 10 个，覆盖核心业务（不只是配置文件）。",
                context: fullSummary.slice(0, 20000), // 修复：8000 截断——配置文件在前，核心业务（interview-store 等）在 8000 后没进 context——八股提取只基于配置文件
              }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("八股提取超时")), 30000)),
            ]);
            if (ba?.ok && ba.result) baSection = ba.result;
          } catch { /* 八股提取失败——回落从汇总提取 */ }
          if (!baSection) {
            const baLines = fullSummary.match(/【八股】[^\n]+/g) || [];
            baSection = baLines.length ? baLines.join("\n") : "（subagent 未输出八股清单——见源码要点）";
          }
          // 模拟面试问答（subagent 生成——基于源码要点+八股，面试官拷打模拟）
          // 加 30s 超时（修复：问答 subagent 慢/卡时文档不写入——超时跳过，文档仍含源码要点+八股）
          let qaSection = "";
          try {
            const qa = await Promise.race([
              runSubagent({
                name: "模拟面试问答生成",
                task: "基于以下项目源码要点与八股清单，生成 10-15 个模拟面试高频问题（面试官拷打项目：源码细节 + 八股原理），每个问题带参考答案（2-4 句，基于真实源码，不编造）。输出格式：Q1: 问题\nA1: 答案\nQ2: 问题\nA2: 答案\n...",
                context: `${fullSummary.slice(0, 12000)}\n\n${baSection}`, // 修复：6000/3000 截断——核心业务八股在后没进问答 context
              }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("问答生成超时")), 30000)),
            ]);
            if (qa?.ok && qa.result) qaSection = qa.result;
          } catch { /* 问答生成失败/超时——学习文档仍含源码要点+八股 */ }
          const doc = `# 项目·${match.name} 学习文档（subagent 读完全部核心源码 ${coreFiles.length} 个文件）\n\n## 项目概览\n${archive.slice(0, 3000)}\n\n## 源码要点（每文件：核心职责/关键实现/坑）\n${fullSummary.slice(0, 20000)}\n\n## 涉及的全部八股（原理/项目真实用法/面试追问）\n${baSection.slice(0, 10000)}\n\n## 模拟面试问答（面试官拷打模拟）\n${qaSection || "（生成失败——可基于源码要点与八股自行组织）"}\n`;
          writeFileSync(docPath, doc, "utf8");
        } catch { /* 学习文档存档失败不影响讲解注入 */ }
        return `\n【本条目关联的本地项目源码档案】（${match.name} 的真实代码归档——subagent 并行读完全部核心源码（${coreFiles.length} 个文件）后的要点汇总；讲解**必须基于真实代码**：技术栈选型、目录结构、核心实现、可能的坑；只引用真实存在的文件，不编造文件名）\n${archive.slice(0, 3000)}\n\n【全部源码要点汇总】（subagent 并行分析）\n${fullSummary.slice(0, 20000)}\n`;
      }
    } catch { /* subagent 失败降级 buildProjectArchive */ }
    return `\n【本条目关联的本地项目源码档案】（${match.name} 的真实代码归档——讲解**必须基于真实代码**：技术栈选型、目录结构、核心实现、可能的坑；深挖细节才有价值；只引用【源码结构】里真实存在的文件，不编造文件名）\n${archive.slice(0, 12000)}\n`;
  } catch { return ""; }
}
