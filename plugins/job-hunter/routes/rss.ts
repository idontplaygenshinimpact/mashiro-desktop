// rss 域路由（纵向拆分：/api/rss* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as rssApi from "#lib/rss.mjs";

// 全量 TS 升级工单阶段 4（插件）：实现迁至 rss.ts，rss.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown） */
const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerRssRoutes(router: Router): void {
router.route("/api/rss/digest", (req: IncomingMessage, res: ServerResponse) => {  // 今日技术资讯摘要（读取，不触发抓取）
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    ok: true,
    today: rssApi.localToday(),
    digest: rssApi.getDigest(),
    lastDigestAt: rssApi.getLastDigestAt() || null,
    feeds: rssApi.getFeeds().length,
  }));
  });

router.route("/api/rss/check", "POST", (req: IncomingMessage, res: ServerResponse) => {  // 手动触发：抓取 + LLM 摘要（同步等待结果返回给面板）
  (async () => {
    try {
      const r = await rssApi.runDailyDigest();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...r }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(eMsg(e) || e).slice(0, 200), digest: rssApi.getDigest(), lastDigestAt: rssApi.getLastDigestAt() || null }));
    }
  })();
  });

router.route("/api/rss/config", (req: IncomingMessage, res: ServerResponse) => {  // feed 列表：GET 读取，POST 修改（持久化到 settings）
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, feeds: rssApi.getFeeds(), defaultFeeds: rssApi.DEFAULT_FEEDS }));
    return;
  }
  if (req.method === "POST") {
    readBody(req, res, (body: string) => {
      try {
        const { feeds } = JSON.parse(body || "{}");
        const r = rssApi.setFeeds(feeds);
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
  });}
