// 看板娘渲染层：Live2D + 拖拽 + 气泡 + 面板
import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism2";

// 关键：pixi-live2d-display 的 autoUpdate/loader 依赖 window.PIXI 全局 + 共享 Ticker
// esbuild bundle 里 PIXI 是局部模块，必须手动暴露到全局，否则模型加载但永远不渲染
window.PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

// ---------- 元素 ----------
const canvas = document.getElementById("live2d");
const bubble = document.getElementById("bubble");
const bubbleText = document.getElementById("bubble-text");
const panel = document.getElementById("panel");
const planList = document.getElementById("plan-list");
const fileList = document.getElementById("file-list");
const dirList = document.getElementById("dir-list");

// ---------- PIXI + Live2D ----------
const gl = document.createElement("canvas").getContext("webgl");

const app = new PIXI.Application({
  view: canvas,
  transparent: true,
  backgroundAlpha: 0, // 强制背景完全透明（透明窗口 + WebGL 必需）
  autoStart: true,
  resizeTo: window,
  antialias: true,
  // 关键：pixi-live2d-display 的 autoUpdate 注册到 PIXI.Ticker.shared（共享 ticker），
  // 必须用共享 ticker 驱动，否则 deltaTime 永远为 0，模型永不 update → 渲染空白
  sharedTicker: true,
});
// 额外保险：确保 WebGL context 用透明背景 + 非预乘 alpha（透明窗口合成关键）
const glCtx = app.renderer.gl;
if (glCtx) {
  try { glCtx.clearColor(0, 0, 0, 0); } catch { /* ignore */ }
}

// 手动监听窗口 resize（固定窗口方案：canvas 同步窗口尺寸 + 模型固定定位）
window.addEventListener("resize", () => {
  app.renderer.resize(window.innerWidth, window.innerHeight);
  if (model) {
    model.position.set(
      window.innerWidth / 2,
      window.innerHeight * 0.60
    );
  }
});

let model = null;

async function loadModel() {
  try {
    // 椎名真白 Live2D 模型（樱花庄的宠物女孩 · 水手服版）
    // 模型路径由主进程通过 --model-path 注入（避免 file:// 相对路径解析问题）
    let modelPath = window.kanban?.modelPath || "";
    if (!modelPath) {
      // 兜底：相对 bundle 位置解析
      modelPath = new URL(
        "../../node_modules/live2d-widget-model-mashiro-seifuku/assets/seifuku.model.json",
        import.meta.url
      ).href;
    } else if (!modelPath.startsWith("file:")) {
      modelPath = "file:///" + modelPath.replace(/\\/g, "/");
    }
    console.log("[kanban] loading model:", modelPath);
    model = await Live2DModel.from(modelPath, { autoInteract: false });
    // 椎名真白（Sakurasou mashiro·旅行装）半身模型
    // 定位：画布中心放窗口 60% 高度处，显示到腿的半身形态（Live2D 看板娘传统设计）
    const targetH = 300; // 画布（模型）高度
    const scale = targetH / (model.height || 1000);
    model.scale.set(scale);
    model.anchor.set(0.5, 0.5);
    app.stage.addChild(model);
    model.position.set(
      app.screen.width / 2,
      app.screen.height * 0.60
    );

    // 通知主进程显示窗口（尺寸已固定锁定，仅触发 show）
    try {
      await window.kanban.fitWindow(model.width, model.height);
    } catch (e) {
    }

    // 关键：确保模型 update 在每次 draw 前执行（否则 Cubism runtime 报
    // "call update() before draw()" 且角色不渲染/闪烁）
    // 不要手动调用 model.update()（无参数会把 deltaTime 污染成 NaN，导致 internalModel.update 永不执行）。
    // autoUpdate 机制已通过 sharedTicker 自动驱动（registerTicker 已注册）。
    // 仅保留强制渲染兜底。
    app.ticker.add(() => {
      app.renderer.render(app.stage);
    });

    // 空闲动作：只播温和的 idle 待机动作（tap 组里有镜头推近/大幅动作，会看起来"变大"）
    startIdleMotion();

    // 加载成功提示
    showBubble("✨ 我是椎名真白！面经学习交给我吧~", 5000);
    loadData();
  } catch (e) {
    showBubble(`😢 Live2D 加载失败: ${e.message}`, 6000);
    console.error(e);
  }
}

