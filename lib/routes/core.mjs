// 核心基础设施域路由（纵向拆分：health/widget-data/chat/stats/observability/refresh/notify/
// approval/run-discover/patrol/progress/schedule + 首页）
// 依赖注入：getCorsOrigin、laneSubmit、runtime —— runtime 所有字段都是取数函数
// （widget.mjs 的 patrolState/crawlMutex/DISABLE_PATROL/actualPort 声明在注册点之后，
//  且 actualPort 端口回退后会变，统一用 () => x 在请求时取值，规避 TDZ 与闭包快照）
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
import { saveImportedPost } from "../output-import.mjs";

// 服务版本（面板 /api/health 检测"后台 widget 是旧进程"用：新版返回 version 字段，
// 旧版无此字段 → 面板提示重启。读 package.json，读不到给 "dev" 保证字段恒存在）
const SERVICE_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return String(pkg.version || "dev");
  } catch { return "dev"; }
})();

export function registerCoreRoutes(router, { laneSubmit = (fn) => fn(), runtime = {} } = {}) {
  // runtime 取数函数（全部可选，缺省给安全空实现，保证模块可独立测试）
  const rt = {
    getActualPort: () => 8899,
    parseTitle: (_file) => ({}),
    getStudyPlan: () => ({ date: "", bishi: [], mianshi: [] }),
    checkTrends: async () => {},
    sendNotification: (_t, _m, _o) => {},
    logErr: (_m) => {},
    runDiscoverHidden: () => {},
    crawlMutex: () => ({ isRunning: () => false }),
    patrolGetConfig: () => ({}),
    patrolWriteSetting: (_k, _v) => {},
    patrolSetBudget: (_t) => ({ ok: true }),
    patrolGetBudget: () => 0,
    patrolGetUsed: () => 0,
    patrolScheduleNext: () => {},
    patrolState: () => ({}),
    patrolDisabled: () => false,
    patrolRun: async () => {},
    patrolMinMinutes: () => 15,
    patrolMaxMinutes: () => 1440,
    pluginList: () => [],
    pluginToggle: (_id, _enabled) => ({ ok: false, error: "插件管理未注入" }),
    pluginReadSettings: (_id) => ({ ok: false, error: "插件管理未注入" }),
    pluginWriteSetting: (_id, _key, _value) => ({ ok: false, error: "插件管理未注入" }),
    pluginInstall: async (_id) => ({ ok: false, error: "插件管理未注入" }),
    pluginMarket: () => ({ ok: false, error: "插件管理未注入" }),
    backupCreate: async () => ({ ok: false, error: "备份未注入" }),
    backupList: () => ({ ok: true, backups: [] }),
    backupRestore: (_name) => ({ ok: false, error: "备份未注入" }),
    ...runtime,
  };

  router.route("/api/health", (req, res) => {
    // 机器可读健康检查（无需认证）：DB 连通性 + 运行时长 + 实际端口
    let dbOk = false;
    try {
      db.prepare("SELECT 1").get();
      dbOk = true;
    } catch { /* ignore */ }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(buildHealthPayload(dbOk, Math.round(process.uptime()), rt.getActualPort(), SERVICE_VERSION)));
  });

  router.route("/api/widget-data", (req, res) => {
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

  router.route("/api/chat", (req, res) => {
    // 桌宠对话：用户消息 → agent 工具循环 → 回复（走串行 lane，防并发竞争 memory 镜像）
    readBody(req, res, async (body) => {
      try {
        const { message, history } = JSON.parse(body || "{}");
        if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: "message required" })); return; }
        const result = await laneSubmit(() => chatWithAgent(message, history || []));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(e?.statusCode || 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message, stack: String(e.stack).slice(0, 300) }));
      }
    });
  });

  router.route("/api/stats", (req, res) => {
    // 使用统计（对话/复习/面试/答题）
    try {
      const m = memory.get();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, stats: m.stats || {} }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/observability", (req, res) => {
    // 可观测性：LLM 调用统计 + 最近调用 + 工具链
    try {
      const llm = getLLMStats();
      const tools = getRecentTools(8);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, llm, tools }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/refresh", (req, res) => {
    rt.checkTrends()
      .then(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch((err) => {
        rt.logErr(`refresh checkTrends 异常: ${err && err.message ? err.message : String(err)}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
  });

  router.route("/api/notify-test", (req, res) => {
    rt.sendNotification("✅ 通知测试", "Mashiro 小组件通知正常");
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
  });

  router.route("/api/approval-pending", (req, res) => {
    // 权限审批：查询当前待审批的工具调用（面板轮询）
    try {
      const pendingList = getPendingApprovals();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, pending: pendingList, sessionApproved: getSessionApproved() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/approval", (req, res) => {
    // 权限审批：用户决策（allow/session）
    readBody(req, res, (body) => {
      try {
        const { toolName, allow, session } = JSON.parse(body || "{}");
        if (!toolName) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "toolName required" })); return; }
        const r = resolveApproval(toolName, { allow: !!allow, session: !!session });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: r.ok, ...r }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/run-discover", (req, res) => {
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

  router.route("/api/patrol-config", (req, res) => {
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
      readBody(req, res, (body) => {
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
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });

  router.route("/api/patrol-run", "POST", (req, res) => {
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
  router.route("/api/output/import", "POST", (req, res) => {
    readBody(req, res, (body) => {
      try {
        const input = /** @type {any} */ (body || {}); // 请求体（readBody 已解析 JSON；类型放宽便于字段访问）
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
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/progress", (req, res) => {
    // 桌宠轮询爬取进度
    try {
      const p = JSON.parse(readFileSync(path.join(config.outputDir, "..", "progress.json"), "utf8"));
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(p));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "idle", message: "暂无爬取任务" }));
    }
  });

  router.route("/api/schedule", (req, res) => {
    // 未来日程列表（面试/笔试邀约）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, events: mailApi.getSchedule() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 插件管理（阶段 3：列表/启停/设置/市场安装） ----------
  router.route("/api/plugins", (req, res) => {
    // 已发现插件列表：manifest + 加载结果 + 启停标记（管理页数据源）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, plugins: rt.pluginList() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/plugins/toggle", "POST", (req, res) => {
    // 启停插件（写标记；路由在当前进程仍生效，重启后按新状态加载）
    readBody(req, res, (body) => {
      try {
        const { id, enabled } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(rt.pluginToggle(String(id), enabled !== false)));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/plugins/settings", (req, res, url) => {
    // 插件面板设置：GET ?plugin=<id> 读（只返回 manifest 声明的 key）；POST {id,key,value} 写
    if (req.method === "GET") {
      try {
        const id = String(url?.searchParams?.get("plugin") || "");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "plugin required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(rt.pluginReadSettings(id)));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === "POST") {
      readBody(req, res, (body) => {
        try {
          const { id, key, value } = JSON.parse(body || "{}");
          if (!id || !key) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id/key required" })); return; }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(rt.pluginWriteSetting(String(id), String(key), value)));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });

  router.route("/api/plugins/install", "POST", (req, res) => {
    // 市场安装插件（下载声明文件到 plugins/<id>；重启后生效）
    readBody(req, res, async (body) => {
      try {
        const { id } = JSON.parse(body || "{}");
        if (!id) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "id required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(await rt.pluginInstall(String(id))));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  router.route("/api/plugins/market", (req, res) => {
    // 插件市场（data/plugin-market.json 注册表）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rt.pluginMarket()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  // ---------- 数据备份与恢复（数据安全：自动/手动备份 + 列表 + 恢复标记，重启生效） ----------
  router.route("/api/backup", "POST", (req, res) => {
    // 立即备份（面板"💾 立即备份"；自动备份由 widget 启动后定时触发）
    rt.backupCreate()
      .then((r) => { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(r)); })
      .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
  });

  router.route("/api/backups", (req, res) => {
    // 备份列表（时间倒序：原因/文件清单/大小）
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rt.backupList()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  router.route("/api/backups/restore", "POST", (req, res) => {
    // 标记恢复（复制为 pending，重启后自动替换；替换前自动快照当前状态）
    readBody(req, res, (body) => {
      try {
        const { name } = JSON.parse(body || "{}");
        if (!name) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "name required" })); return; }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(rt.backupRestore(String(name))));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  const homePage = (req, res) => {
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
