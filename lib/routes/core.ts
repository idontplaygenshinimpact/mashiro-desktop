// 核心基础设施域路由（纵向拆分：health/widget-data/chat/stats/observability/refresh/notify/
// approval/run-discover/patrol/progress/schedule + 首页）
// 依赖注入：getCorsOrigin、laneSubmit、runtime —— runtime 所有字段都是取数函数
// （widget.mjs 的 patrolState/crawlMutex/DISABLE_PATROL/actualPort 声明在注册点之后，
//  且 actualPort 端口回退后会变，统一用 () => x 在请求时取值，规避 TDZ 与闭包快照）
// 全量 TS 升级工单阶段 3：本文件为唯一实现，lib/routes/core.mjs 降为同名薄桶（widget.mjs 零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../../config.mjs";
import { db } from "../db.mjs";
import { memory } from "../memory.mjs";
import { getLLMStats, getRecentTools } from "../trace.mjs";
import * as mailApi from "../mail.mjs";
import { getPendingApprovals, resolveApproval, getSessionApproved } from "../permission.mjs";
import { chatWithAgent } from "../agent.mjs";
import * as reviewApi from "../review.mjs";
import { scanNewestFiles, latestOutputs, buildHealthPayload, readBody } from "../widget-core.mjs";
import { saveImportedPost } from "../output-import.ts";
import { createSSEPush, withContract } from "./contract.mjs";
import { ChatStreamEvent } from "../contracts/sse.mjs";
import { ChatInput, ChatOutput, ChatSessionListOutput, ChatMessagesOutput, ChatSessionDeleteInput, ChatSessionDeleteOutput } from "../contracts/chat.mjs";
import { drainExpressions } from "../events.mjs";
import { PetEventsOutput } from "../contracts/misc.mjs";
import type { Router } from "./router.mjs";

/** 错误信息提取（catch 变量在 strict 模式下是 unknown） */
const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 错误信息（与迁移前 `err && err.message ? err.message : String(err)` 等价：
 *  message 为空/非 Error 抛出都退回 String(err)，不引入新的空串输出） */
const errText = (err: unknown): string => {
  const m = (err as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(err);
};

/** 注入的运行时取数函数袋（全部可选，缺省给安全空实现，保证模块可独立测试）。
 * 注入点：widget.mjs registerCoreRoutes(router, { laneSubmit, runtime: { ... } })。
 * 全部是 () => x 取数函数：patrolState/crawlMutex/DISABLE_PATROL/actualPort 等在注册点之后声明（TDZ）
 * 或运行期会变（端口回退），请求时求值才能规避 TDZ 与闭包快照。
 * 注：字段的具体类型待 widget.mjs（阶段 4：服务入口）迁 .ts 后按注入点收口——
 * 现阶段按注入袋处理，与迁移前 JS 的类型面一致（不放宽任何运行时行为）。 */
export interface CoreRuntime {
  [k: string]: any;
}

/** registerCoreRoutes 选项（laneSubmit 缺省直通：单测里注册路由不依赖 lane 队列） */
export interface CoreRoutesOptions {
  laneSubmit?: (fn: () => any) => any;
  runtime?: CoreRuntime;
}

// 服务版本（面板 /api/health 检测"后台 widget 是旧进程"用：新版返回 version 字段，
// 旧版无此字段 → 面板提示重启。读 package.json，读不到给 "dev" 保证字段恒存在）
const SERVICE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return String(pkg.version || "dev");
  } catch { return "dev"; }
})();