function startIdleMotion() {
  // 暂时禁用自动动作（排查"长按增大"问题：排除 Live2D 动作导致的视觉变化）
  // 真白模型动作组：tap（含镜头推近，会"变大"）/ idle（温和待机）
  return;
}

// ---------- 交互：点击角色=打开面板，拖动=移动窗口 ----------
let dragging = false, moved = false, offset = { x: 0, y: 0 }, downAt = null, lastMoveTs = 0;

canvas.addEventListener("pointerdown", (e) => {
  if (!panel.classList.contains("hidden")) return; // 面板打开时不拖
  dragging = true;
  moved = false;
  downAt = Date.now();
  offset = { x: e.screenX - window.screenX, y: e.screenY - window.screenY };
  canvas.style.cursor = "grabbing";
});

canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.screenX - offset.x - window.screenX;
  const dy = e.screenY - offset.y - window.screenY;
  if (Math.abs(dx) + Math.abs(dy) > 6) moved = true; // 移动超过阈值=拖拽
  if (moved) {
    // setBounds 同时指定固定尺寸（240x470），避免 setPosition 的 DWM 尺寸漂移
    const now = Date.now();
    if (now - lastMoveTs > 16) {
      lastMoveTs = now;
      window.kanban.moveWindow(e.screenX - offset.x, e.screenY - offset.y);
    }
  }
});

canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  canvas.style.cursor = "grab";
  // 短按且没移动 = 点击角色 → 打开面板
  if (!moved && Date.now() - downAt < 400) {
    togglePanel();
  }
});

// ---------- 气泡 ----------
let bubbleTimer = null;
function showBubble(text, duration = 5000) {
  bubbleText.innerHTML = text;
  bubble.classList.remove("hidden");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.add("hidden"), duration);
}

// ---------- 面板：点击角色 → 打开独立大面板窗口 ----------
function togglePanel() {
  // 独立面板窗口由主进程管理（window:toggle-panel）
  window.kanban.togglePanel();
}

// 语音开关（默认开）——桌宠小窗保留
let voiceOn = true;
try {
  const voiceBtn = document.getElementById("btn-voice");
  if (voiceBtn) {
    voiceBtn.addEventListener("click", () => {
      voiceOn = !voiceOn;
      window.kanban.setVoiceEnabled(voiceOn);
      voiceBtn.textContent = voiceOn ? "🔊" : "🔇";
      showBubble(voiceOn ? "🔊 语音已开启，真白会开口说话啦" : "🔇 语音已关闭", 3000);
    });
  }
} catch { /* ignore */ }

// ============ 学习清单 ============
const studyList = document.getElementById("study-list");
let studyItems = [];

async function loadStudyPlan() {
  try {
    const r = await window.kanban.studyPlan();
    if (!r?.ok) return;
    studyItems = r.plan?.items || [];
    renderStudyList();
  } catch { /* ignore */ }
}

function renderStudyList() {
  if (!studyItems.length) {
    studyList.innerHTML = '<div class="empty">未生成，点 ✨生成 从最新产出提炼</div>';
    return;
  }
  studyList.innerHTML = studyItems
    .map(
      (it) => `<div class="study-item ${it.done ? "done" : ""}" data-id="${it.id}">
        <input type="checkbox" ${it.done ? "checked" : ""} />
        <div>
          <div class="s-topic">${escapeHtml(it.topic)}</div>
          <div class="s-why">${escapeHtml(it.why || "")}</div>
        </div>
        <span class="s-badge ${it.reviewed ? "reviewed" : ""}">${it.reviewed ? "已复盘" : "待学"}</span>
      </div>`
    )
    .join("");
  // 勾选事件
  document.querySelectorAll(".study-item").forEach((el) => {
    el.querySelector("input").addEventListener("change", async (e) => {
      const id = el.dataset.id;
      await window.kanban.studyCheck(id, e.target.checked);
      showBubble(e.target.checked ? `✅ 完成：${el.querySelector(".s-topic").textContent}` : "↩️ 已取消完成", 3000);
      loadStudyPlan();
    });
  });
}

document.getElementById("btn-study-gen").addEventListener("click", async () => {
  showBubble("✨ 正在从产出提炼学习清单...", 6000);
  await window.kanban.studyGenerate();
  await loadStudyPlan();
  showBubble("📋 学习清单已生成，勾选完成吧！", 5000);
});

