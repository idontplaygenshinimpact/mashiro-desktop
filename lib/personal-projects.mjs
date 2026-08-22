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

// 核心源码预览：找入口命中的文件 + 最大的几个源码文件，各取开头若干行
function keySourcePreview(dir, files) {
  const entryNames = ["main", "index", "app", "server", "cli", "run", "start"];
  const pick = [];
  const byBasename = (n) => files.find((f) => {
    const base = path.basename(f);
    return base === n || base.startsWith(`${n}.`) || base.startsWith(`${n}-`) || base.startsWith(`${n}_`);
  });
  for (const n of entryNames) if (byBasename(n)) pick.push(byBasename(n));
  for (const f of files) {
    if (pick.length >= 8) break;
    if (!pick.includes(f)) pick.push(f);
  }
  return pick.slice(0, 8).map((f) => {
    const full = path.join(dir, f);
    const size = statSync(full).size;
    const head = readFirst(full, 600).split("\n").slice(0, 15).filter((l) => l.trim() && !l.trim().startsWith("//")).join("\n").slice(0, 500);
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
 * 匹配：topic 与项目名互相包含；source 标记 简历/项目 的条目按项目名前缀兜底匹配
 * @param {string} topic 清单条目主题（如"低代码平台"）
 * @param {string} [source] 条目来源（如"简历"/"产出"）
 * @returns {Promise<string>} 注入文本（无匹配返回空串；含项目名 + 档案内容）
 */
export async function getProjectArchiveContext(topic, source = "") {
  try {
    const projects = getPersonalProjects();
    if (!projects.length) return "";
    const t = String(topic || "").trim();
    const src = String(source || "");
    const match = projects.find((p) => t.includes(p.name) || p.name.includes(t))
      || (/(简历|项目|project)/i.test(src) ? projects.find((p) => t.includes(p.name.slice(0, 3))) : null);
    if (!match) return "";
    const archive = buildProjectArchive(match).content;
    if (!archive || archive.length < 200) return "";
    return `\n【本条目关联的本地项目源码档案】（${match.name} 的真实代码归档——讲解**必须基于真实代码**：技术栈选型、目录结构、核心实现、可能的坑；深挖细节才有价值）\n${archive.slice(0, 6000)}\n`;
  } catch { return ""; }
}
