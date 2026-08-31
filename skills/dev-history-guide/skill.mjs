// 开发历史面试文档技能：git 时间线 + opencode 会话 + DSH 会话 → LLM 生成 → 存档
// 三条红线：只读（opencode.db readOnly / git 只读命令 / 不写历史数据）；
//           不读凭据（opencode 只查 session/message/part，DSH 不读 .credentials.yaml）；
//           截断诚实（大结果 truncated 标记 + 文档覆盖范围段，复用 project-guide v2 模式）
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { llmChat, getReplyText } from "../../lib/llm.mjs";

export const name = "dev-history-guide";
export const description = "开发历史面试文档生成（git 时间线 + opencode/DSH 会话 → 结构化文档）";

const ROOT = path.join(import.meta.dirname, "..", "..");
const OUT_DIR = path.join(ROOT, "output", "dev-history-guides");
const OPENCODE_DB = path.join(process.env.USERPROFILE || "", ".local", "share", "opencode", "opencode.db");
const DSH_SESSIONS = path.join(process.env.USERPROFILE || "", ".dsh", "sessions");
const CODEX_SESSIONS = path.join(process.env.USERPROFILE || "", ".codex", "sessions");
const CLAUDE_PROJECTS = path.join(process.env.USERPROFILE || "", ".claude", "projects");
const MAX_RESULT_CHARS = 6000; // 单次查询结果截断（防灌爆上下文）
const MAX_GIT_COMMITS = 60;    // git 时间线上限
const MAX_OPENCODE_SESSIONS = 20;
const MAX_DSH_SESSIONS = 5;

