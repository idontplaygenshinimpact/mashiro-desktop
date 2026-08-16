// 对话上下文提供者注册表（OpenClaw 插件式参考）
// 目标：对话模块可配——哪些模块的内容能进入对话（工具 or 常驻 prompt），由 data/context-config.json 控制
// 每个 provider 是一个"数据接入点"：{ id, name, desc, tools: [{name, desc}], load() }
// load() 返回 { summary, data }：summary 用于常驻 prompt（短），data 用于按需工具（全量）

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(import.meta.dirname, "..", "data", "context-config.json");

// ---------- 内置 providers（全部个人数据环境） ----------
// 默认全启用；用户在 context-config.json 里可增删
const PROVIDERS = [
  {
    id: "resume",
    name: "个人简历",
    desc: "个人主页上传的简历（教育/项目/技能/求职目标）",
    tools: [{ name: "get_personal_profile", desc: "查看个人主页上传的简历内容" }],
    async load() {
      try {
        const { getResumeProfile, getResumeRaw } = await import("./jobs.mjs");
        const raw = getResumeRaw ? getResumeRaw() : null;
        if (!raw) return { summary: "未上传简历", data: null, has: false };
        const profile = getResumeProfile ? getResumeProfile() : {};
        // 方向真实来源：getTargetDirection（settings target_direction）；profile 只有 skills/directions
        let target = "";
        try {
          const { getTargetDirection } = await import("./jobs.mjs");
          target = (getTargetDirection ? getTargetDirection() : "") || profile?.directions?.[0] || "";
        } catch { target = profile?.directions?.[0] || ""; }
        return {
          summary: `已上传简历${target ? `，目标：${target}` : ""}`,
          data: raw && typeof raw === "object" ? JSON.stringify(raw) : String(raw ?? "").slice(0, 3000),
          has: true,
        };
      } catch (e) {
        return { summary: "简历读取失败", data: null, has: false, error: String(e.message || e).slice(0, 80) };
      }
    },
  },
  {
    id: "jobs",
    name: "校招推荐",
    desc: "岗位推荐/投递状态/收藏/公司统计",
    tools: [{ name: "get_jobs_status", desc: "查看校招推荐岗位、投递状态、收藏与统计" }],
    async load() {
      try {
        const { getRecommendedJobs, getJobs, getJobStats, getTargetDirection } = await import("./jobs.mjs");
        const stats = getJobStats ? getJobStats() : {};
        const rec = getRecommendedJobs ? getRecommendedJobs(5) : [];
        // 已投递状态是 "ready"（new/ready/ready_bishi/done 白名单；"已投递"是面板展示文案不是存储值）
        const applied = getJobs ? getJobs({ status: "ready" }) : [];
        const direction = getTargetDirection ? getTargetDirection() : null;
        return {
          summary: `推荐岗位 ${Array.isArray(rec) ? rec.length : 0} 个${direction ? `，方向：${direction}` : ""}`,
          data: {
            direction,
            stats,
            recommended: (Array.isArray(rec) ? rec : []).map((j) => {
              const jd = /** @type {any} */ (j);
              return { company: jd.company, title: jd.title, match: jd.matchScore ?? jd.match, deadline: jd.deadline, url: jd.url || jd.applyUrl };
            }),
            appliedCount: Array.isArray(applied) ? applied.length : 0,
            appliedRecent: (Array.isArray(applied) ? applied : []).slice(0, 5).map((j) => {
              const jd = /** @type {any} */ (j);
              return { company: jd.company, title: jd.title, status: jd.status };
            }),
          },
          has: true,
        };
      } catch (e) {
        return { summary: "校招数据读取失败", data: null, has: false, error: String(e.message || e).slice(0, 80) };
      }
    },
  },
  {
    id: "schedule",
    name: "面试日程",
    desc: "面试/笔试邀约日程（邮箱识别）",
    tools: [{ name: "get_schedule_events", desc: "查看面试/笔试日程安排" }],
    async load() {
      try {
        const { getSchedule } = await import("./mail.mjs");
        const ev = getSchedule ? getSchedule() : [];
        return {
          summary: `未来日程 ${Array.isArray(ev) ? ev.length : 0} 项`,
          data: (Array.isArray(ev) ? ev : []).slice(0, 10).map((e) => ({ company: e.company, role: e.role, interviewAt: e.interviewAt, form: e.form, location: e.location, link: e.link })),
          has: true,
        };
      } catch (e) {
        return { summary: "日程读取失败", data: null, has: false, error: String(e.message || e).slice(0, 80) };
      }
    },
  },
  {
    id: "study_progress",
    name: "学习进度",
    desc: "学习清单/复习卡/专项练习/真题/专注统计",
    tools: [{ name: "get_study_progress", desc: "查看学习进度总览（清单/复习/oj/真题/专注）" }],
    async load() {
      const out = { has: true };
      try {
        const { getPlan } = await import("./study.mjs");
        const plan = getPlan ? getPlan() : { items: [] };
        const items = plan.items || [];
        out.data = {
          plan: { total: items.length, done: items.filter((i) => i.done).length, pending: items.filter((i) => !i.done).slice(0, 8).map((i) => i.topic) },
        };
      } catch { out.data = {}; }
      try {
        const { review } = await import("./review.mjs");
        out.data.review = review?.getStats ? review.getStats() : null;
      } catch { /* ignore */ }
      try {
        const { getOjStats } = await import("./oj.mjs");
        out.data.oj = getOjStats ? getOjStats() : null;
      } catch { /* ignore */ }
      try {
        const { getZhentiStats } = await import("./zhenti.mjs");
        out.data.zhenti = getZhentiStats ? getZhentiStats() : null;
      } catch { /* ignore */ }
      try {
        const { getFocusStats } = await import("./focus.mjs");
        out.data.focus = getFocusStats ? getFocusStats() : null;
      } catch { /* ignore */ }
      out.summary = `学习清单 ${out.data.plan?.total || 0} 条（完成 ${out.data.plan?.done || 0}）`;
      return out;
    },
  },
  {
    id: "memory_ext",
    name: "记忆扩展",
    desc: "画像/关注点/薄弱点/已掌握（基础记忆的扩展视图）",
    tools: [{ name: "get_memory", desc: "查看用户画像/关注点/学习进度/简历摘要/推荐岗位" }],
    async load() {
      return { summary: "基础记忆", data: null, has: true };
    },
  },
];

