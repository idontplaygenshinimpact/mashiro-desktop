// rss 域路由（纵向拆分：/api/rss* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as rssApi from "#lib/rss.mjs";

export function registerRssRoutes(router, { getCorsOrigin = () => "*" } = {}) {
router.route("/api/rss/digest", (req, res) => {  // 今日技术资讯摘要（读取，不触发抓取）
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    ok: true,
    today: rssApi.localToday(),
    digest: rssApi.getDigest(),
    lastDigestAt: rssApi.getLastDigestAt() || null,
    feeds: rssApi.getFeeds().length,
  }));
  });

router.route("/api/rss/check", "POST", (req, res) => {  // 手动触发：抓取 + LLM 摘要（同步等待结果返回给面板）
  (async () => {
    try {
      const r = await rssApi.runDailyDigest();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...r }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200), digest: rssApi.getDigest(), lastDigestAt: rssApi.getLastDigestAt() || null }));
    }
  })();
  });

router.route("/api/rss/config", (req, res) => {  // feed 列表：GET 读取，POST 修改（持久化到 settings）
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, feeds: rssApi.getFeeds(), defaultFeeds: rssApi.DEFAULT_FEEDS }));
    return;
  }
  if (req.method === "POST") {
    readBody(req, res, (body) => {
      try {
        const { feeds } = JSON.parse(body || "{}");
        const r = rssApi.setFeeds(feeds);
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
  });}