// ============ 复盘 ============
const reviewBox = document.getElementById("review-box");
const reviewQ = document.getElementById("review-questions");
let reviewQuestions = [];

document.getElementById("btn-review").addEventListener("click", async () => {
  const r = await window.kanban.studyReview();
  if (!r?.ok) { showBubble("⚠️ " + (r?.error || "暂无复盘内容"), 4000); return; }
  reviewQuestions = r.questions || [];
  reviewQ.innerHTML = reviewQuestions
    .map(
      (q, i) => `<div class="rq" data-id="${q.id}">
        <div class="rq-topic">${i + 1}. ${escapeHtml(q.topic)}</div>
        <div class="rq-q">${escapeHtml(q.question)}</div>
        <textarea placeholder="输入你的回答..."></textarea>
        <div class="rq-verdict"></div>
      </div>`
    )
    .join("") + '<button id="review-submit">提交判分</button>';
  reviewBox.classList.remove("hidden");
  document.getElementById("review-submit").addEventListener("click", submitReview);
});

document.getElementById("review-close").addEventListener("click", () => reviewBox.classList.add("hidden"));

async function submitReview() {
  const answers = [];
  reviewQ.querySelectorAll(".rq").forEach((el) => {
    const ta = el.querySelector("textarea");
    answers.push({ id: el.dataset.id, answer: ta.value });
  });
  showBubble("📝 判分中...", 4000);
  const r = await window.kanban.studyAnswer(answers);
  if (!r?.ok) { showBubble("⚠️ " + (r?.error || "判分失败"), 4000); return; }
  // 显示判分结果
  const results = r.results || [];
  reviewQ.querySelectorAll(".rq").forEach((el) => {
    const id = el.dataset.id;
    const res = results.find((x) => x.topic === studyItems.find((s) => s.id === id)?.topic);
    if (!res) return;
    const vd = el.querySelector(".rq-verdict");
    const cls = res.verdict === "对" ? "good" : res.verdict === "部分对" ? "mid" : "bad";
    vd.className = "rq-verdict " + cls;
    vd.innerHTML = `<b>${res.verdict}</b> ${escapeHtml(res.comment || "")}<br><span style="color:#9c9cb0">参考：${escapeHtml((res.reference || "").slice(0, 120))}</span>`;
  });
  showBubble("📝 复盘完成，看看评判吧！", 5000);
  loadStudyPlan();
}

// ============ 对话 ============
const chatInput = document.getElementById("chat-input");
let chatHistory = [];

document.getElementById("chat-send").addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

async function sendChat() {
  const msg = chatInput.value.trim();
  if (!msg) return;
  chatInput.value = "";
  showBubble("💬 你：" + msg, 6000);
  await new Promise((r) => setTimeout(r, 300));
  showBubble("🤔 真白思考中...", 8000);
  try {
    const r = await window.kanban.chat(msg, chatHistory);
    chatHistory = r.history || [];
    // 语音播报（真白人设语音稿）
    if (r.voice && voiceOn) {
      window.kanban.speak(r.voice);
    }
    // 打字机效果：逐字显示回复
    typewriter("💬 " + (r.reply || "（无回复）"));
  } catch (e) {
    showBubble("⚠️ 对话失败: " + e.message, 5000);
  }
}

// 打字机效果：逐字显示（最多显示 800 字，超过直接显示）
let typeTimer = null;
function typewriter(text) {
  clearTimeout(typeTimer);
  bubble.classList.remove("hidden");
  const max = 800;
  const full = text.length > max ? text.slice(0, max) + "..." : text;
  let i = 0;
  const step = () => {
    i = Math.min(i + 3, full.length); // 每帧 3 字
    bubbleText.textContent = full.slice(0, i);
    if (i < full.length) {
      typeTimer = setTimeout(step, 16);
    } else {
      typeTimer = setTimeout(() => bubble.classList.add("hidden"), 8000);
    }
  };
  step();
}

window.kanban.onOpenPanel(() => { panel.classList.remove("hidden"); loadData(); });
window.kanban.onRunDiscover(async () => {
  await window.kanban.runDiscover();
  showBubble("🔍 爬取中，完成后提醒你~", 6000);
});