export function registerCoreRoutes(router: Router, { laneSubmit = (fn: () => any) => fn(), runtime = {} }: CoreRoutesOptions = {}) {
  // runtime 取数函数（全部可选，缺省给安全空实现，保证模块可独立测试）
  const rt: CoreRuntime = {
    getActualPort: () => config.widgetPort, // 技术债 L4：端口收编 config 单点
    parseTitle: (_file: unknown) => ({}),
    getStudyPlan: () => ({ date: "", bishi: [], mianshi: [] }),
    checkTrends: async () => {},
    sendNotification: (_t: unknown, _m: unknown, _o?: unknown) => {},
    logErr: (_m: unknown) => {},
    runDiscoverHidden: () => {},
    crawlMutex: () => ({ isRunning: () => false }),
    patrolGetConfig: () => ({}),
    patrolWriteSetting: (_k: unknown, _v: unknown) => {},
    patrolSetBudget: (_t: unknown) => ({ ok: true }),
    patrolGetBudget: () => 0,
    patrolGetUsed: () => 0,
    patrolScheduleNext: () => {},
    patrolState: () => ({}),
    patrolDisabled: () => false,
    patrolRun: async () => {},
    patrolMinMinutes: () => 15,
    patrolMaxMinutes: () => 1440,
    pluginList: () => [],
    pluginToggle: (_id: unknown, _enabled: unknown) => ({ ok: false, error: "插件管理未注入" }),
    pluginReadSettings: (_id: unknown) => ({ ok: false, error: "插件管理未注入" }),
    pluginWriteSetting: (_id: unknown, _key: unknown, _value: unknown) => ({ ok: false, error: "插件管理未注入" }),
    pluginInstall: async (_id: unknown) => ({ ok: false, error: "插件管理未注入" }),
    pluginMarket: () => ({ ok: false, error: "插件管理未注入" }),
    backupCreate: async () => ({ ok: false, error: "备份未注入" }),
    backupList: () => ({ ok: true, backups: [] }),
    backupRestore: (_name: unknown) => ({ ok: false, error: "备份未注入" }),
    ...runtime,
  };

  router.route("/api/health", (req: IncomingMessage, res: ServerResponse) => {
    // 机器可读健康检查（无需认证）：DB 连通性 + 运行时长 + 实际端口
    let dbOk = false;
    try {
      db.prepare("SELECT 1").get();
      dbOk = true;
    } catch { /* ignore */ }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(buildHealthPayload(dbOk, Math.round(process.uptime()), rt.getActualPort(), SERVICE_VERSION)));
  });

  router.route("/api/widget-data", (req: IncomingMessage, res: ServerResponse) => {
    // 看板娘数据：学习计划 + 最新产出 + 趋势 + 爬取进度
    const plan = rt.getStudyPlan();
    const files = scanNewestFiles(12, config.outputDir).map((f) => {
      const { company, title } = rt.parseTitle(f.file);
      return { company, title, dir: f.dir, path: f.path, mtime: f.mtime.toISOString() };
    });
    const outputs = latestOutputs(6, config.outputDir).map((o) => ({ dir: o.dir, mtime: o.mtime.toISOString() }));
    let progress = { status: "idle", message: "暂无爬取任务" };
    try {
      progress = JSON.parse(readFileSync(path.join(config.outputDir, "..", "progress.json"), "utf8"));
    } catch { /* ignore */ }
    let reviewStats = { total: 0, due: 0 };
    try { reviewStats = reviewApi.review.getStats(); } catch { /* ignore */ }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, plan, files, outputs, progress, review: reviewStats, time: new Date().toISOString() }));
  });

  router.route("/api/chat", "POST", withContract(
    // 桌宠对话（契约化：ChatInput 校验入参 / ChatOutput 约束出参）
    async (input) => {
      // sessionId：多会话隔离（无则归 'default'；聊天记录按会话落库/读取）
      return laneSubmit(() =>
        chatWithAgent(input.message, input.history || [], null, input.sessionId || "default")
      );
    },
    { input: ChatInput, output: ChatOutput }
  ));

  // ---------- 多会话管理（对话 Tab：新建/切换/删除，测试与真实对话互不干扰） ----------
  router.route("/api/chat/sessions", "GET", withContract(
    () => ({ ok: true, sessions: memory.listChatSessions() }),
    { output: ChatSessionListOutput }
  ));
  router.route("/api/chat/messages", "GET", withContract(
    (_input, { req }) => {
      const u = new URL(String(req.url), "http://x");
      const session = u.searchParams.get("session") || "default";
      return { ok: true, messages: memory.getChatMessages(session, 40) };
    },
    { output: ChatMessagesOutput }
  ));
  router.route("/api/chat/session", "DELETE", withContract(
    (input) => memory.deleteChatSession(String(input.id)),
    { input: ChatSessionDeleteInput, output: ChatSessionDeleteOutput }
  ));

  router.route("/api/chat-stream", (req: IncomingMessage, res: ServerResponse) => {
    // 对话（流式过程版）：SSE 实时推送 agent 工具事件（tool_start/tool_done/tool_error），
    // 最后 done 事件带完整回复。解决"agent 在干嘛用户完全看不到"的可观测性问题。
    readBody(req, res, async (body: string) => {
      try {
        const { message, history, sessionId } = JSON.parse(body || "{}");
        if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: "message required" })); return; }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.on("error", () => {});
        // 统一 SSE push（Phase 2 §3.4：ChatStreamEvent 契约，开发期 MIANSHI_SSE_STRICT=1 校验漂移）
        const { push } = createSSEPush(res, { eventSchema: ChatStreamEvent });
        push({ type: "start" });
        // 排入 lane 串行队列（与 /api/chat 同互斥，防并发竞争 memory 镜像）；事件实时透传
        const result = await laneSubmit(() =>
          chatWithAgent(message, history || [], (ev) => push({ ...ev, type: ev.type === "done" ? "agent_done" : ev.type }), sessionId || "default")
        );
        push({ type: "done", reply: result.reply, history: result.history || [] });
        res.end();
      } catch (e) {
        if (!res.destroyed && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "error", error: errText(e).slice(0, 200) })}\n\n`);
          res.end();
        }
      }
    });
  });

  router.route("/api/stats", (req: IncomingMessage, res: ServerResponse) => {
    // 使用统计（对话/复习/面试/答题）
    try {
      const m = memory.get();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stats: m.stats || {} }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/observability", (req: IncomingMessage, res: ServerResponse) => {
    // 可观测性：LLM 调用统计 + 最近调用 + 工具链
    try {
      const llm = getLLMStats();
      const tools = getRecentTools(8);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, llm, tools }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/refresh", (req: IncomingMessage, res: ServerResponse) => {
    rt.checkTrends()
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((err: unknown) => {
        const msg = errText(err);
        rt.logErr(`refresh checkTrends 异常: ${msg}`);
        // 修复：异常不再假装成功（此前 catch 分支仍返回 ok:true，面板误以为刷新成功）
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: msg }));
      });
  });

  router.route("/api/notify-test", (req: IncomingMessage, res: ServerResponse) => {
    rt.sendNotification("✅ 通知测试", "Mashiro 小组件通知正常");
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
  });

  router.route("/api/approval-pending", (req: IncomingMessage, res: ServerResponse) => {
    // 权限审批：查询当前待审批的工具调用（面板轮询）
    try {
      const pendingList = getPendingApprovals();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, pending: pendingList, sessionApproved: getSessionApproved() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/approval", (req: IncomingMessage, res: ServerResponse) => {
    // 权限审批：用户决策（allow/session）
    readBody(req, res, (body: string) => {
      try {
        const { toolName, allow, session } = JSON.parse(body || "{}");
        if (!toolName) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "toolName required" })); return; }
        const r = resolveApproval(toolName, { allow: !!allow, session: !!session });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...r, ok: r.ok }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/run-discover", (req: IncomingMessage, res: ServerResponse) => {
    // 重置进度并后台启动爬取（spawn 隐藏窗口 + 日志重定向，不弹终端）
    if (rt.crawlMutex().isRunning()) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "已有爬取任务运行中" }));
      return;
    }
    try {
      writeFileSync(path.join(config.outputDir, "..", "progress.json"), JSON.stringify({ status: "running", step: "start", message: "爬取启动中...", current: 0, total: 0 }), "utf8");
    } catch { /* ignore */ }
    rt.runDiscoverHidden();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, msg: "后台已触发" }));
  });

  router.route("/api/patrol-config", (req: IncomingMessage, res: ServerResponse) => {
    // 巡检配置：GET 读取（enabled/intervalMin/lastRun/nextRun/dailyTokenBudget/usedToday），POST 修改（即时重排定时器）
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      const cfg = rt.patrolGetConfig();
      res.end(JSON.stringify({
        ...cfg,
        dailyTokenBudget: rt.patrolGetBudget(),
        usedToday: rt.patrolGetUsed(),
      }));
      return;
    }
    if (req.method === "POST") {
      readBody(req, res, (body: string) => {
        try {
          const cfg = JSON.parse(body || "{}");
          if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "enabled 必须是布尔值" })); return;
          }
          if (cfg.intervalMin !== undefined) {
            const n = Math.round(Number(cfg.intervalMin));
            if (!Number.isInteger(n) || n < rt.patrolMinMinutes() || n > rt.patrolMaxMinutes()) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: `intervalMin 必须是 ${rt.patrolMinMinutes()}-${rt.patrolMaxMinutes()} 之间的整数分钟` })); return;
            }
            rt.patrolState().intervalMin = n;
            rt.patrolWriteSetting("patrol_interval_min", String(n));
          }
          if (cfg.dailyTokenBudget !== undefined) {
            const r = rt.patrolSetBudget(cfg.dailyTokenBudget);
            if (!r.ok) { res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(r)); return; }
          }
          if (cfg.enabled !== undefined) {
            if (rt.patrolDisabled() && cfg.enabled) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "环境变量 MIANSHI_DISABLE_PATROL=1 已强制关闭巡检，无法在面板开启" })); return;
            }
            rt.patrolState().enabled = cfg.enabled;
            rt.patrolWriteSetting("patrol_enabled", cfg.enabled ? "1" : "0");
          }
          if (cfg.avoidPeak !== undefined && typeof cfg.avoidPeak === "boolean") {
            rt.patrolState().avoidPeak = cfg.avoidPeak;
            rt.patrolWriteSetting("patrol_avoid_peak", cfg.avoidPeak ? "1" : "0");
          }
          rt.patrolScheduleNext(); // 改配置：取消旧 timer 重排
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ...rt.patrolGetConfig(),
            dailyTokenBudget: rt.patrolGetBudget(),
            usedToday: rt.patrolGetUsed(),
          }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: eMsg(e) }));
        }
      });
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });

  router.route("/api/patrol-run", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 立即手动巡检一次（不重排定时器、不更新 lastRun）
    if (rt.patrolDisabled()) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "环境变量 MIANSHI_DISABLE_PATROL=1 已强制关闭巡检" }));
      return;
    }
    rt.patrolRun().catch(() => {});
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, msg: "已触发巡检" }));
  });

  // 手动导入面经（别处获取的面经/文档 → 产出目录，与爬取同构：自动被巡检/面试素材识别）
  router.route("/api/output/import", "POST", (req: IncomingMessage, res: ServerResponse) => {
    readBody(req, res, (body: string) => {
      // 修复：body 是原始字符串，直接当对象用 → title/content 恒 undefined → 接口恒 400
      let input;
      try {
        input = /** @type {any} */ (JSON.parse(body || "{}"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "请求体必须是 JSON" }));
        return;
      }
      try {
        const r = saveImportedPost({ title: input.title, content: input.content, source: input.source });
        if (!r.ok) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(r));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, file: r.file, name: r.name }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/progress", (req: IncomingMessage, res: ServerResponse) => {
    // 桌宠轮询爬取进度
    try {
      const p = JSON.parse(readFileSync(path.join(config.outputDir, "..", "progress.json"), "utf8"));
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(p));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "idle", message: "暂无爬取任务" }));
    }
  });

  router.route("/api/schedule", (req: IncomingMessage, res: ServerResponse) => {
    // 未来日程列表（面试/笔试邀约）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, events: mailApi.getSchedule() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  // ---------- 插件管理（阶段 3：列表/启停/设置/市场安装） ----------
  router.route("/api/plugins", (req: IncomingMessage, res: ServerResponse) => {
    // 已发现插件列表：manifest + 加载结果 + 启停标记（管理页数据源）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, plugins: rt.pluginList() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/plugins/toggle", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 启停插件（写标记；路由在当前进程仍生效，重启后按新状态加载）
    readBody(req, res, (body: string) => {
      try {
        const { id, enabled } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(rt.pluginToggle(String(id), enabled !== false)));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/plugins/settings", (req: IncomingMessage, res: ServerResponse, url?: URL) => {
    // 插件面板设置：GET ?plugin=<id> 读（只返回 manifest 声明的 key）；POST {id,key,value} 写
    if (req.method === "GET") {
      try {
        const id = String(url?.searchParams?.get("plugin") || "");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "plugin required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(rt.pluginReadSettings(id)));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
      return;
    }
    if (req.method === "POST") {
      readBody(req, res, (body: string) => {
        try {
          const { id, key, value } = JSON.parse(body || "{}");
          if (!id || !key) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id/key required" })); return; }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(rt.pluginWriteSetting(String(id), String(key), value)));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: eMsg(e) }));
        }
      });
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });

  router.route("/api/plugins/install", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 市场安装插件（下载声明文件到 plugins/<id>；重启后生效）
    readBody(req, res, async (body: string) => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(await rt.pluginInstall(String(id))));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/plugins/market", (req: IncomingMessage, res: ServerResponse) => {
    // 插件市场（data/plugin-market.json 注册表）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rt.pluginMarket()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  // ---------- 数据备份与恢复（数据安全：自动/手动备份 + 列表 + 恢复标记，重启生效） ----------
  router.route("/api/backup", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 立即备份（面板"💾 立即备份"；自动备份由 widget 启动后定时触发）
    rt.backupCreate()
      .then((r: any) => { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(r)); })
      .catch((e: unknown) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: eMsg(e) })); });
  });

  router.route("/api/backups", (req: IncomingMessage, res: ServerResponse) => {
    // 备份列表（时间倒序：原因/文件清单/大小）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rt.backupList()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });

  router.route("/api/backups/restore", "POST", (req: IncomingMessage, res: ServerResponse) => {
    // 标记恢复（复制为 pending，重启后自动替换；替换前自动快照当前状态）
    readBody(req, res, (body: string) => {
      try {
        const { name } = JSON.parse(body || "{}");
        if (!name) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "name required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(rt.backupRestore(String(name))));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: eMsg(e) }));
      }
    });
  });

  router.route("/api/pet-events", "GET", withContract(
    // 桌宠伴侣表达队列 drain（主进程 2s 轻轮询取走即清空；Bearer 认证在分发层已有）
    // 事件驱动内核 W1：仅当有表达才返回非空 events，空闲零开销
    () => ({ ok: true, events: drainExpressions() }),
    { output: PetEventsOutput }
  ));

  const homePage = (req: IncomingMessage, res: ServerResponse) => {
    // 最小状态页（健康检查/浏览器访问）：真实 UI 在 Electron 面板
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mashiro 服务</title></head>
<body style="font-family:sans-serif;background:#121218;color:#e8e8ef;padding:20px">
<h3>📌 Mashiro 数据服务运行中</h3>
<p>完整面板在桌宠（双击真白打开）。此页面仅供健康检查。</p>
<p>状态: <span style="color:#5fd85f">OK</span> · ${new Date().toLocaleString("zh-CN")}</p>
</body></html>`);
  };
  router.route("/", homePage);
  router.route("/index.html", homePage);
}
