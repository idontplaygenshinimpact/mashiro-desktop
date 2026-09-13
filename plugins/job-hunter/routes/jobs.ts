// jobs 域路由（纵向拆分：/api/jobs* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as jobsApi from "#lib/jobs.mjs";
import * as jobMatchApi from "#lib/job-match.mjs";
import * as studyApi from "#lib/study.mjs";
import { config } from "#root/config.mjs"; // 技术债 L4：端口收编 config 单点

// 全量 TS 升级工单阶段 4（插件）：实现迁至 jobs.ts，jobs.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown；message 为空/非 Error 抛出退回 String(e)） */
const eMsg = (e: unknown): string => {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(e);
};

export function registerJobsRoutes(router: Router): void {
  const PORT = config.widgetPort; // 技术债 L4：端口收编 config 单点

router.route("/api/jobs/profile", "GET", (req: IncomingMessage, res: ServerResponse) => {  // 查询简历状态（画像 + 原文是否已保存）
  try {
    const profile = jobMatchApi.getResumeProfile();
    const raw = jobMatchApi.getResumeRaw();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      profile,
      rawSaved: !!raw,
      rawText: raw?.text || "",
      rawLength: raw?.text?.length || 0,
      rawUpdatedAt: raw?.updatedAt || 0,
    }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: eMsg(e) }));
  }
  });
router.route("/api/jobs/profile", "POST", (req: IncomingMessage, res: ServerResponse) => {  // 简历技能画像（驱动岗位匹配；原文一并保存供后续复用）
  readBody(req, res, async (body: string) => {
    try {
      const { resume } = JSON.parse(body || "{}");
      if (!resume || !String(resume).trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "resume required" })); return; }
      const r = await jobMatchApi.setResumeProfile(resume);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/jobs/direction", (req: IncomingMessage, res: ServerResponse) => {  // 设置意向方向（多选）+ 简历驱动闭环联动（知识树模板/方向画像自动跟随，手动配过的不覆盖）+ 调整建议
  readBody(req, res, async (body: string) => {
    try {
      const b = JSON.parse(body || "{}");
      // 2026-09 多选：directions 数组（兼容旧单值 direction）
      const directions = Array.isArray(b.directions) ? b.directions : (b.direction ? [b.direction] : []);
      const set = jobMatchApi.setTargetDirection(directions);
      if (!set.ok) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify(set)); return; }
      // setTargetDirection 的返回类型里 directions 是可选的，但 ok=true 分支必带（实现只有两条 return）
      const dirs = set.directions as string[];
      const { applyDirectionAuto, applyDirectionsProfile } = await import("#lib/career.mjs");
      const auto = applyDirectionAuto(String(dirs[0] || ""));
      const profileAuto = applyDirectionsProfile(set.directions); // 多方向画像合并（无手动画像时）
      const advice = await jobMatchApi.generateDirectionAdvice();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // advice 恒带 ok 字段（返回类型 required）→ 原 { ok: true, ...advice, ... } 的 ok: true 必被覆盖，等价
      res.end(JSON.stringify({ ...advice, auto, profileAuto }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/jobs", (req: IncomingMessage, res: ServerResponse) => {  // 校招岗位列表（可过滤 status/direction）
  try {
    const u = new URL(String(req.url), `http://127.0.0.1:${PORT}`);
    const jobs = jobsApi.getJobs({ status: u.searchParams.get("status") || undefined, direction: u.searchParams.get("direction") || undefined });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, jobs }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: eMsg(e) }));
  }
  });
router.route("/api/jobs/recommended", (req: IncomingMessage, res: ServerResponse) => {  // 推荐岗位（匹配度排序）
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, recommended: jobMatchApi.getRecommendedJobs(), stats: jobsApi.getJobStats() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: eMsg(e) }));
  }
  });