// ---------- 数据源：git 时间线（只读命令） ----------
function readGitHistory(limit = 30) {
  try {
    const r = spawnSync("git", ["log", "--pretty=format:%h|%ad|%s", "--date=short", `-n${Math.min(limit, MAX_GIT_COMMITS)}`], {
      cwd: ROOT, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return { ok: false, error: "git log 失败（非 git 仓库？）" };
    const lines = String(r.stdout).split("\n").filter(Boolean);
    return {
      ok: true,
      commits: lines.map((l) => {
        const [hash, date, ...rest] = l.split("|");
        return { hash: String(hash).slice(0, 8), date, subject: rest.join("|").slice(0, 100) };
      }),
      truncated: lines.length >= Math.min(limit, MAX_GIT_COMMITS),
    };
  } catch (e) {
    return { ok: false, error: `git 读取失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

// ---------- 数据源：opencode 会话（readOnly SQLite，只查 session/message/part） ----------
function readOpencodeHistory(limit = 10) {
  if (!existsSync(OPENCODE_DB)) return { ok: false, error: `opencode.db 不存在（${OPENCODE_DB}）` };
  try {
    const db = new DatabaseSync(OPENCODE_DB, { readOnly: true }); // 红线：只读打开
    try {
      const sessions = db.prepare(
        `SELECT id, title, agent, model, time_created, tokens_input, tokens_output
         FROM session WHERE title IS NOT NULL AND title != '' AND title NOT LIKE 'New session%'
         ORDER BY time_created DESC LIMIT ?`
      ).all(Math.min(limit, MAX_OPENCODE_SESSIONS));
      const items = sessions.map((s) => ({
        id: String(s.id).slice(0, 12),
        title: String(s.title || "").slice(0, 80),
        agent: s.agent || "",
        model: s.model || "",
        time: new Date(Number(s.time_created) || 0).toISOString().slice(0, 10),
        tokens: (Number(s.tokens_input) || 0) + (Number(s.tokens_output) || 0),
      }));
      return { ok: true, sessions: items, truncated: items.length >= Math.min(limit, MAX_OPENCODE_SESSIONS) };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: `opencode 读取失败: ${String(e?.message || e).slice(0, 100)}` };
  }
}

// ---------- 数据源：DSH 会话（zstd 压缩单行 JSON，经 python 解压；只读 sessions/ 目录） ----------
// 实测：会话文件含完整消息（user/message + assistant text-chunks + tool/call）——逐帧解压提炼
// 修复（第二轮全量清查）：去掉 dirs.slice(0,2) 与 readdirSyncSafe(dir).slice(0,limit) 限制——
// 全量扫描本项目会话目录；python 提炼 text-chunks（assistant 输出——决策/踩坑的实际内容）
// 不只是 user/message；每会话消息数上限提高（msgs[:200]）
function readDshHistory(limit = 50) {
  if (!existsSync(DSH_SESSIONS)) return { ok: false, error: `DSH sessions 不存在（${DSH_SESSIONS}）` };
  try {
    // 找本项目会话目录（--D-mianshi-agent-- 等；只读会话文件，不碰 .credentials.yaml）
    const dirs = [];
    for (const d of readdirSyncSafe(DSH_SESSIONS)) {
      if (d.includes("mianshi-agent")) dirs.push(path.join(DSH_SESSIONS, d));
    }
    if (!dirs.length) return { ok: false, error: "未找到本项目 DSH 会话目录" };
    const items = [];
    for (const dir of dirs) { // 全量目录（修复：此前 slice(0,2) 只读前 2 个）
      for (const sub of readdirSyncSafe(dir).slice(0, limit)) {
        const f = path.join(dir, sub, "session.jsonl.zstd");
        if (!existsSync(f)) continue;
        // python zstandard 逐帧解压（只读管道，不落盘）——session.jsonl.zstd 是"每行一个 zstd 帧"
        // 的多帧格式（200 帧/会话：session 元数据 + user/message + assistant/chunk + step/start 等）。
        // 修复：此前 d.decompress(data) 只解第一帧（元数据 261 字节），消息在其余帧里完全没读，
        // 误判"仅元数据"——逐帧解压后提炼消息内容（user/message、assistant text-chunks、tool/call）
        const py = spawnSync("py", ["-3.12", "-c",
          "import zstandard,sys,json\n" +
          "data=open(sys.argv[1],'rb').read()\n" +
          "magic=b'\\x28\\xb5\\x2f\\xfd'\n" +
          "d=zstandard.ZstdDecompressor()\n" +
          "pos=0; lines=[]\n" +
          "while True:\n" +
          "  idx=data.find(magic,pos)\n" +
          "  if idx<0: break\n" +
          "  nxt=data.find(magic,idx+1)\n" +
          "  frame=data[idx:] if nxt<0 else data[idx:nxt]\n" +
          "  try:\n" +
          "    out=d.decompress(frame,max_output_size=1000000)\n" +
          "    lines.append(out.decode('utf-8',errors='replace'))\n" +
          "  except: pass\n" +
          "  pos=idx+1\n" +
          "msgs=[]\n" +
          "for l in lines:\n" +
          "  try:\n" +
          "    j=json.loads(l)\n" +
          "    t=j.get('type','')\n" +
          "    if t=='text-chunks':\n" +
          "      texts=j.get('data',{}).get('texts',[])\n" +
          "      if texts: msgs.append('assistant:'+''.join(texts)[:150])\n" +
          "    elif t=='user/message':\n" +
          "      content=j.get('data',{}).get('content',[])\n" +
          "      text=''\n" +
          "      for c in (content if isinstance(content,list) else []):\n" +
          "        if isinstance(c,dict) and c.get('type')=='text': text+=c.get('text','')\n" +
          "      if text: msgs.append('user:'+text[:150])\n" +
          "    elif t=='tool/call':\n" +
          "      name=j.get('data',{}).get('name','')\n" +
          "      if name: msgs.append('tool:'+str(name)[:60])\n" +
          "  except: pass\n" +
          "print('\\n'.join(msgs[:200]))\n", f],
          { encoding: "utf8", timeout: 30000, windowsHide: true });
        if (py.status === 0 && py.stdout) {
          const lines = String(py.stdout).split("\n").filter(Boolean);
          items.push({
            session: sub.slice(0, 8),
            createdAt: "",
            cwd: "",
            messages: lines.slice(0, 8), // 消息摘要（前 8 条展示；完整提炼由生成编排按需读）
            note: `消息摘要 ${lines.length} 条（含 assistant text-chunks；前 8 条展示）`,
          });
        }
      }
    }
    return { ok: items.length > 0, sessions: items, truncated: items.length >= limit };
  } catch (e) {
    return { ok: false, error: `DSH 读取失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

// ---------- 数据源：Codex 会话（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl，只读） ----------
// 每行 {timestamp, type, payload}——提炼最近会话的 type 序列（task_started/event_msg 等）
function readCodexHistory(limit = 5) {
  if (!existsSync(CODEX_SESSIONS)) return { ok: false, error: `Codex sessions 不存在（${CODEX_SESSIONS}）` };
  try {
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSyncSafe(dir)) {
        const p = path.join(dir, e);
        try { if (statSync(p).isDirectory()) walk(p); else if (e.endsWith(".jsonl")) files.push(p); } catch { /* ignore */ }
      }
    };
    walk(CODEX_SESSIONS);
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const items = files.slice(0, limit).map((f) => {
      const lines = readFileSync(f, "utf8").split("\n").filter(Boolean).slice(0, 5);
      const types = lines.map((l) => { try { return JSON.parse(l).type || ""; } catch { return ""; } }).filter(Boolean);
      return {
        file: path.basename(f).slice(0, 40),
        types: types.slice(0, 3).join("/"),
        mtime: new Date(statSync(f).mtimeMs).toISOString().slice(0, 10),
      };
    });
    return { ok: items.length > 0, sessions: items, truncated: items.length >= limit };
  } catch (e) {
    return { ok: false, error: `Codex 读取失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

// ---------- 数据源：Claude Code 会话（~/.claude/projects/<编码>/<id>.jsonl，只读） ----------
// 每行 {type, timestamp, sessionId, content}——提炼最近会话的 type 序列
function readClaudeHistory(limit = 5) {
  if (!existsSync(CLAUDE_PROJECTS)) return { ok: false, error: `Claude projects 不存在（${CLAUDE_PROJECTS}）` };
  try {
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSyncSafe(dir)) {
        const p = path.join(dir, e);
        try { if (statSync(p).isDirectory()) walk(p); else if (e.endsWith(".jsonl")) files.push(p); } catch { /* ignore */ }
      }
    };
    walk(CLAUDE_PROJECTS);
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const items = files.slice(0, limit).map((f) => {
      const lines = readFileSync(f, "utf8").split("\n").filter(Boolean).slice(0, 5);
      const types = lines.map((l) => { try { return JSON.parse(l).type || ""; } catch { return ""; } }).filter(Boolean);
      return {
        file: path.basename(f).slice(0, 40),
        types: types.slice(0, 3).join("/"),
        mtime: new Date(statSync(f).mtimeMs).toISOString().slice(0, 10),
      };
    });
    return { ok: items.length > 0, sessions: items, truncated: items.length >= limit };
  } catch (e) {
    return { ok: false, error: `Claude 读取失败: ${String(e?.message || e).slice(0, 80)}` };
  }
}

// ---------- 工具 1：read_dev_history（多源查询 + 截断诚实） ----------
export async function readDevHistory({ source = "all", limit = 10 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 60);
  const out = { ok: true, source, truncated: false };
  if (source === "git" || source === "all") {
    const g = readGitHistory(n);
    out.git = g;
    if (g.truncated) out.truncated = true;
  }
  if (source === "opencode" || source === "all") {
    const o = readOpencodeHistory(Math.min(n, 20));
    out.opencode = o;
    if (o.truncated) out.truncated = true;
  }
  if (source === "dsh" || source === "all") {
    const d = readDshHistory(Math.min(n, 5));
    out.dsh = d;
    if (d.truncated) out.truncated = true;
  }
  if (source === "codex" || source === "all") {
    const c = readCodexHistory(Math.min(n, 5));
    out.codex = c;
    if (c.truncated) out.truncated = true;
  }
  if (source === "cc" || source === "all") {
    const c = readClaudeHistory(Math.min(n, 5));
    out.cc = c;
    if (c.truncated) out.truncated = true;
  }
  // 截断诚实：总结果超限 → truncated 标记（复用 project-guide 覆盖范围透明模式）
  const json = JSON.stringify(out);
  if (json.length > MAX_RESULT_CHARS) {
    out.truncated = true;
    out.note = `结果已截断（${(json.length / 1024).toFixed(0)}KB > ${(MAX_RESULT_CHARS / 1024).toFixed(0)}KB 上限），可缩小 limit 或按 source 分查`;
  }
  return out;
}

// ---------- 工具 2：generate_dev_history_guide（编排：git → opencode → LLM → 存档） ----------
export async function generateDevHistoryGuide({ project = "mashiro-desktop", focus = "" } = {}) {
  try {
    // ① 数据收集（git 时间线 + opencode 会话 + DSH 预览 + Codex/Claude Code 会话）
    const git = readGitHistory(40);
    const opencode = readOpencodeHistory(15);
    const dsh = readDshHistory(3);
    const codex = readCodexHistory(3);
    const cc = readClaudeHistory(3);
    const gitText = git.ok
      ? git.commits.map((c) => `- ${c.date} ${c.hash} ${c.subject}`).join("\n")
      : `（git 不可用：${git.error}）`;
    const opencodeText = opencode.ok
      ? opencode.sessions.map((s) => `- ${s.time} [${s.agent || "?"}] ${s.title}（${s.model || "?"}，${s.tokens} tokens）`).join("\n")
      : `（opencode 不可用：${opencode.error}）`;
    const dshText = dsh.ok
      ? dsh.sessions.map((s) => `- ${s.createdAt} ${s.session}（${s.cwd}；${s.note || "预览"}`).join("\n")
      : `（DSH 不可用：${dsh.error}）`;
    const codexText = codex.ok
      ? codex.sessions.map((s) => `- ${s.mtime} ${s.file}（${s.types}）`).join("\n")
      : `（Codex 不可用：${codex.error}）`;
    const ccText = cc.ok
      ? cc.sessions.map((s) => `- ${s.mtime} ${s.file}（${s.types}）`).join("\n")
      : `（Claude Code 不可用：${cc.error}）`;

    // ② LLM 生成（开发历史面试文档模板）
    const prompt = `你是资深技术面试辅导。下面是「${project}」的真实开发历史数据（git 提交时间线 + opencode 开发会话 + DSH 对话会话），请生成**开发历史面试文档**（Markdown），用于面试官问"这个项目怎么开发的/开发过程"时回答：

## 项目开发时间线（git）
${gitText.slice(0, 4000)}

## 开发会话记录（opencode）
${opencodeText.slice(0, 3000)}

## 对话/调试会话（DSH）
${dshText.slice(0, 1500)}

## 编码会话（Codex）
${codexText.slice(0, 1000)}

## 编码会话（Claude Code）
${ccText.slice(0, 1000)}
${focus ? `\n用户指定重点：${focus}` : ""}

请生成：
## 开发历程总览
[项目从 0 到现在的开发阶段划分（如：基础架构 → 核心功能 → 质量工程 → 打磨），每阶段一句话]
### 关键时间节点
[引用真实 commit/会话日期，3-5 个里程碑]
### 技术演进
[技术选型如何随需求变化（引用真实 commit 主题/会话标题），2-4 条]
### 可讲的开发故事
[基于真实历史提炼 2-3 个"开发中遇到的坑/决策"故事，面试可展开]
### 数据支撑
[提交数/会话数/活跃周期等真实数字]

要求：**只基于上面提供的真实数据**——数据里没有的不许编造（防幻觉）；引用 commit/会话时用真实 hash/日期。`;

    const data = await llmChat(
      [
        { role: "system", content: "你是资深技术面试辅导，只基于提供的真实开发数据生成文档，不编造。" },
        { role: "user", content: prompt },
      ],
      { maxTokens: 3000, temperature: 0.4, timeout: 120000 }
    );
    let guide = getReplyText(data).trim();
    if (guide.length < 200) return { ok: false, error: "文档生成失败（LLM 返回过短）" };

    // ③ 覆盖范围段（诚实标注：完整/部分/未覆盖——复用 project-guide v2 模式）
    const coverage = [
      `- git 时间线：${git.ok ? `完整（${git.commits.length} 条${git.truncated ? "，截断" : ""}）` : `未覆盖（${git.error}）`}`,
      `- opencode 会话：${opencode.ok ? `完整（${opencode.sessions.length} 个${opencode.truncated ? "，截断" : ""}）` : `未覆盖（${opencode.error}）`}`,
      `- DSH 会话：${dsh.ok ? `部分（${dsh.sessions.length} 个预览${dsh.truncated ? "，截断" : ""}）` : `未覆盖（${dsh.error}）`}`,
    ].join("\n");
    guide = `${guide}\n\n## 覆盖范围\n${coverage}`;

    // ④ 存档 output/dev-history-guides/<项目名>.md（文件名清洗防路径注入）
    const safeName = String(project).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, `${safeName}.md`);
    writeFileSync(outPath, `# ${project} 开发历史面试文档\n\n> 生成时间：${new Date().toLocaleString("zh-CN")}\n> 来源：git log + opencode.db（readOnly）+ DSH 会话（只读）\n\n${guide}\n`, "utf8");

    return {
      ok: true,
      project,
      path: outPath,
      sections: [...guide.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 8),
      coverage: { git: git.ok, opencode: opencode.ok, dsh: dsh.ok, truncated: git.truncated || opencode.truncated || dsh.truncated },
      preview: guide.slice(0, 300),
      hint: `开发历史文档已存档：${outPath}。可让我查某段时间的详细历史（read_dev_history source=git/opencode）或调整重点重新生成。`,
    };
  } catch (e) {
    return { ok: false, error: `文档生成失败: ${String(e?.message || e).slice(0, 150)}` };
  }
}

// ---------- 工具注册（skill__dev_history_guide__* 命名空间由 skills.mjs 装配） ----------
export const tools = [
  {
    name: "read_dev_history",
    description:
      "读取项目开发历史（只读）：git 时间线（提交 hash/日期/主题）+ opencode 开发会话（标题/模型/token）+ DSH 对话会话（预览）。source 可过滤（git/opencode/dsh/all）。大结果返回 truncated 标记（截断诚实）。用于生成开发历史文档前收集素材、以及用户追问某时段细节时查证。",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["all", "git", "opencode", "dsh", "codex", "cc"], description: "数据源（默认 all：git/opencode/dsh/codex/cc 全查）" },
        limit: { type: "number", description: "条数上限（默认 10，最大 60）" },
      },
    },
    permission: "auto", // 只读
    async run({ source, limit }) {
      return readDevHistory({ source, limit });
    },
  },
  {
    name: "generate_dev_history_guide",
    description:
      "生成开发历史面试文档：git 时间线 + opencode 会话 + DSH 会话 → LLM 生成（开发历程/关键节点/技术演进/可讲故事/数据支撑）→ 存档 output/dev-history-guides/<项目名>.md，文档末尾标注覆盖范围（完整/部分/未覆盖）。适合用户说'生成开发历史面试文档/我的开发历程怎么讲'。",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "项目名（默认 mashiro-desktop）" },
        focus: { type: "string", description: "用户指定重点（如'讲讲质量工程'）" },
      },
    },
    permission: "auto", // 只读 + 写文档到 output/
    async run({ project, focus }) {
      return generateDevHistoryGuide({ project, focus });
    },
  },
];
