// Skills 插件机制：目录约定 skills/<name>/，动态注入 agent 能力，不改 agent 内核
// 设计参考 DeepSeek Harness / OpenClaw / Claude Code 的插件体系：
//   1. SKILL.md 声明式（frontmatter name/description + 正文使用说明）→ 注入 agent system prompt（LLM 知道技能何时用）
//   2. skill.mjs 可编程（可选）：
//        export const name / description            // 插件元信息
//        export const system = "..."                // 追加到 system prompt 的角色/使用说明（可选）
//        export const tools = [{name, description, parameters, permission, run}]  // 动态工具（可选）
//        export const hooks = { "after_tool": fn }  // 监听 hooks 事件（可选，失败隔离）
//   3. 生命周期：目录即插即用；加载/运行失败隔离；enabled 配置可禁用
//
// 工具命名空间：skill__<skill名>__<工具名>（agent 侧唯一标识）
// hooks 命名空间：skill 的 hooks 自动注册到 lib/hooks.mjs（监听器抛错由 hooks 层隔离）
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SKILLS_DIR = path.join(import.meta.dirname, "..", "skills");
const NAME_RE = /^[\w-]+$/;

let cache = new Map(); // cacheKey -> { tools, permMap, names, hints, hookCount }
let hookOffs = []; // 已注册 hook 的取消函数（reload 时先清理再重扫，防重复注册）

// ---------- 场景装配（Phase P1）：当前激活技能集 ----------
// null = 全量（旧行为，向后兼容）；数组 = 仅该子集（loadSkills 按 only 过滤）
let activeOnly = null;
/** 设置当前激活技能集（null = 全量）；scenarios.mjs 场景切换时调用 */
export function setActiveSkillSet(only) {
  activeOnly = only === null || only === undefined
    ? null
    : [...new Set((Array.isArray(only) ? only : []).map((n) => String(n || "").trim()).filter(Boolean))];
}
/** 当前激活技能集（null = 全量） */
export function getActiveSkillSet() {
  return activeOnly;
}
/** 缓存键：only 子集各自独立缓存（切换零重扫开销） */
function cacheKeyFor(skillsDir) {
  return activeOnly?.length ? `${skillsDir}|${activeOnly.join(",")}` : skillsDir;
}

// ---------- SKILL.md 解析（frontmatter：---\nname: x\ndescription: y\n---\n正文） ----------
export function parseSkillMd(md) {
  const text = String(md || "");
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: "", description: "", body: text.trim() };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { name: meta.name || "", description: meta.description || "", body: m[2].trim() };
}

/** 扫描并加载指定目录的 skill（SKILL.md + skill.mjs 合并；失败隔离；按 目录+激活集 缓存）
 * 第二参数 { force } = true 时强制重扫（reload 用）：跳过缓存早退，重扫成功才 cache.set 覆盖（失败保留旧缓存）
 * 第二参数 { only } = 技能名数组：仅加载名单内技能（场景装配）；缺省 = 全量（老调用方零感知） */
