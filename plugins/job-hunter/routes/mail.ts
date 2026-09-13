// mail 域路由（纵向拆分：/api/mail* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as mailApi from "#lib/mail.mjs";

// 全量 TS 升级工单阶段 4（插件）：实现迁至 mail.ts，mail.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown；message 为空/非 Error 抛出退回 String(e)） */
const eMsg = (e: unknown): string => {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(e);
};

export function registerMailRoutes(router: Router): void {
router.route("/api/mail/config", (req: IncomingMessage, res: ServerResponse) => {  // 邮箱配置：GET 读取（脱敏，不返回授权码），POST 保存（持久化到 settings mail_config）
  if (req.method === "GET") {
    try {
      const cfg = mailApi.getConfig();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, config: { email: cfg.email, enabled: cfg.enabled, configured: !!(cfg.email && cfg.authCode) } }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
    return;
  }
  if (req.method === "POST") {
    readBody(req, res, (body: string) => {
      try {
        const { email, authCode, enabled } = JSON.parse(body || "{}");
        const r = mailApi.setConfig({ email, authCode, enabled });
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
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

router.route("/api/mail/test", "POST", (req: IncomingMessage, res: ServerResponse) => {  // 测试连接：用提交的邮箱/授权码连 IMAP（不落库）
  readBody(req, res, async (body: string) => {
    try {
      const { email, authCode } = JSON.parse(body || "{}");
      const r = await mailApi.testConnection({ email, authCode });
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: eMsg(e) }));
    }
  });
  });

router.route("/api/mail/check", "POST", (req: IncomingMessage, res: ServerResponse) => {  // 立即检查：拉未读 → LLM 识别 → 入库（同步等待结果返回给面板）
  (async () => {
    try {
      const r = await mailApi.runMailCheck();
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: eMsg(e).slice(0, 200) }));
    }
  })();
  });

}
