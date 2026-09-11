// 启动竞态回归（2026-09-11 真实事故）：widget 在 tryListen() 之后还有多个 top-level await
// （动态 import / ensurePlanCoverage / createPatrol…），Node 在这些 await 期间会处理 I/O →
// 启动瞬间到达的请求踩模块级 const 的 TDZ：
//   uncaughtException: ReferenceError: Cannot access 'patrol' before initialization
//     at patrolGetConfig (widget.mjs) ← GET /api/patrol-config
// 实测后果：**每次开 app 崩一次**，守护探活间隔 30s 才拉起 → "后台启动很慢" + 面板 "Failed to fetch"。
// 修法：启动期门闸（bootReady）——初始化完成前只放行 /api/health，其余 503 starting。
// 本测试从进程启动的第一毫秒起狂打 /api/patrol-config：断言不崩、不出现 TDZ、并且能拿到响应
// （503=门闸生效 / 200=已就绪），从而覆盖"以后又往 listen 之后加模块级 const"这类回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 19000 + Math.floor(Math.random() * 900);
const TOKEN = "boot-race-token";

test("启动期请求不踩 TDZ：狂打 /api/patrol-config 不崩，且门闸后能正常响应", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bootrace-"));
  const dbPath = path.join(dir, "test.db");
  // 用真实库结构（含 settings 表等）但落在临时目录——避免写用户数据
  const real = path.join(ROOT, "data", "mianshi.db");
  if (existsSync(real)) copyFileSync(real, dbPath);

  const child = spawn(process.execPath, ["widget.mjs", "--no-notify"], {
    cwd: ROOT,
    env: {
      ...process.env,
      MIANSHI_PORT: String(PORT),
      MIANSHI_DB_PATH: dbPath,
      MIANSHI_TOKEN: TOKEN,
      MIANSHI_DISABLE_PATROL: "1",     // 关巡检定时器，但 patrol 实例照建（TDZ 仍可触发）
      MIANSHI_DISABLE_BACKGROUND: "1", // 不再起 RAG/搜集等后台任务，缩短启动窗口
      MIANSHI_AGENT_WATCH: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  const tally = { starting: 0, ok: 0, other: 0, netErr: 0 };
  const deadline = Date.now() + 8000;
  let exitedEarly = null;
  child.on("exit", (code) => { exitedEarly = code; });
  while (Date.now() < deadline) {
    if (exitedEarly !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/patrol-config`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(2000),
      });
      if (r.status === 503) tally.starting++;
      else if (r.status === 200) tally.ok++;
      else tally.other++;
    } catch { tally.netErr++; }
    await new Promise((r) => setTimeout(r, 25));
    if (tally.ok > 0) break; // 已就绪即可收工（继续打只是浪费）
  }

  try {
    assert.equal(exitedEarly, null, `widget 不应在启动期退出（退出码 ${exitedEarly}）；输出尾部：${out.slice(-400)}`);
    assert.ok(!/before initialization|uncaughtException/.test(out), `启动期不得出现 TDZ/未捕获异常；输出尾部：${out.slice(-400)}`);
    assert.ok(tally.ok + tally.starting > 0, `至少要拿到一次响应（503 门闸或 200 就绪）：${JSON.stringify(tally)}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true });
  }
});
