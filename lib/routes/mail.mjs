// mail 域路由（纵向拆分：/api/mail* 从 widget.mjs 迁出）
import { readBody } from "../widget-core.mjs";
import * as mailApi from "../mail.mjs";

export function registerMailRoutes(router, { getCorsOrigin = () => "*" } = {}) {
router.route("/api/mail/config", (req, res) => {  // 邮箱配置：GET 读取（脱敏，不返回授权码），POST 保存（持久化到 settings mail_config）
  if (req.method === "GET") {
    try {
      const cfg = mailApi.getConfig();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, config: { email: cfg.email, enabled: cfg.enabled, configured: !!(cfg.email && cfg.authCode) } }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const { email, authCode, enabled } = JSON.parse(body || "{}");
        const r = mailApi.setConfig({ email, authCode, enabled });
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r));
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

router.route("/api/mail/test", "POST", (req, res) => {  // 测试连接：用提交的邮箱/授权码连 IMAP（不落库）
  readBody(req, res, async (body) => {
    try {
      const { email, authCode } = JSON.parse(body || "{}");
      const r = await mailApi.testConnection({ email, authCode });
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
  });

router.route("/api/mail/check", "POST", (req, res) => {  // 立即检查：拉未读 → LLM 识别 → 入库（同步等待结果返回给面板）
  (async () => {
    try {
      const r = await mailApi.runMailCheck();
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
    }
  })();
  });

}