export async function loadSkills(skillsDir = SKILLS_DIR, { force = false, only = undefined } = {}) {
  // 缓存键：显式 only 优先；否则用激活集（activeOnly）；都不设 = 全量（向后兼容）
  const explicitOnly = Array.isArray(only) && only.length ? [...new Set(only)] : null;
  const key = explicitOnly
    ? `${skillsDir}|${explicitOnly.join(",")}`
    : cacheKeyFor(skillsDir);
  if (!force && cache.has(key)) return cache.get(key);
  // ESM 模块版本号：Node 按 URL 缓存 import——拼 ?v= 让 reload 后 import 到新模块实例（代码/tools/hooks 生效）
  const modVersion = Date.now().toString(36);
  const tools = [];
  const permMap = {};
  const names = [];
  const hints = []; // {name, description, system} 注入 agent system prompt
  let hookCount = 0;
  const onlySet = explicitOnly ? new Set(explicitOnly) : (activeOnly?.length ? new Set(activeOnly) : null);
  if (existsSync(skillsDir)) {
    for (const dir of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!dir.isDirectory() || !NAME_RE.test(dir.name)) continue;
      if (onlySet && !onlySet.has(dir.name)) continue; // 场景装配：仅加载名单内技能
      const skillDir = path.join(skillsDir, dir.name);
      const modPath = path.join(skillDir, "skill.mjs");
      const mdPath = path.join(skillDir, "SKILL.md");
      let skillName = dir.name;
      let description = "";
      let systemText = "";
      let toolDefs = [];
      let hooks = null;
      let hadMd = false; // SKILL.md 存在且解析成功
      let hadMod = false; // skill.mjs 加载成功
      // 1) SKILL.md 声明（frontmatter 元信息 + 正文 = 使用说明）
      if (existsSync(mdPath)) {
        try {
          const md = parseSkillMd(readFileSync(mdPath, "utf8"));
          if (md.name && NAME_RE.test(md.name)) skillName = md.name;
          description = md.description || description;
          if (md.body) systemText += md.body.slice(0, 2000);
          hadMd = true;
        } catch (e) {
          console.log(`[skills] ${dir.name}/SKILL.md 解析失败（隔离）: ${String(e.message || e).slice(0, 80)}`);
        }
      }
      // 2) skill.mjs 可编程部分（tools/system/hooks）
      if (existsSync(modPath)) {
        try {
          const mod = await import(pathToFileURL(modPath).href + "?v=" + modVersion);
          if (mod.name && NAME_RE.test(String(mod.name))) skillName = String(mod.name);
          description = String(mod.description || description);
          if (mod.system) systemText += (systemText ? "\n" : "") + String(mod.system).slice(0, 2000);
          if (Array.isArray(mod.tools)) toolDefs = mod.tools;
          if (mod.hooks && typeof mod.hooks === "object") hooks = mod.hooks;
          hadMod = true;
        } catch (e) {
          console.log(`[skills] ${dir.name}/skill.mjs 加载失败（隔离）: ${String(e.message || e).slice(0, 120)}`);
          // skill.mjs 坏但 SKILL.md 存在 → 仍注册为纯声明技能
        }
      }
      // 两者皆无/皆失败 → 完全跳过（bad-skill 场景）
      if (!hadMd && !hadMod) continue;
      // 3) 注册工具（skill__<skill>__<tool> 命名空间）
      for (const t of toolDefs) {
        if (!t || typeof t.name !== "string" || typeof t.run !== "function") continue;
        const full = `skill__${skillName}__${t.name}`;
        tools.push({
          type: "function",
          function: {
            name: full,
            description: String(t.description || `${skillName} 提供的能力`),
            parameters: t.parameters || { type: "object", properties: {} },
          },
        });
        permMap[full] = t.permission === "confirm" ? "confirm" : "auto";
      }
      // 4) 注册 hooks（自动接线到 hooks 系统，抛错由 hooks 层隔离）
      if (hooks) {
        try {
          const { onHook } = await import("./hooks.mjs");
          for (const [event, fn] of Object.entries(hooks)) {
            if (typeof fn === "function") { hookOffs.push(onHook(event, fn)); hookCount++; }
          }
        } catch (e) {
          console.log(`[skills] ${skillName} hooks 注册失败（隔离）: ${String(e.message || e).slice(0, 80)}`);
        }
      }
      names.push(skillName);
      // 5) system 提示（注入 agent，让 LLM 知道技能存在与用法）
      if (description || systemText) {
        hints.push({ name: skillName, description, system: systemText });
      }
      console.log(`[skills] 已加载 ${skillName}（工具 ${toolDefs.length} 个 / hooks ${hooks ? Object.keys(hooks).length : 0} 个）`);
    }
  }
  const result = { tools, permMap, names, hints, hookCount, modVersion };
  cache.set(key, result);
  return result;
}

/** 已加载的 skill 工具 schema（合入 agent TOOLS；读取当前激活集缓存） */
export function getSkillTools() {
  return cache.get(cacheKeyFor(SKILLS_DIR))?.tools || [];
}

/** skill 工具权限级别（默认 confirm：权限查询不到按敏感处理，fail-closed） */
export function getSkillPermission(fullName) {
  return cache.get(cacheKeyFor(SKILLS_DIR))?.permMap[fullName] || "confirm";
}

/** 已加载 skill 名列表（当前激活集） */
export function getSkillNames() {
  return cache.get(cacheKeyFor(SKILLS_DIR))?.names || [];
}

/**
 * 热重载：清缓存 + 清理旧 hooks 后重新扫描（开发插件不用重启桌宠）
 * 对标 DSH cordis_stop/run 的生命周期管理；重载失败不影响已加载状态
 * @returns {Promise<{ok: boolean, names?: string[], toolCount?: number, hookCount?: number, error?: string}>}
 */
