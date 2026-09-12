// 对话上下文提供者注册表（单一数据源：个人数据环境 → agent/MCP）
// 每个 provider 是"数据接入点"：{ id, name, desc, tools: [{name, desc}], load() }
// load() 返回 { summary, data }：data 供 executeProviderTool 按需读取（MCP/agent 工具调用）
// 消费方：mcp-server.mjs（mcp__mashiro__get_* 工具 → executeProviderTool）。
// 说明：早期曾有"context-config.json 可配 tool/prompt 注入"机制（buildProviderTools/
// buildPromptSection/loadContextConfig/getEnabledProviders），审计确认全项目无消费方、
// data/context-config.json 从未创建——死代码已移除，避免"看似可配实则无效"误导。
// 全量 TS 升级工单阶段 3：lib/context-providers.mjs → .ts（4 处调用方均在 mcp-server.mjs → 桶化零改动）

/** provider 暴露的工具声明 */
export interface ProviderTool {
  name: string;
  desc: string;
}

/** provider.load() 结果：has=false 表示"确实没数据"，error 表示"读取失败"（两者必须区分） */
export interface ProviderLoad {
  summary: string;
  data?: unknown;
  has: boolean;
  error?: string;
}

/** 一个数据接入点 */
export interface Provider {
  id: string;
  name: string;
  desc: string;
  tools: ProviderTool[];
  load: () => Promise<ProviderLoad>;
}

/** executeProviderTool 的统一返回（MCP/agent 消费） */
export interface ProviderToolResult {
  ok: boolean;
  data?: unknown;
  note?: string;
  empty?: boolean;
  message?: string;
  error?: string;
}

/** 宽松记录类型：各业务模块（.mjs）返回的实体（岗位/日程等）字段不固定 */
type Rec = Record<string, unknown>;

