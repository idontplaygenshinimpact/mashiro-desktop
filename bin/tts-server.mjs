// 实时 TTS 服务（GPT-SoVITS 本地）：spawn python worker + HTTP :8900 + 串行请求管理
// 用法：node bin/tts-server.mjs [--port 8900]
// 依赖：D:/GPT-SoVITS 训练权重 + CUDA（worker 加载 30-60s）
// 协议（与 worker 通信）：stdin/stdout JSON 行；请求 {id,text}，响应 {id,ok,wav,sr,ms}
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "tts-server-worker.py");
const PORT = Number(process.env.MIANSHI_TTS_PORT || process.argv[2] || 8900);
const TOKEN = process.env.MIANSHI_TTS_TOKEN || "";
const WORKER_TIMEOUT_MS = 60000; // 单句合成超时
const REQ_TIMEOUT_MS = 15000;    // HTTP 侧超时（合成前排队等待含在内，由上层控制降级）

// ---------- worker 生命周期（崩溃自动重启，widget-server 同款 ensure 模式） ----------
let worker = null;
let ready = false;
let readyMs = 0;
let pending = new Map(); // id -> {resolve, timer}
let queue = [];          // 等待发送给 worker 的请求 id（串行，一次一个在途）
let inflight = null;

function startWorker() {
  worker = spawn("py", ["-3.12", WORKER], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  worker.stdout.setEncoding("utf8");
  let buf = "";
  worker.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === "ready") { ready = true; readyMs = msg.ms; console.log(`[tts-server] worker ready (${readyMs}ms)`); }
        else if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
          inflight = null;
          pump();
        }
      } catch { /* 忽略坏行 */ }
    }
  });
  worker.stderr.on("data", (d) => process.stderr.write(`[tts-worker] ${d}`));
  worker.on("exit", (code) => {
    console.log(`[tts-server] worker exited (${code})，重启`);
    ready = false;
    inflight = null;
    // 在途/排队请求全部失败（上层降级）
    for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: "worker restart" }); }
    pending.clear();
    queue = [];
    setTimeout(startWorker, 2000);
  });
}

function pump() {
  if (!ready || inflight || queue.length === 0) return;
  const id = queue.shift();
  inflight = id;
  worker.stdin.write(JSON.stringify({ id, text: pending.get(id)?.text ?? "" }) + "\n");
}

// ---------- HTTP ----------
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authOk = !TOKEN || req.headers.authorization === `Bearer ${TOKEN}`;
  if (!authOk) { res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return; }

  if (url.pathname === "/api/tts/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ loaded: ready, modelMs: readyMs, queueLen: queue.length + (inflight ? 1 : 0) }));
    return;
  }

  if (url.pathname === "/api/tts/abort" && req.method === "POST") {
    queue = [];
    res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/api/tts/synthesize" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 非 JSON body */ }
      const text = String(parsed?.text || "").trim();
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: "text required" })); return; }
      if (text.length > 60) { res.writeHead(400); res.end(JSON.stringify({ error: "text too long (>60)" })); return; }
      if (!ready) { res.writeHead(503); res.end(JSON.stringify({ error: "tts not ready", modelMs: readyMs })); return; }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        const qi = queue.indexOf(id);
        if (qi >= 0) queue.splice(qi, 1);
        res.writeHead(504); res.end(JSON.stringify({ error: "synthesize timeout" }));
      }, REQ_TIMEOUT_MS);
      pending.set(id, {
        text,
        timer,
        resolve: (msg) => {
          if (msg.ok) res.writeHead(200);
          else res.writeHead(500);
          res.end(JSON.stringify(msg.ok
            ? { ok: true, wav: msg.wav, sr: msg.sr, ms: msg.ms, queueLen: queue.length }
            : { ok: false, error: msg.error || "synthesize failed" }));
        },
      });
      queue.push(id);
      pump();
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
});

startWorker();
server.listen(PORT, "127.0.0.1", () => console.log(`[tts-server] listening http://127.0.0.1:${PORT}`));
