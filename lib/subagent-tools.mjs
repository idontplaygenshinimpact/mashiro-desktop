// Subagent v2 工具集（对标 cc 的 Read/Write/Edit/Glob/Grep）
// 安全：路径白名单（resolve 后必须在项目目录内）+ 大小上限 + edit 唯一匹配
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const READ_CAP = 50 * 1024;   // read 50KB
const WRITE_CAP = 200 * 1024; // write 200KB

/** 路径白名单：resolve 后必须在项目目录内（复用 project-guide 的 safeResolve 模式） */
export function safeResolve(root, p) {
  const base = path.resolve(root) + path.sep;
  const target = path.resolve(root, String(p || ""));
  if (target !== path.resolve(root) && !target.startsWith(base)) return null;
  return target;
}

/** 读文件（50KB 上限 + 行号） */
export function toolReadFile(root, { file }) {
  const target = safeResolve(root, file);
  if (!target) return { error: `路径越界：仅允许项目目录内（${file}）` };
  if (!existsSync(target) || !statSync(target).isFile()) return { error: `文件不存在: ${file}` };
  const st = statSync(target);
  if (st.size > READ_CAP) return { error: `文件过大（${Math.round(st.size / 1024)}KB > 50KB 上限）——请用 grep 定位后 read 局部` };
  const text = readFileSync(target, "utf8");
  const lines = text.split("\n");
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
  return { ok: true, file, lines: lines.length, content: numbered.slice(0, READ_CAP) };
}

/** 写文件（200KB 上限） */
export function toolWriteFile(root, { file, content }) {
  const target = safeResolve(root, file);
  if (!target) return { error: `路径越界：仅允许项目目录内（${file}）` };
  const text = String(content ?? "");
  if (text.length > WRITE_CAP) return { error: `内容过大（${Math.round(text.length / 1024)}KB > 200KB 上限）` };
  try {
    writeFileSync(target, text, "utf8");
    return { ok: true, file, bytes: text.length };
  } catch (e) {
    return { error: `写入失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

/** 编辑文件（old_string 唯一匹配——多匹配拒绝防误改） */
export function toolEditFile(root, { file, old_string, new_string }) {
  const target = safeResolve(root, file);
  if (!target) return { error: `路径越界：仅允许项目目录内（${file}）` };
  if (!existsSync(target)) return { error: `文件不存在: ${file}` };
  const oldS = String(old_string ?? "");
  if (!oldS) return { error: "old_string 不能为空" };
  const text = readFileSync(target, "utf8");
  const count = text.split(oldS).length - 1;
  if (count === 0) return { error: `old_string 未找到（${file}）——请先 read_file 确认内容` };
  if (count > 1) return { error: `old_string 匹配 ${count} 处（需唯一）——请用更长的上下文定位` };
  const updated = text.replace(oldS, String(new_string ?? ""));
  try {
    writeFileSync(target, updated, "utf8");
    return { ok: true, file, replaced: oldS.length, added: String(new_string ?? "").length };
  } catch (e) {
    return { error: `写入失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

/** 目录列举（过滤 node_modules/.git/dist 等） */
export function toolListDir(root, { dir = "." } = {}) {
  const target = safeResolve(root, dir);
  if (!target) return { error: `路径越界：仅允许项目目录内（${dir}）` };
  if (!existsSync(target) || !statSync(target).isDirectory()) return { error: `目录不存在: ${dir}` };
  const SKIP = new Set(["node_modules", ".git", "dist", "output", "data", "models", ".venv", "__pycache__"]);
  try {
    const entries = readdirSync(target)
      .filter((n) => !SKIP.has(n) && !n.startsWith("."))
      .map((n) => {
        const p = path.join(target, n);
        return `${statSync(p).isDirectory() ? "📁" : "📄"} ${n}${statSync(p).isDirectory() ? "/" : ""}`;
      });
    return { ok: true, dir, entries: entries.slice(0, 100) };
  } catch (e) {
    return { error: `列举失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

/** 内容搜索（正则，限项目目录；返回文件:行号:行） */
export function toolGrep(root, { pattern, include = "*.mjs" }) {
  const re = new RegExp(pattern, "i");
  const results = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "output", "data", "models"]);
  const walk = (dir, depth = 0) => {
    if (depth > 6 || results.length >= 50) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const n of entries) {
      if (SKIP.has(n) || n.startsWith(".")) continue;
      const p = path.join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p, depth + 1); continue; }
      if (!n.endsWith(include.replace("*", ""))) continue;
      try {
        const lines = readFileSync(p, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push(`${path.relative(root, p)}:${i + 1}: ${lines[i].trim().slice(0, 100)}`);
            if (results.length >= 50) return;
          }
        }
      } catch { /* ignore */ }
    }
  };
  try { walk(root); } catch { /* ignore */ }
  return { ok: true, pattern, results };
}

/** 工具 schema（function calling 格式）+ 执行函数 */
export const SUBAGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读文件（50KB 上限，带行号）——定位内容/确认现状",
      parameters: { type: "object", properties: { file: { type: "string", description: "项目内相对路径" } }, required: ["file"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写文件（200KB 上限）——整体写入",
      parameters: { type: "object", properties: { file: { type: "string" }, content: { type: "string" } }, required: ["file", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "编辑文件（old_string 唯一匹配替换）——修正文档的核心：读章节→定位差距→编辑→保存",
      parameters: { type: "object", properties: { file: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file", "old_string", "new_string"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "目录列举（过滤 node_modules 等）",
      parameters: { type: "object", properties: { dir: { type: "string", description: "项目内相对目录（默认 .）" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "内容搜索（正则，限项目目录）",
      parameters: { type: "object", properties: { pattern: { type: "string" }, include: { type: "string", description: "文件后缀（默认 *.mjs）" } }, required: ["pattern"] },
    },
  },
];

/** 执行 subagent 工具（白名单：只能调传入的 tools——调用方控制能力面）
 * @param {string} root 项目根
 * @param {string} name 工具名
 * @param {any} [args] 工具参数
 */
export async function executeSubagentTool(root, name, args = {}) {
  switch (name) {
    case "read_file": return toolReadFile(root, args);
    case "write_file": return toolWriteFile(root, args);
    case "edit_file": return toolEditFile(root, args);
    case "list_dir": return toolListDir(root, args);
    case "grep": return toolGrep(root, args);
    default: return { error: `未知工具: ${name}` };
  }
}