export async function reloadSkills(skillsDir = SKILLS_DIR) {
  for (const off of hookOffs) {
    try { off(); } catch { /* ignore */ }
  }
  hookOffs = [];
  // force 重扫（不先 delete）：loadSkills 扫描完成后 cache.set 覆盖；失败保留旧缓存
  try {
    await loadSkills(skillsDir, { force: true });
    const r = cache.get(cacheKeyFor(skillsDir));
    return { ok: true, names: r?.names || [], toolCount: r?.tools.length || 0, hookCount: r?.hookCount || 0 };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 运行时概览（面板/agent 查询；对标 DSH cordis_inspect_list） */
export function inspectSkills(skillsDir = SKILLS_DIR) {
  const r = cache.get(cacheKeyFor(skillsDir));
  if (!r) return { ok: false, loaded: false, hint: "skills 尚未加载（首次 agent 对话或面板操作时自动加载）" };
  return {
    ok: true,
    loaded: true,
    skills: r.names.map((name) => {
      const hint = r.hints.find((h) => h.name === name);
      const tools = r.tools
        .filter((t) => t.function.name.startsWith(`skill__${name}__`))
        .map((t) => ({ name: t.function.name, permission: r.permMap[t.function.name] || "auto" }));
      return { name, description: hint?.description || "", toolCount: tools.length, tools };
    }),
    hookCount: r.hookCount,
    totalTools: r.tools.length,
  };
}

/** skill 声明提示（注入 agent system prompt：{name, description, system}[]；当前激活集） */
export function getSkillHints() {
  return cache.get(cacheKeyFor(SKILLS_DIR))?.hints || [];
}

/** 把 skill 提示渲染成 system prompt 追加文本（agent 调用） */
export function buildSkillHintsPrompt() {
  const hints = getSkillHints();
  if (!hints.length) return "";
  const lines = hints.map((h) => {
    let s = `- 【技能 ${h.name}】${h.description || ""}`;
    if (h.system) s += `\n  ${h.system.split("\n").map((l) => `  ${l}`).join("\n")}`;
    return s;
  });
  return `\n## 可用技能（SKILL.md / skill.mjs 插件，按需使用）\n${lines.join("\n")}`;
}

/** 路由执行 skill 工具（skill__<skill>__<tool>）；skillsDir 可注入（测试隔离，默认生产目录）
 *  安全约束：skillName 必须匹配 NAME_RE；fullName 必须在当前 cache 的 permMap 白名单中；路径不得越出 skillsDir */
export async function callSkillTool(fullName, args, skillsDir = SKILLS_DIR) {
  const parts = String(fullName || "").split("__");
  if (parts.length !== 3 || parts[0] !== "skill") return { error: `未知 skill 工具: ${fullName}` };
  const [, skillName, toolName] = parts;
  if (!NAME_RE.test(skillName)) return { error: `非法 skill 名: ${skillName}` };
  // 白名单校验：仅当前已加载 permMap 中的工具可调用（防 skill__..__x 等伪造名）
  const cached = cache.get(cacheKeyFor(skillsDir));
  const permMap = cached?.permMap || {};
  if (!Object.prototype.hasOwnProperty.call(permMap, fullName)) {
    return { error: `skill 工具未在白名单: ${fullName}` };
  }
  // 路径穿越防护：resolve 后必须仍在 skillsDir 之内
  const modPath = path.resolve(skillsDir, skillName, "skill.mjs");
  const baseDir = path.resolve(skillsDir) + path.sep;
  if (!modPath.startsWith(baseDir)) return { error: `skill 路径越界: ${skillName}` };
  if (!existsSync(modPath)) return { error: `skill 不存在: ${skillName}` };
  try {
    // 带模块版本号 import：与 loadSkills 的 modVersion 对齐，reload 后取新模块实例（无缓存时用 "0"）
    const modVersion = cached?.modVersion || "0";
    const mod = await import(pathToFileURL(modPath).href + "?v=" + modVersion);
    const tool = (Array.isArray(mod.tools) ? mod.tools : []).find((t) => t?.name === toolName);
    if (!tool) return { error: `skill ${skillName} 无工具 ${toolName}` };
    const r = await tool.run(args || {});
    return r && typeof r === "object" ? r : { ok: true, result: r };
  } catch (e) {
    return { error: `skill ${skillName}.${toolName} 执行失败: ${String(e.message || e).slice(0, 150)}` };
  }
}
