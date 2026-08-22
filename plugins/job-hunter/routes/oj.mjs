// oj 域路由（纵向拆分：/api/oj* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as ojApi from "#lib/oj.mjs";

export function registerOjRoutes(router, { getCorsOrigin = () => "*" } = {}) {
router.route("/api/oj/problems", (req, res) => {  // 牛客专项练习 TOP101 题目清单（GET；?category=&difficulty= 过滤）
  try {
    const { searchParams } = new URL(req.url, "http://x");
    const list = ojApi.getOjProblems({
      category: searchParams.get("category") || "",
      difficulty: searchParams.get("difficulty") || "",
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, problems: list, ...ojApi.getOjStats() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
  });
router.route("/api/oj/detail", (req, res) => {  // 抓取单题内容到本地（GET ?url=；懒加载 + 缓存）
  const { searchParams } = new URL(req.url, "http://x");
  const u = String(searchParams.get("url") || "").trim();
  if (!/^https?:\/\/(www\.)?nowcoder\.com\/practice\//i.test(u)) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "仅支持牛客题目页链接" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  ojApi.fetchOjDetail(u).then((r) => {
    res.end(JSON.stringify(r));
  }).catch((e) => {
    res.end(JSON.stringify({ ok: false, error: e.message }));
  });
  });
router.route("/api/oj/collect-all-stream", (req, res) => {  // 批量下载全部题目内容到本地（SSE 进度流，串行防反爬，约 5-8 分钟）
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": getCorsOrigin(req),
  });
  res.on("error", () => {}); // 客户端断开兜底
  const send = (obj) => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  ojApi.collectAllOjDetails((done, total, title) => {
    send({ type: "progress", done, total, title: String(title).slice(0, 30) });
  }).then((r) => {
    send({ type: "done", ...r });
    res.end();
  }).catch((e) => {
    send({ type: "error", error: e.message });
    res.end();
  });
  });
router.route("/api/oj/collect", (req, res) => {  // 抓取/更新 TOP101 清单（POST）
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  ojApi.collectOjProblems().then((r) => {
    res.end(JSON.stringify(r));
  }).catch((e) => {
    res.end(JSON.stringify({ ok: false, error: e.message }));
  });
  });}
