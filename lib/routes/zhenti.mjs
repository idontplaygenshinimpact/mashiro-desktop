// zhenti 域路由（纵向拆分：/api/zhenti* 从 widget.mjs 迁出）
import { readBody } from "../widget-core.mjs";
import * as zhentiApi from "../zhenti.mjs";

export function registerZhentiRoutes(router, { getCorsOrigin = () => "*" } = {}) {
router.route("/api/zhenti", (req, res) => {  // 牛客大厂官方真题清单（GET；?company= 过滤）
  try {
    const { searchParams } = new URL(req.url, "http://x");
    const list = zhentiApi.getZhentiList({ company: searchParams.get("company") || "" });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, papers: list, ...zhentiApi.getZhentiStats() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
  });
router.route("/api/zhenti/collect", (req, res) => {  // 搜集真题清单（POST；可传 { details: 20 } 顺带抓题型详情；{ company: "拼多多" } 按公司搜索搜集）
  readBody(req, res, async (body) => {
    try {
      const { details, company } = JSON.parse(body || "{}");
      const r = company
        ? await zhentiApi.collectZhentiByCompany(company)
        : await zhentiApi.collectZhentiList();
      const detailsResult = details ? await zhentiApi.collectZhentiDetails(details) : null;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ...r, details: detailsResult, message: `${company ? `「${company}」真题搜集完成` : "真题搜集完成"}：新增 ${r.added} 条` }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  });
router.route("/api/zhenti/cookie", (req, res) => {  // 保存牛客 Cookie（POST { cookie }，本地落盘）
  readBody(req, res, async (body) => {
    try {
      const { cookie } = JSON.parse(body || "{}");
      const r = zhentiApi.saveNowcoderCookie(cookie);
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  });
router.route("/api/zhenti/questions", (req, res) => {  // 登录态抓取试卷完整题目（POST { paperTestId }）
  readBody(req, res, async (body) => {
    try {
      const { paperTestId } = JSON.parse(body || "{}");
      if (!paperTestId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "paperTestId required" })); return; }
      const r = await zhentiApi.fetchPaperQuestions(paperTestId);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  });
router.route("/api/zhenti/wrong", (req, res) => {  // 错题回流：学习清单 + FSRS 复习卡（POST { paperId, company, paperTitle, question, answer }）
  readBody(req, res, async (body) => {
    try {
      const { paperId, company, paperTitle, question, answer } = JSON.parse(body || "{}");
      if (!question || !String(question).trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "question required" })); return; }
      const r = await zhentiApi.addWrongQuestion({ paperId, company, paperTitle, question, answer });
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  });
router.route("/api/zhenti/plan", (req, res) => {  // 整套真题加入学习清单（POST { paperTestId }）
  readBody(req, res, async (body) => {
    try {
      const { paperTestId } = JSON.parse(body || "{}");
      if (!paperTestId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "paperTestId required" })); return; }
      const r = await zhentiApi.addPaperToPlan(paperTestId);
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  });}
