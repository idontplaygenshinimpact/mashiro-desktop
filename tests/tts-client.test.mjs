// TTS 客户端测试（mock HTTP 服务，不依赖 GPU/真实 worker）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

let server, base;
let requests = [];

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (req.url === "/api/tts/status") {
        res.writeHead(200); res.end(JSON.stringify({ loaded: true, modelMs: 1234, queueLen: 0 }));
      } else if (req.url === "/api/tts/synthesize") {
        const { text } = JSON.parse(body);
        if (text === "FAIL") { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: "synthesize failed" })); return; }
        res.writeHead(200); res.end(JSON.stringify({ ok: true, wav: "V0FWRU1PQ0s=", sr: 32000, ms: 800, queueLen: 1 }));
      } else if (req.url === "/api/tts/abort") {
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.MIANSHI_TTS_URL = base;
  process.env.MIANSHI_TTS_TOKEN = "test-token";
});

after(() => { server.close(); delete process.env.MIANSHI_TTS_URL; delete process.env.MIANSHI_TTS_TOKEN; });

test("synthesize 成功：返回 wav/sr/ms + 携带 Bearer", async () => {
  const { synthesize } = await import("../lib/tts-gpt-sovits.mjs");
  const r = await synthesize("こんにちは");
  assert.equal(r.ok, true);
  assert.equal(r.wav, "V0FWRU1PQ0s=");
  assert.equal(r.sr, 32000);
  assert.ok(r.ms >= 0);
  const req = requests.find((x) => x.url === "/api/tts/synthesize");
  assert.equal(req.auth, "Bearer test-token");
  assert.deepEqual(req.body, { text: "こんにちは" });
});

test("synthesize 空文本：直接失败不请求", async () => {
  const { synthesize } = await import("../lib/tts-gpt-sovits.mjs");
  const r = await synthesize("   ");
  assert.equal(r.ok, false);
  assert.equal(r.error, "empty text");
});

test("synthesize 服务端失败：透传 error", async () => {
  const { synthesize } = await import("../lib/tts-gpt-sovits.mjs");
  const r = await synthesize("FAIL");
  assert.equal(r.ok, false);
  assert.equal(r.error, "synthesize failed");
});

test("synthesize 超长文本：截断到 60 字", async () => {
  const { synthesize } = await import("../lib/tts-gpt-sovits.mjs");
  const r = await synthesize("あ".repeat(100));
  const req = requests.filter((x) => x.url === "/api/tts/synthesize").at(-1);
  assert.equal(req.body.text.length, 60);
  assert.equal(r.ok, true);
});

test("synthesize 服务不可达：返回 ok:false 不抛异常", async () => {
  const { synthesize } = await import("../lib/tts-gpt-sovits.mjs");
  const old = process.env.MIANSHI_TTS_URL;
  process.env.MIANSHI_TTS_URL = "http://127.0.0.1:1";
  const r = await synthesize("こんにちは");
  process.env.MIANSHI_TTS_URL = old;
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test("status：读取加载状态与队列", async () => {
  const { status } = await import("../lib/tts-gpt-sovits.mjs");
  const s = await status();
  assert.equal(s.loaded, true);
  assert.equal(s.modelMs, 1234);
});

test("abort：POST 到 abort 端点", async () => {
  const { abort } = await import("../lib/tts-gpt-sovits.mjs");
  await abort();
  assert.ok(requests.some((x) => x.url === "/api/tts/abort"));
});
