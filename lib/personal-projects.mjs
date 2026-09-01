// lib/personal-projects.mjs —— 简历个人项目源码 → 项目档案（模拟面试拷打素材）
// 思路：简历项目源码是"模型训练数据里没有、但面试官必须深挖"的独家信息。
// 扫描用户配置的项目目录，生成结构化"项目档案"（技术栈/目录树/README 摘要/核心源码预览）
// 存 knowledge_items（source=project:<name>, kind=project），模拟面试 startInterview 检索注入，
// 让面试官基于真实代码拷打（为什么用 X 不用 Y / 这个模块怎么实现），而非简历里一句话。
// 用法：lib / 面板设置配置 personal_projects=[{name,dir}]；indexPersonalProjects() 重建。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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

// 核心源码预览：排除测试/配置文件后按大小取核心源码（各取开头若干行）
// 修复：此前按 files 顺序取前 8 个——e2e 目录先扫被选（spec.ts/next-env/playwright.config），
// 核心源码（src/lib/）完全没读——讲解引用的 interview-store.ts 等全没被读，实现代码是 LLM 编的。
// 现在：排除测试/配置（e2e/spec/test/next-env/playwright.config/*.d.ts）→ 按大小降序（核心逻辑通常大）
// → 取前 10 个 → 各读前 1000 字符（25 行）
function keySourcePreview(dir, files) {
  const EXCLUDE = /(^|\/)(e2e|__tests__|test|tests)(\/|$)|\.(spec|test)\.|next-env|playwright\.config|vitest\.config|jest\.config|\.d\.ts$/;
  const core = files.filter((f) => !EXCLUDE.test(f));
  const pick = [...core]
    .sort((a, b) => statSync(path.join(dir, b)).size - statSync(path.join(dir, a)).size)
    .slice(0, 15);
  return pick.map((f) => {
    const full = path.join(dir, f);
    const size = statSync(full).size;
    const head = readFirst(full, 1000).split("\n").slice(0, 25).filter((l) => l.trim() && !l.trim().startsWith("//")).join("\n").slice(0, 800);
    return `--- ${f} (${size} B) ---\n${head}`;
  }).join("\n\n");
}

/** 为单个项目生成档案文本（供 knowledge_items + 面试注入） */
export function buildProjectArchive(proj) {
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
  const preview = keySourcePreview(dir, tree);
  const content = `# 项目：${name}（源码 ${dir}）\n` +
    (stack ? `\n【技术栈/依赖】\n${stack}\n` : "") +
    (tree.length ? `\n【源码结构】\n${tree.join("\n")}\n` : "（无源码文件）") +
    (readme ? `\n【README 摘要】\n${readme}\n` : "") +
    (preview ? `\n【核心源码预览】\n${preview}\n` : "");
  return { title: `项目·${name}`, content };
}

/** 重建全部个人项目档案进知识库（source=project:<name>；增量按扫描目录 mtime 判断可后续加） */
export function indexPersonalProjects() {
  const projects = getPersonalProjects();
  const now = Date.now();
  let ok = 0, fail = 0;
  for (const p of projects) {
    try {
      const a = buildProjectArchive(p);
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

export async function getProjectArchiveContext(topic, source = "") {
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
      const coreWord = String(topic || "").replace(/的区别|的原理|是什么|怎么用|如何用|常见问题|的理解|有哪些/g, "").trim();
      if (coreWord.length >= 2) {
        for (const p of projects) {
          const hit = findSourceByKeyword(p, coreWord);
          if (hit) {
            return `\n【项目源码中的相关实现】（${p.name} 的 ${hit.file}——真实代码，讲解必须基于它：这个技术点在项目里怎么用的、为什么这么用、有什么坑）\n${hit.snippet}\n`;
          }
        }
      }
      return "";
    }
    const archive = buildProjectArchive(match).content;
    if (!archive || archive.length < 200) return "";
    return `\n【本条目关联的本地项目源码档案】（${match.name} 的真实代码归档——讲解**必须基于真实代码**：技术栈选型、目录结构、核心实现、可能的坑；深挖细节才有价值）\n${archive.slice(0, 6000)}\n`;
  } catch { return ""; }
}
