// focus 域路由（纵向拆分：/api/focus* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as focusApi from "#lib/focus.mjs";

export function registerFocusRoutes(router) {

router.route("/api/focus/start", "POST", (req, res) => {  // 开始专注（番茄钟 25/45 分钟）
  readBody(req, res, (body) => {
    try {
      const { mode } = JSON.parse(body || "{}");
      const r = focusApi.startFocus(String(mode || ""));
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
  });
router.route("/api/focus/stop", "POST", (req, res) => {  // 结束专注（completed=true 表示完成，false 表示中断）
  readBody(req, res, (body) => {
    try {
      const { completed } = JSON.parse(body || "{}");
      const r = focusApi.stopFocus(!!completed);
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
  });
router.route("/api/focus/distract", "POST", (req, res) => {  // 记录一次分心（桌宠主进程检测到分心应用时上报）
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(focusApi.recordDistract()));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
  });

router.route("/api/focus/status", (req, res) => {  // 专注状态（桌宠主进程轮询 + 面板倒计时）
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...focusApi.getFocusStatus() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
  });

router.route("/api/focus/stats", (req, res) => {  // 今日专注统计
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...focusApi.getFocusStats() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
  });
router.route("/api/focus/blacklist", (req, res) => {  // 分心黑名单：GET 读取（含默认值），POST 修改（持久化到 settings）
  if (req.method === "GET") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, blacklist: focusApi.getBlacklist(), defaults: focusApi.DEFAULT_BLACKLIST }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const { blacklist } = JSON.parse(body || "{}");
        const r = focusApi.setBlacklist(blacklist);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });}