router.route("/api/jobs/status", (req: IncomingMessage, res: ServerResponse) => {  // 更新投递状态
  readBody(req, res, async (body: string) => {
    try {
      const { id, status } = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(jobsApi.setJobStatus(id, status)));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/jobs/favorite", (req: IncomingMessage, res: ServerResponse) => {  // 收藏/取消收藏岗位（body {id, favorite}）
  readBody(req, res, async (body: string) => {
    try {
      const { id, favorite } = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(jobsApi.setJobFavorite(id, favorite ? 1 : 0)));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/jobs/daily-collect", (req: IncomingMessage, res: ServerResponse) => {  // 每日自动搜集（POST 手动触发一次；GET 查询状态）
  if (req.method === "GET") {
    try {
      const last = jobsApi.getJobsLastCollect();
      const due = !last || Date.now() - last >= 24 * 3600 * 1000;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, lastCollect: last || 0, due, nextIn: last ? Math.max(0, 24 * 3600 * 1000 - (Date.now() - last)) : 0 }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
    return;
  }
  readBody(req, res, async (_body: string) => {
    try {
      const r = await jobsApi.collectJobsDaily();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // collectJobsDaily 恒带 ok 字段（返回类型 required）→ 原 { ok: true, ...r } 的 ok: true 必被覆盖，等价
      res.end(JSON.stringify(r.skipped ? { ok: true, skipped: true, message: "距上次搜集不足 24h，跳过（可等定时器或清空时间戳强制）" } : { ...r, message: `新增 ${r.totalNew} 条岗位` }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/jobs/collect", (req: IncomingMessage, res: ServerResponse) => {  // 搜集校招岗位：官网优先 → 公司名单 → 中厂兜底（POST 触发；可传 step / skipDetails）
  readBody(req, res, async (body: string) => {
    try {
      const { step, skipDetails } = JSON.parse(body || "{}");
      const result: Record<string, unknown> = {};
      if (!step || step === "official") {
        result.official = await jobsApi.collectFromOfficialSites();
        // 官网步骤跑完自动补 JD 详情（可选 skipDetails=true 跳过）
        if (!skipDetails) result.details = await jobsApi.fetchJobDetails();
      }
      if (!step || step === "companies") result.companies = await jobsApi.collectCompanyList();
      if (!step || step === "fallback") result.fallback = await jobsApi.collectJobsForCompaniesWithoutSite();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/jobs/fetch-details", (req: IncomingMessage, res: ServerResponse) => {  // 手动触发：抓官网岗位详情页 JD 正文入库（POST；返回 {ok,total,done,failed,updated,skipped}）
  readBody(req, res, async (body: string) => {
    try {
      JSON.parse(body || "{}"); // 仅校验 body 合法（预留参数位）
      const r = await jobsApi.fetchJobDetails();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // fetchJobDetails 恒带 ok 字段（返回类型 required）→ 原 { ok: true, ...r } 的 ok: true 必被覆盖，等价
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/companies", (req: IncomingMessage, res: ServerResponse) => {  // 公司档案列表
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, companies: jobsApi.getCompanies() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: eMsg(e) }));
  }
  });
router.route("/api/resume-plan", (req: IncomingMessage, res: ServerResponse) => {  // 简历项目 → 学习清单（简历拷打准备）：提取项目 → 每个项目作为"必会"清单条目
  readBody(req, res, async (body: string) => {
    try {
      const { resume: bodyResume } = JSON.parse(body || "{}");
      // 闭环：未传简历时自动读设置中心已上传的简历（与 interview startInterview 同一策略）
      let resume = String(bodyResume || "").trim();
      if (!resume) {
        try { resume = String(jobMatchApi.getResumeRaw?.()?.text || "").trim(); } catch { /* ignore */ }
      }
      if (!resume) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "resume required（或先在设置中心上传简历）" })); return; }
      const { extractResumeProjects } = await import("#lib/ai.ts");
      // 显式标注产出形状（extractResumeProjects 产出 name/techStack/description）——strict 下 map 回调不再隐式 any
      const projects: Array<{ name: string; techStack: string; description: string }> = await extractResumeProjects(resume);
      if (!projects.length) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, added: 0, projects: [], message: "未从简历中识别到项目" })); return; }
      // 同步：简历更新 → 删除过时的未完成项目条目（如简历移除了网易云音乐项目，清单不再残留）
      const sync = studyApi.syncResumeProjectItems(projects.map((p) => p.name));
      const r = studyApi.addPlanItems(projects.map((p) => ({
        topic: `项目·${p.name}`,
        why: `简历项目拷打准备${p.techStack ? `（${p.techStack}）` : ""}：${p.description}`,
        source: "简历拷打",
        group: "简历项目", // 固定分组：简历项目条目集中显示，不再散落"未分类"
        verify_question: `用 30 秒电梯陈述讲清「${p.name}」，然后准备被深挖：技术选型 trade-off / 架构 / 个人贡献 / 难点踩坑 / 量化指标`,
        level: "必会",
      })));
      const msg = `已将 ${r.added} 个简历项目加入学习清单${sync.removed ? `，清理 ${sync.removed} 个已过时项目条目` : ""}`;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, added: r.added, removed: sync.removed, projects, message: msg }));
    } catch (e) {
      res.writeHead((e as { statusCode?: number })?.statusCode || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });}
