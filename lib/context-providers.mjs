// 对话上下文提供者注册表（单一数据源：个人数据环境 → agent/MCP）
// 每个 provider 是"数据接入点"：{ id, name, desc, tools: [{name, desc}], load() }
// load() 返回 { summary, data }：data 供 executeProviderTool 按需读取（MCP/agent 工具调用）
// 消费方：mcp-server.mjs（mcp__mianshi__get_* 工具 → executeProviderTool）。
// 说明：早期曾有"context-config.json 可配 tool/prompt 注入"机制（buildProviderTools/
// buildPromptSection/loadContextConfig/getEnabledProviders），审计确认全项目无消费方、
// data/context-config.json 从未创建——死代码已移除，避免"看似可配实则无效"误导。

// ---------- 内置 providers（全部个人数据环境） ----------
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
];

/** 查 provider by id */
export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** 分发执行：provider 工具名 → 实际加载数据（供 MCP/agent 工具调用；单数据源） */
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
