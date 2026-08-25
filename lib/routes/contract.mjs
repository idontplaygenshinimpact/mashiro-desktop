// 契约层 · 运行时（Phase 2 §3）
// 两种 handler 风格渐进共存：
//   Legacy（现状 142 处）：(req,res)=>自读 body/自写响应——一行不动。
//   Contract（新）：withContract(fn,{input,output})——包装器负责 body 读取 + input 校验
//   + 纯逻辑执行 + output 校验 + 统一序列化。fn 只返回数据，不碰 res。
// readBodyJson 覆盖 MAX_BODY 超限（413，与 widget-core.readBody 语义一致）与坏 JSON（400）。
import { MAX_BODY } from "../widget-core.mjs";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/**
 * Promise 化读取请求体：超限 413、坏 JSON 400；空 body → {}（兼容无 body 的 action 路由）。
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<{ok: boolean, body?: any, status?: number, error?: string, issues?: Array<{path: Array<string|number>, message: string}>}>}
 */
export function readBodyJson(req, res) {
  return new Promise((resolve) => {
    let body = "";
    let overflow = false;
    let settled = false;
    req.on("data", (c) => {
      if (overflow || settled) return;
      body += c;
      if (body.length > MAX_BODY) {
        overflow = true;
        settled = true;
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(413, JSON_HEADERS);
          res.end(JSON.stringify({ error: "请求体过大（>1MB）" }));
        }
        req.destroy();
        resolve({ ok: false, status: 413, error: "请求体过大（>1MB）" });
      }
    });
    req.on("end", () => {
      if (overflow || settled) return;
      settled = true;
      if (!body) return resolve({ ok: true, body: {} });
      try {
        resolve({ ok: true, body: JSON.parse(body) });
      } catch (e) {
        resolve({
          ok: false, status: 400, error: "INVALID_JSON",
          issues: [{ path: [], message: `请求体不是合法 JSON: ${String(e?.message || e).slice(0, 120)}` }],
        });
      }
    });
    req.on("error", () => {
      if (!settled) { settled = true; resolve({ ok: false, status: 400, error: "BODY_READ_ERROR" }); }
    });
  });
}

/** 把 zod issues 收敛为契约错误体 issues（path 数组 + message） */
function toIssues(zIssues) {
  return zIssues.map((i) => ({ path: Array.isArray(i.path) ? i.path : [String(i.path ?? "")], message: i.message }));
}

/**
 * 契约路由包装器：入参来源 → input 校验（strip 未知字段，默认不 reject 未知）→
 * 纯函数执行（返回数据，不写 res）→ output 校验（SCHEMA_MISMATCH 即 bug，500）→ 统一序列化。
 * @param {(input: any, ctx: {req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse}) => any} fn
 * @param {{ input?: import("zod").ZodType, output?: import("zod").ZodType, src?: "body"|"query" }} [schema]
 *  src: "body"（默认）取 POST body；"query" 取 URL searchParams（query 驱动的 GET/POST 路由）。
 */
export function withContract(fn, { input, output, src = "body" } = {}) {
  const handler = async (req, res) => {
    try {
      let data = {};
      if (src === "query") {
        const u = new URL(req.url, "http://x");
        data = Object.fromEntries(u.searchParams);
      } else {
        const parsed = await readBodyJson(req, res);
        if (!parsed.ok) {
          if (!res.destroyed && !res.writableEnded) { res.writeHead(parsed.status, JSON_HEADERS); res.end(JSON.stringify({ error: parsed.error, issues: parsed.issues })); }
          return;
        }
        data = parsed.body ?? {};
      }
      if (input) {
        const parsed = input.safeParse(data);
        if (!parsed.success) {
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(400, JSON_HEADERS);
            res.end(JSON.stringify({ error: "VALIDATION_ERROR", issues: toIssues(parsed.error.issues) }));
          }
          return;
        }
        data = parsed.data;
      }
      const result = await fn(data, { req, res });
      if (output) {
        const out = output.safeParse(result);
        if (!out.success) {
          console.error(`[contract] SCHEMA_MISMATCH: 输出不符合契约`, JSON.stringify(toIssues(out.error.issues)).slice(0, 600));
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(500, JSON_HEADERS);
            res.end(JSON.stringify({ error: "SCHEMA_MISMATCH", issues: toIssues(out.error.issues) }));
          }
          return;
        }
      }
      if (!res.destroyed && !res.writableEnded) { res.writeHead(200, JSON_HEADERS); res.end(JSON.stringify(result)); }
    } catch (e) {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ error: String(e?.message || e).slice(0, 300) }));
      }
    }
  };
  // 契约元数据挂载：router.hasSchema / 契约覆盖率断言据此判断（无需在 route() 第 4 参重复声明）
  handler._contract = { input, output, src };
  return handler;
}

/**
 * 统一 SSE 推送器：`data: JSON\n\n` 序列化 + 可选心跳 + 可选事件契约校验（开发期暴露漂移）。
 * @param {import("node:http").ServerResponse} res
 * @param {{ eventSchema?: import("zod").ZodType, strict?: boolean, heartbeatMs?: number }} [opts]
 *  strict 默认取环境变量 MIANSHI_SSE_STRICT=1（生产关掉零开销）；调用方可显式覆盖。
 */
export function createSSEPush(res, { eventSchema = null, strict = process.env.MIANSHI_SSE_STRICT === "1", heartbeatMs = 0 } = {}) {
  const closed = () => res.destroyed || res.writableEnded;
  const push = (obj) => {
    if (closed()) return false;
    if (strict && eventSchema) {
      const r = eventSchema.safeParse(obj);
      if (!r.success) console.error("[sse] SSE 事件不合契约", JSON.stringify(toIssues(r.error.issues)).slice(0, 500));
    }
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
    return true;
  };
  const hb = heartbeatMs > 0 ? setInterval(() => { if (!closed()) res.write(":hb\n\n"); }, heartbeatMs) : null;
  const close = () => { if (hb) clearInterval(hb); };
  return { push, close, closed };
}
