// focus 域路由（纵向拆分：/api/focus* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as focusApi from "#lib/focus.mjs";

// 全量 TS 升级工单阶段 4（插件）：实现迁至 focus.ts，focus.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown；message 为空/非 Error 抛出退回 String(e)） */
const eMsg = (e: unknown): string => {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(e);
};

export function registerFocusRoutes(router: Router): void {

router.route("/api/focus/start", "POST", (req: IncomingMessage, res: ServerResponse) => {  // 开始专注（番茄钟 25/45 分钟）
  readBody(req, res, (body: string) => {
    try {
      const { mode, goal, restMinutes } = JSON.parse(body || "{}");
      const r = focusApi.startFocus(String(mode || ""), { goal, restMinutes });
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
    }
  });
  });
router.route("/api/focus/stop", "POST", (req: IncomingMessage, res: ServerResponse) => {  // 结束专注（completed=true 表示完成，false 表示中断）
  readBody(req, res, (body: string) => {
    try {
      const { completed } = JSON.parse(body || "{}");
      const r = focusApi.stopFocus(!!completed);
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
    }
  });
  });
router.route("/api/focus/distract", "POST", (req: IncomingMessage, res: ServerResponse) => {  // 记录一次分心（桌宠主进程检测到分心应用时上报）
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(focusApi.recordDistract()));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
  }
  });

router.route("/api/focus/status", (req: IncomingMessage, res: ServerResponse) => {  // 专注状态（桌宠主进程轮询 + 面板倒计时）
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...focusApi.getFocusStatus() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
  }
  });

router.route("/api/focus/stats", (req: IncomingMessage, res: ServerResponse) => {  // 今日专注统计
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, ...focusApi.getFocusStats() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
  }
  });
router.route("/api/focus/blacklist", (req: IncomingMessage, res: ServerResponse) => {  // 分心黑名单：GET 读取（含默认值），POST 修改（持久化到 settings）
  if (req.method === "GET") {
    try {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // 契约：blacklist + whitelist 都要返回（面板两个文本框都读；曾漏 whitelist → 白名单框永远空白）
      res.end(JSON.stringify({ ok: true, blacklist: focusApi.getBlacklist(), whitelist: focusApi.getWhitelist(), defaults: focusApi.DEFAULT_BLACKLIST }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
    }
    return;
  }
  if (req.method === "POST") {
    readBody(req, res, (body: string) => {
      try {
        // 契约：面板一次提交 {blacklist, whitelist}；曾只解构 blacklist → 白名单保存被静默丢弃
        const { blacklist, whitelist } = JSON.parse(body || "{}");
        const r = focusApi.setBlacklist(blacklist);
        if (r.ok && Array.isArray(whitelist)) focusApi.setWhitelist(whitelist);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
      }
    });
    return;
  }
  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method Not Allowed" }));
  });}
