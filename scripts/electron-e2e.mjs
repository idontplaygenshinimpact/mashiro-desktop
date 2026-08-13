// E2E 冒烟测试：Electron 桌宠窗口层（Playwright _electron）
// 验证：窗口创建 / 渲染进程零未捕获异常 / preload IPC 桥完整 / 面板窗口加载与关键 DOM / 面板→widget 数据链路
// 用法: node scripts/electron-e2e.mjs
// 退出码: 0=全过 1=有失败
// 注意: 全程只读，不触发任何写操作（runDiscover/studyGenerate/studyCheck/studyReview/
//       studyAnswer/invStart/reviewSubmit/openOutput/quit/speak/speechToText 均不调用）
import { _electron } from "playwright";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const MAIN = path.join(ROOT, "desktop", "main.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name} ${detail}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// 统计当前 electron 进程数（测试前后对比，确认不误杀环境里已存在的桌宠）
function electronCount() {
  try {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "@(Get-Process electron -ErrorAction SilentlyContinue).Count"],
      { encoding: "utf8", timeout: 10000, windowsHide: true }
    );
    const n = parseInt((r.stdout || "").trim(), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

let app = null;
// 每个 page 的错误记录（pageerror=未捕获异常 / consoleErrors=type=error 日志）
const recs = new Map();
function watchPage(page) {
  const rec = { pageerrors: [], consoleErrors: [] };
  recs.set(page, rec);
  page.on("pageerror", (err) => {
    rec.pageerrors.push(String(err?.message || err));
    console.log(`    [pageerror] ${page.url()} → ${err?.message || err}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      rec.consoleErrors.push(msg.text());
      console.log(`    [console.error] ${page.url()} → ${msg.text()}`);
    }
  });
  return rec;
}

console.log("== 0. 环境 ==");
check("electron.exe 存在", existsSync(ELECTRON), ELECTRON);
const before = electronCount();
console.log(`  测试前 electron 进程数: ${before}`);
{
  let ws;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/refresh", { signal: AbortSignal.timeout(5000) });
    ws = r.ok ? "运行中" : `异常 status=${r.status}`;
  } catch { ws = "未运行（main.mjs 会自动拉起）"; }
  console.log(`  widget 服务预检: ${ws}`);
}

console.log("\n== 1. 启动 Electron ==");
try {
  app = await _electron.launch({
    executablePath: ELECTRON,
    args: [MAIN],
    cwd: ROOT,
    timeout: 30000,
  });
  check("_electron.launch 启动", true, `pid=${app.process().pid}`);
} catch (e) {
  check("_electron.launch 启动", false, e.message);
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

try {
  // 对所有窗口（含之后新建的面板）都挂错误监听
  for (const p of app.windows()) watchPage(p);
  app.on("window", (p) => watchPage(p));

  // ---------- 桌宠窗口 ----------
  console.log("\n== 2. 桌宠窗口 ==");
  let win = null;
  try { win = await app.firstWindow(); } catch (e) { check("firstWindow 获取桌宠窗口", false, e.message); }
  if (win) {
    const mascotRec = recs.get(win) || watchPage(win);
    check("firstWindow 获取桌宠窗口", true, win.url());
    check("加载 renderer/index.html", win.url().includes("index.html"), win.url());

    // 等 window.kanban 出现（轮询最多 15s）
    let kanbanReady = false;
    for (let i = 0; i < 30 && !kanbanReady; i++) {
      try {
        kanbanReady = await win.evaluate(() => {
          const k = /** @type {any} */ (window).kanban;
          return !!(k && k.getData !== undefined);
        });
      } catch { /* 页面未就绪 */ }
      if (!kanbanReady) await sleep(500);
    }
    check("window.kanban 出现（≤15s）", kanbanReady);

    if (kanbanReady) {
      const api = await win.evaluate(() => Object.keys(/** @type {any} */ (window).kanban).sort());
      for (const key of ["getData", "studyPlan", "studyDetail", "speechToText", "togglePanel", "reviewDue"]) {
        check(`kanban.${key} 存在`, api.includes(key));
      }
      const modelPath = await win.evaluate(() => /** @type {any} */ (window).kanban.modelPath);
      check(
        "kanban.modelPath 非空字符串",
        typeof modelPath === "string" && modelPath.length > 0,
        typeof modelPath === "string" ? modelPath.split("\\").pop() : `type=${typeof modelPath}`
      );
      const canvasOk = await win.evaluate(() => {
        const c = document.getElementById("live2d");
        return !!c && c.tagName === "CANVAS";
      });
      check("#live2d Live2D canvas 存在", canvasOk);
    }

    check("桌宠窗口 0 未捕获异常", mascotRec.pageerrors.length === 0, mascotRec.pageerrors.length ? `count=${mascotRec.pageerrors.length}` : "");
    check("桌宠窗口 0 console.error", mascotRec.consoleErrors.length === 0, mascotRec.consoleErrors.length ? `count=${mascotRec.consoleErrors.length}` : "");

    // ---------- IPC 链路（只读：widget 数据） ----------
    console.log("\n== 3. IPC 链路（widget 数据） ==");
    let data = null, dataNote = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        data = await win.evaluate(() => /** @type {any} */ (window).kanban.getData());
      } catch (e) {
        data = { error: "evaluate 异常: " + e.message };
      }
      if (data && typeof data === "object" && !data.error && data.ok !== false) break;
      dataNote = data?.error ? `error=${data.error}` : `data=${JSON.stringify(data).slice(0, 80)}`;
      // widget 未就绪（main.mjs ensureWidgetServer 刚拉起服务需时间）→ 等 10s 重试
      console.log(`    getData 第 ${attempt} 次未就绪（${dataNote}），等 10s 重试`);
      await sleep(10000);
    }
    check(
      "kanban.getData() 返回数据对象（含重试）",
      !!(data && typeof data === "object" && !data.error),
      data?.error ? `error=${data.error}` : data ? `keys=${Object.keys(data).join(",")}` : "无返回"
    );

    // ---------- 面板窗口 ----------
    console.log("\n== 4. 面板窗口 ==");
    let toggle = null;
    try { toggle = await win.evaluate(() => /** @type {any} */ (window).kanban.togglePanel()); } catch (e) { toggle = { error: e.message }; }
    check("togglePanel() 触发", !!(toggle && toggle.ok), toggle?.error ? `error=${toggle.error}` : JSON.stringify(toggle));

    let panel = null;
    for (let i = 0; i < 30 && !panel; i++) {
      panel = app.windows().find((p) => p.url().includes("panel.html"));
      if (!panel) await sleep(500);
    }
    check("面板窗口出现（≤15s）", !!panel);

    if (panel) {
      const panelRec = recs.get(panel) || watchPage(panel);
      try { await panel.waitForLoadState("load"); } catch { /* 已加载或超时，由后续检查体现 */ }
      const title = await panel.title().catch(() => "");
      check("面板标题合理", typeof title === "string" && title.includes("真白"), `title=${title}`);
      const size = await panel.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => null);
      check("面板尺寸合理（≥400x500）", !!(size && size.w >= 400 && size.h >= 500), size ? `${size.w}x${size.h}` : "无法读取");
      const hasKanban = await panel.evaluate(() => {
        const k = /** @type {any} */ (window).kanban;
        return !!(k && k.getData);
      }).catch(() => false);
      check("面板 window.kanban 存在", hasKanban);
      const dom = await panel.evaluate(() => ({
        studyList: !!document.getElementById("study-list"),
        ojList: !!document.getElementById("oj-list"),
        chatMic: !!document.getElementById("chat-mic"),
        chatInput: !!document.getElementById("chat-input"),
        voiceBtn: !!document.getElementById("voice-btn"),
        sdToc: !!document.getElementById("sd-toc"),
      })).catch(() => null);
      check("#study-list 学习清单容器", !!(dom && dom.studyList));
      check("#oj-list 专项练习区块", !!(dom && dom.ojList));
      check("#chat-mic 语音输入按钮", !!(dom && dom.chatMic));
      check("#chat-input 对话输入框", !!(dom && dom.chatInput));
      check("#voice-btn 语音开关", !!(dom && dom.voiceBtn));
      check("#sd-toc 锚点目录容器", !!(dom && dom.sdToc));
      check("面板窗口 0 未捕获异常", panelRec.pageerrors.length === 0, panelRec.pageerrors.length ? `count=${panelRec.pageerrors.length}` : "");
      check("面板窗口 0 console.error", panelRec.consoleErrors.length === 0, panelRec.consoleErrors.length ? `count=${panelRec.consoleErrors.length}` : "");

      // ---------- 面板 → widget 数据链路（只读） ----------
      console.log("\n== 5. 面板 → widget 数据链路 ==");
      const plan = await panel.evaluate(() => /** @type {any} */ (window).kanban.studyPlan());
      const items = plan?.plan?.items;
      check("studyPlan() 返回 ok=true", !!(plan && plan.ok === true), plan?.error ? `error=${plan.error}` : "");
      check(
        "studyPlan() plan.items 数组（空数组可接受）",
        Array.isArray(items),
        Array.isArray(items) ? `count=${items.length}` : `plan=${JSON.stringify(plan).slice(0, 100)}`
      );
      if (Array.isArray(items) && items.length === 0) {
        console.log("  ⏭️ items 为空数组（真实 DB 无数据，按规格 ok=true 即通过）");
      }
      const due = await panel.evaluate(() => /** @type {any} */ (window).kanban.reviewDue());
      check("reviewDue() 返回 ok=true", !!(due && due.ok === true), due?.error ? `error=${due.error}` : `total=${due?.stats?.total}`);
    }
  }
} catch (e) {
  check("测试流程无异常", false, e.message);
} finally {
  // ---------- 清理 ----------
  console.log("\n== 6. 清理 ==");
  let closeOk = false;
  if (app) {
    try { await app.close(); closeOk = true; } catch { closeOk = false; }
  }
  check("app.close() 关闭测试实例", closeOk || !app);
  await sleep(2000); // 等进程完全退出再数
  const after = electronCount();
  check("electron 进程数不减少（未误杀既有桌宠）", after >= before, `before=${before} after=${after}`);

  // 全局错误汇总
  let allPageErrors = 0, allConsoleErrors = 0;
  for (const rec of recs.values()) {
    allPageErrors += rec.pageerrors.length;
    allConsoleErrors += rec.consoleErrors.length;
  }
  check("全部页面 0 未捕获异常", allPageErrors === 0, allPageErrors ? `count=${allPageErrors}` : "");
  check("全部页面 0 console.error", allConsoleErrors === 0, allConsoleErrors ? `count=${allConsoleErrors}` : "");

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}
