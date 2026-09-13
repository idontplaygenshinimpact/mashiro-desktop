// zhenti 域路由（纵向拆分：/api/zhenti* 从 widget.mjs 迁出）
import { readBody } from "#lib/widget-core.mjs";
import * as zhentiApi from "#lib/zhenti.mjs";

// 全量 TS 升级工单阶段 4（插件）：实现迁至 zhenti.ts，zhenti.mjs 保留同名薄桶（插件按路径加载 → 入口与调用方零改动）
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "#lib/routes/router.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown；message 为空/非 Error 抛出退回 String(e)） */
const eMsg = (e: unknown): string => {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return m ? String(m) : String(e);
};

export function registerZhentiRoutes(router: Router): void {
router.route("/api/zhenti", (req: IncomingMessage, res: ServerResponse) => {  // 牛客大厂官方真题清单（GET；?company= 过滤）
  try {
    const { searchParams } = new URL(String(req.url), "http://x");
    const list = zhentiApi.getZhentiList({ company: searchParams.get("company") || "" });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, papers: list, ...zhentiApi.getZhentiStats() }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: eMsg(e) }));
  }
  });
router.route("/api/zhenti/collect", (req: IncomingMessage, res: ServerResponse) => {  // 搜集真题清单（POST；可传 { details: 20 } 顺带抓题型详情；{ company: "拼多多" } 按公司搜索搜集）
  readBody(req, res, async (body: string) => {
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
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/zhenti/cookie", (req: IncomingMessage, res: ServerResponse) => {  // 保存牛客 Cookie（POST { cookie }，本地落盘）
  readBody(req, res, async (body: string) => {
    try {
      const { cookie } = JSON.parse(body || "{}");
      const r = zhentiApi.saveNowcoderCookie(cookie);
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/zhenti/questions", (req: IncomingMessage, res: ServerResponse) => {  // 登录态抓取试卷完整题目（POST { paperTestId }）
  readBody(req, res, async (body: string) => {
    try {
      const { paperTestId } = JSON.parse(body || "{}");
      if (!paperTestId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "paperTestId required" })); return; }
      const r = await zhentiApi.fetchPaperQuestions(paperTestId);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/zhenti/wrong", (req: IncomingMessage, res: ServerResponse) => {  // 错题回流：学习清单 + FSRS 复习卡（POST { paperId, company, paperTitle, question, answer }）
  readBody(req, res, async (body: string) => {
    try {
      const { paperId, company, paperTitle, question, answer } = JSON.parse(body || "{}");
      if (!question || !String(question).trim()) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "question required" })); return; }
      const r = await zhentiApi.addWrongQuestion({ paperId, company, paperTitle, question, answer });
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });
router.route("/api/zhenti/plan", (req: IncomingMessage, res: ServerResponse) => {  // 整套真题加入学习清单（POST { paperTestId }）
  readBody(req, res, async (body: string) => {
    try {
      const { paperTestId } = JSON.parse(body || "{}");
      if (!paperTestId) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "paperTestId required" })); return; }
      const r = await zhentiApi.addPaperToPlan(paperTestId);
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: eMsg(e) }));
    }
  });
  });}