// ---------- 内置 providers（全部个人数据环境） ----------
const PROVIDERS: Provider[] = [
  {
    id: "resume",
    name: "个人简历",
    desc: "个人主页上传的简历（教育/项目/技能/求职目标）",
    tools: [{ name: "get_personal_profile", desc: "查看个人主页上传的简历内容" }],
    async load(): Promise<ProviderLoad> {
      try {
        const { getResumeProfile, getResumeRaw } = await import("./job-match.mjs");
        const raw = getResumeRaw ? getResumeRaw() : null;
        if (!raw) return { summary: "未上传简历", data: null, has: false };
        const profile = (getResumeProfile ? getResumeProfile() : {}) as Rec;
        // 方向真实来源：getTargetDirection（settings target_direction，job-match 模块）；profile 只有 skills/directions
        let target = "";
        try {
          const { getTargetDirection } = await import("./job-match.mjs");
          const directions = profile?.directions as string[] | undefined;
          // 2026-09 起 getTargetDirection 返回多选数组；原来直接把数组塞进 string 槽（隐式 join），
          // 这里显式拼接（join(",") 与旧的数组隐式 toString 输出一致，多方向不丢信息）
          const dirs = getTargetDirection ? getTargetDirection() : null;
          target = (Array.isArray(dirs) ? dirs.join(",") : dirs) || directions?.[0] || "";
        } catch {
          const directions = profile?.directions as string[] | undefined;
          target = directions?.[0] || "";
        }
        return {
          summary: `已上传简历${target ? `，目标：${target}` : ""}`,
          data: raw && typeof raw === "object" ? JSON.stringify(raw) : String(raw ?? "").slice(0, 3000),
          has: true,
        };
      } catch (e) {
        return { summary: "简历读取失败", data: null, has: false, error: String((e as Error).message || e).slice(0, 80) };
      }
    },
  },
  {
    id: "jobs",
    name: "校招推荐",
    desc: "岗位推荐/投递状态/收藏/公司统计",
    tools: [{ name: "get_jobs_status", desc: "查看校招推荐岗位、投递状态、收藏与统计" }],
    async load(): Promise<ProviderLoad> {
      try {
        const { getRecommendedJobs, getTargetDirection } = await import("./job-match.mjs");
        const { getJobs, getJobStats } = await import("./jobs.mjs");
        const stats = getJobStats ? getJobStats() : {};
        const rec = getRecommendedJobs ? getRecommendedJobs(5) : [];
        // 已投递状态是 "ready"（new/ready/ready_bishi/done 白名单；"已投递"是面板展示文案不是存储值）
        const applied = getJobs ? getJobs({ status: "ready" }) : [];
        const direction = getTargetDirection ? getTargetDirection() : null;
        const recList: Rec[] = Array.isArray(rec) ? (rec as Rec[]) : [];
        const appliedList: Rec[] = Array.isArray(applied) ? (applied as Rec[]) : [];
        return {
          summary: `推荐岗位 ${recList.length} 个${direction ? `，方向：${direction}` : ""}`,
          data: {
            direction,
            stats,
            recommended: recList.map((j) => ({
              company: j.company, title: j.title, match: j.matchScore ?? j.match, deadline: j.deadline, url: j.url || j.applyUrl,
            })),
            appliedCount: appliedList.length,
            appliedRecent: appliedList.slice(0, 5).map((j) => ({ company: j.company, title: j.title, status: j.status })),
          },
          has: true,
        };
      } catch (e) {
        return { summary: "校招数据读取失败", data: null, has: false, error: String((e as Error).message || e).slice(0, 80) };
      }
    },
  },
  {
    id: "schedule",
    name: "面试日程",
    desc: "面试/笔试邀约日程（邮箱识别）",
    tools: [{ name: "get_schedule_events", desc: "查看面试/笔试日程安排" }],
    async load(): Promise<ProviderLoad> {
      try {
        const { getSchedule } = await import("./mail.mjs");
        const ev = getSchedule ? getSchedule() : [];
        const evList: Rec[] = Array.isArray(ev) ? (ev as Rec[]) : [];
        return {
          summary: `未来日程 ${evList.length} 项`,
          data: evList.slice(0, 10).map((e) => ({ company: e.company, role: e.role, interviewAt: e.interviewAt, form: e.form, location: e.location, link: e.link })),
          has: true,
        };
      } catch (e) {
        return { summary: "日程读取失败", data: null, has: false, error: String((e as Error).message || e).slice(0, 80) };
      }
    },
  },
  {
    id: "study_progress",
    name: "学习进度",
    desc: "学习清单/复习卡/专项练习/真题/专注统计",
    tools: [{ name: "get_study_progress", desc: "查看学习进度总览（清单/复习/oj/真题/专注）" }],
    async load(): Promise<ProviderLoad> {
      const data: Rec = {};
      try {
        const { getPlan } = await import("./study.mjs");
        const plan = (getPlan ? getPlan() : { items: [] }) as { items?: Array<Rec> };
        const items = plan.items || [];
        data.plan = {
          total: items.length,
          done: items.filter((i) => i.done).length,
          pending: items.filter((i) => !i.done).slice(0, 8).map((i) => i.topic),
        };
      } catch { /* 清单读取失败 → plan 缺省（summary 显示 0 条） */ }
      try {
        const { review } = await import("./review.mjs");
        data.review = review?.getStats ? review.getStats() : null;
      } catch { /* ignore */ }
      try {
        const { getOjStats } = await import("./oj.mjs");
        data.oj = getOjStats ? getOjStats() : null;
      } catch { /* ignore */ }
      try {
        const { getZhentiStats } = await import("./zhenti.mjs");
        data.zhenti = getZhentiStats ? getZhentiStats() : null;
      } catch { /* ignore */ }
      try {
        const { getFocusStats } = await import("./focus.mjs");
        data.focus = getFocusStats ? getFocusStats() : null;
      } catch { /* ignore */ }
      const planStat = data.plan as { total?: number; done?: number } | undefined;
      return { has: true, summary: `学习清单 ${planStat?.total || 0} 条（完成 ${planStat?.done || 0}）`, data };
    },
  },
];

/** 查 provider by id */
export function getProvider(id: string): Provider | null {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** 分发执行：provider 工具名 → 实际加载数据（供 MCP/agent 工具调用；单数据源） */
export async function executeProviderTool(toolName: string): Promise<ProviderToolResult> {
  for (const p of PROVIDERS) {
    const t = (p.tools || []).find((x) => x.name === toolName);
    if (t) {
      try {
        const r = await p.load();
        if (!r || !r.has) {
          // 加载失败（error）与确实为空必须区分：失败透传错误，不能误导为"暂无数据"
          if (r?.error) return { ok: false, error: `读取${p.name}失败: ${String(r.error).slice(0, 120)}` };
          return { ok: true, empty: true, message: `${p.name}暂无数据` };
        }
        return { ok: true, data: r.data, note: `${p.name}（来自个人数据环境）` };
      } catch (e) {
        return { ok: false, error: String((e as Error).message || e).slice(0, 120) };
      }
    }
  }
  return { ok: false, error: `未知提供者工具: ${toolName}` };
}