// ---------- 数据加载 ----------
async function loadData() {
  try {
    const data = await window.kanban.getData();
    if (data?.error) { showBubble(`⚠️ ${data.error}`); return; }

    // 爬取进度区块
    const prog = data.progress || { status: "idle", message: "暂无任务" };
    const progEl = document.getElementById("crawl-progress");
    const barWrap = document.getElementById("crawl-bar-wrap");
    const bar = document.getElementById("crawl-bar");
    if (prog.status === "running") {
      progEl.textContent = (prog.step === "solve" ? "✏️ " : "🔍 ") + (prog.message || "爬取中...");
      barWrap.classList.remove("hidden");
      const pct = prog.total > 0 ? Math.min(100, Math.round((prog.current / prog.total) * 100)) : 8;
      bar.style.width = pct + "%";
    } else if (prog.status === "done") {
      progEl.textContent = "✅ " + (prog.message || "完成");
      barWrap.classList.remove("hidden");
      bar.style.width = "100%";
    } else {
      progEl.textContent = "暂无任务";
      barWrap.classList.add("hidden");
    }

    // 学习清单（不阻塞主流程）
    loadStudyPlan();
    // 学习计划
    const plan = data.plan || {};
    let planHtml = "";
    const pad = (arr) => (arr && arr.length ? arr : []);
    for (const f of pad(plan.bishi)) {
      planHtml += `<div class="item"><span class="tag">笔试</span><span class="t">${escapeHtml(f.file || "")}</span></div>`;
    }
    for (const f of pad(plan.mianshi)) {
      planHtml += `<div class="item"><span class="tag">面经</span><span class="t">${escapeHtml(f.file || "")}</span></div>`;
    }
    planList.innerHTML = planHtml || '<div class="empty">暂无产出，先跑一次爬取吧</div>';

    // 最新产出
    const files = data.files || [];
    fileList.innerHTML = files.length
      ? files.slice(0, 6).map((f) =>
          `<div class="item"><span class="tag">${escapeHtml(f.company || "?")}</span><span class="t">${escapeHtml(f.title || "")}</span><span class="d">${f.dir}</span></div>`
        ).join("")
      : '<div class="empty">暂无</div>';

    // 输出目录
    const outputs = data.outputs || [];
    dirList.innerHTML = outputs.length
      ? outputs.map((o) => `<div class="item"><span class="d">${escapeHtml(o.dir)}</span><span class="d">${(o.mtime || "").slice(0, 10)}</span></div>`).join("")
      : "";

    // 有新产出时气泡提醒（对比上次）
    rememberFiles(files);
  } catch (e) {
    showBubble(`⚠️ 数据加载失败: ${e.message}`, 5000);
  }
}

// 新产出检测（渲染层内比较）
let lastSeen = new Set();
function rememberFiles(files) {
  const cur = new Set((files || []).map((f) => f.path));
  if (lastSeen.size > 0) {
    const fresh = (files || []).filter((f) => !lastSeen.has(f.path));
    if (fresh.length > 0) {
      const names = fresh.map((f) => f.company).join("、");
      showBubble(`🆕 发现新产出 ${fresh.length} 篇：${names}`, 8000);
    }
  }
  lastSeen = cur;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 爬取进度轮询（桌宠展示 + 完成提示） ----------
let crawlState = { status: "idle" };
let crawlNotified = false;

async function pollProgress() {
  try {
    const p = await window.kanban.getProgress();
    if (!p) return;

    // 状态变化：idle → running（爬取开始）
    if (p.status === "running" && crawlState.status !== "running") {
      crawlNotified = false;
      showBubble("🔍 " + (p.message || "爬取进行中..."), 6000);
    }
    // 运行中：进度更新（每步变化时气泡刷新，节流避免刷屏）
    else if (p.status === "running" && p.message && p.message !== crawlState.message) {
      if (p.step === "solve" || p.step === "fetch") {
        showBubble("⏳ " + p.message, 4000);
      }
    }
    // running → done（完成提示）
    else if (p.status === "done" && crawlState.status === "running" && !crawlNotified) {
      crawlNotified = true;
      showBubble("✅ " + (p.message || "爬取完成！"), 8000);
      if (window.kanban.notify) window.kanban.notify("✅ 爬取完成", p.message || "面经合集已更新");
    }
    // done → idle（下次爬取重置）
    else if (p.status === "idle" && crawlState.status === "done") {
      crawlState = { status: "idle" };
    }
    crawlState = { ...p };
  } catch { /* 服务未启动时静默 */ }
}

// 每 4 秒轮询进度
setInterval(pollProgress, 4000);
pollProgress();

// ---------- 启动 ----------
loadModel();