// ---------- 配置读写 ----------
export function loadContextConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const j = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      if (Array.isArray(j.enabled)) return { enabled: j.enabled, mode: j.mode === "prompt" ? "prompt" : "tool" };
    }
  } catch { /* ignore */ }
  // 默认：全部启用 + 按需工具模式（省 token；OpenClaw 同款"按需取"思路）
  return { enabled: PROVIDERS.map((p) => p.id), mode: "tool" };
}

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

export function getEnabledProviders(config = loadContextConfig()) {
  return config.enabled.map((id) => getProvider(id)).filter(Boolean);
}

// 常驻 prompt 段：把启用的 provider 摘要拼成 system prompt 附注（mode=prompt 用）
export async function buildPromptSection(config = loadContextConfig()) {
  if (config.mode !== "prompt") return "";
  const parts = [];
  for (const p of getEnabledProviders(config)) {
    try {
      const r = await p.load();
      if (r && r.summary) parts.push(`${p.name}：${r.summary}`);
    } catch { /* ignore */ }
  }
  return parts.length ? `\n[个人数据快照]\n${parts.join("\n")}\n（数据来源：个人主页/学习记录，仅作参考；需要细节时用对应工具读取）` : "";
}

// 按需工具：把启用的 provider 转成工具定义（mode=tool 用）——agent 自主决定何时调用
export function buildProviderTools(config = loadContextConfig()) {
  if (config.mode !== "tool") return [];
  const tools = [];
  for (const p of getEnabledProviders(config)) {
    for (const t of p.tools || []) {
      tools.push({ type: "function", function: { name: t.name, description: t.desc, parameters: { type: "object", properties: {} } } });
    }
  }
  return tools;
}

// 分发执行：provider 工具名 → 实际加载数据（供 executeTool 调用）
export async function executeProviderTool(toolName) {
  for (const p of PROVIDERS) {
    const t = (p.tools || []).find((x) => x.name === toolName);
    if (t) {
      try {
        const r = await p.load();
        if (!r || !r.has) return { ok: true, empty: true, message: `${p.name}暂无数据`, ...(r || {}) };
        return { ok: true, data: r.data, note: `${p.name}（来自个人数据环境）` };
      } catch (e) {
        return { ok: false, error: String(e.message || e).slice(0, 120) };
      }
    }
  }
  return { ok: false, error: `未知提供者工具: ${toolName}` };
}
