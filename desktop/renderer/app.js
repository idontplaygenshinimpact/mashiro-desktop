// 桌宠渲染层（精简版）：Live2D 真白 + 气泡 + 点击开面板 + 部位反应 + 时间问候
// 学习清单/对话/爬取/模拟面试全部在独立大面板（panel.html/panel.js）
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

// ---------- PIXI + Live2D ----------
const app = new PIXI.Application({
  view: canvas,
  transparent: true,
  backgroundAlpha: 0,
  autoStart: true,
  resizeTo: window,
  antialias: true,
  sharedTicker: true, // 关键：autoUpdate 注册到共享 ticker，否则 deltaTime 为 NaN
});
const glCtx = app.renderer.gl;
if (glCtx) { try { glCtx.clearColor(0, 0, 0, 0); } catch { /* ignore */ } }

// 手动监听 resize（fit 时窗口隐藏，resizeTo 可能不触发）
window.addEventListener("resize", () => {
  app.renderer.resize(window.innerWidth, window.innerHeight);
  if (model) {
    model.position.set(window.innerWidth / 2, window.innerHeight - model.height / 2 - 20);
  }
});

let model = null;

async function loadModel() {
  try {
    let modelPath = window.kanban?.modelPath || "";
    if (!modelPath) {
      modelPath = new URL(
        "../../node_modules/live2d-widget-model-mashiro-zamp/assets/model/Sakurasou/mashiro/ryoufuku.model.json",
        import.meta.url
      ).href;
    } else if (!modelPath.startsWith("file:")) {
      modelPath = "file:///" + modelPath.replace(/\\/g, "/");
    }
    model = await Live2DModel.from(modelPath, { autoInteract: false });
    // 半身模型（Sakurasou mashiro），适配窗口
    const targetH = 300;
    const scale = targetH / (model.height || 1000);
    model.scale.set(scale);
    model.anchor.set(0.5, 0.5);
    app.stage.addChild(model);
    model.position.set(app.screen.width / 2, app.screen.height - model.height / 2 - 20);

    // 待机动作（只播温和 idle，不播 tap 防镜头推近"变大"）
    startIdleMotion();

    // 通知主进程显示窗口
    try { await window.kanban.fitWindow(); } catch { /* ignore */ }
    // 初始：默认穿透（鼠标不在角色区域时不影响下层应用）
    lastInArea = false;
    window.kanban.setIgnoreMouse(true);
    // 加载成功问候
    showBubble("……嗯。我在。", 5000);
    setTimeout(maybeTimeGreeting, 5000);
  } catch (e) {
    showBubble("😢 Live2D 加载失败: " + e.message, 8000);
    // 模型加载失败也必须让窗口可见（否则错误气泡永远在隐藏窗口里，应用看起来像没启动）
    try { await window.kanban.fitWindow(); } catch { /* ignore */ }
  }
}

function startIdleMotion() {
  setInterval(() => {
    if (!model) return;
    try { model.motion("idle"); } catch { /* ignore */ }
  }, 25000);
}

// ---------- 拖拽（setBounds 固定尺寸避免 DWM 漂移） ----------
let dragging = false, moved = false, offset = { x: 0, y: 0 }, downAt = null, lastMoveTs = 0;

canvas.addEventListener("pointerdown", (e) => {
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
  if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
  if (moved) {
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
  if (!moved && Date.now() - downAt < 400) {
    handleClick(e);
  }
});

// 双击角色 → 打开大面板（单击=人设反应，双击=面板；双击会取消挂起的单击戳反应）
let lastClickTs = 0;
canvas.addEventListener("dblclick", (e) => {
  clearTimeout(clickTimer); // 取消单击的延迟语音/气泡
  window.kanban.togglePanel();
});

// ---------- 鼠标穿透：只在角色模型附近可交互，其余区域点击穿透到下层应用 ----------
// 区域 = 模型实际渲染包围盒（按 model.width/height 实时计算）* 收缩系数，贴合模型轮廓
let ignoreActive = false;
let lastInArea = null;
// 命中区：宽度=模型宽×0.6（左右贴合）；高度=模型高×0.55，中心比模型中心下移 15px（顶部明显收小）
const HIT_SHRINK_W = 0.6;
const HIT_SHRINK_H = 0.55;

function getModelRect() {
  const cx = window.innerWidth / 2;
  let w = 190, h = 320; // 兜底估计
  try {
    if (model && model.width > 0 && model.height > 0) {
      w = model.width;
      h = model.height;
    }
  } catch { /* ignore */ }
  // 模型中心 = 内高-170（position: 内高 - h/2 - 20，anchor 0.5）；命中区中心下移 15px
  const cy = window.innerHeight - 155;
  const hh = h * HIT_SHRINK_H;
  return { cx, cy, w: w * HIT_SHRINK_W, h: hh };
}

function isInModelArea(x, y) {
  const r = getModelRect();
  const inModel = Math.abs(x - r.cx) < r.w / 2 && Math.abs(y - r.cy) < r.h / 2;
  // 气泡区：只覆盖气泡本身（顶部中央，宽 140 高 50）
  const inBubble = y < 55 && Math.abs(x - window.innerWidth / 2) < 70;
  return inModel || inBubble;
}

window.addEventListener("mousemove", (e) => {
  const inArea = isInModelArea(e.clientX, e.clientY);
  if (inArea !== lastInArea) {
    lastInArea = inArea;
    // 在角色区域 → 可交互；透明区域 → 穿透
    window.kanban.setIgnoreMouse(!inArea);
  }
});

// 鼠标离开窗口 → 恢复穿透
window.addEventListener("mouseleave", () => {
  if (!ignoreActive) { ignoreActive = true; window.kanban.setIgnoreMouse(true); }
  lastInArea = false;
});
// 进入窗口 → 根据位置决定（mousemove 会接管）
window.addEventListener("mouseenter", () => { ignoreActive = false; });

// ---------- 点击部位反应（真白人设） ----------
const MASHIRO_REACTIONS = {
  head: ["……嗯？有人在摸我的头。像在画布上轻轻扫了一层底色。", "……头被摸了。会分心。不过……不讨厌。"],
  face: ["……戳脸的话，颜料会花的。", "……脸。不要戳。会画歪的。"],
  body: ["……不要乱动。我还在想构图。", "……嗯。你在我旁边。"],
  hand: ["这双手……是用来画画的。你要看吗？", "……手。握画笔的地方有茧。"],
  default: ["……嗯？", "……我在。", "……今天画什么好呢。"],
};

let lastTapTs = 0, tapCount = 0, voiceOn = true;
let clickTimer = null; // 单击反应延迟器：等待确认不是双击

// 订阅全局语音开关（面板 🔊 切换 → main 广播 → 桌宠同步静音/恢复）
window.kanban?.onVoiceChanged?.((enabled) => { voiceOn = !!enabled; });

// 订阅专注监督事件（主进程 pet-say 广播）：气泡 + 场景语音（focus-start/focus-done/focus-nudge）
window.kanban?.onPetSay?.(({ text, scene }) => {
  if (text) showBubble(text, 6000);
  if (scene) { try { window.kanban.playScene(scene); } catch { /* ignore */ } }
});

async function handleClick(e) {
  // 命中部位检测
  let hitArea = null;
  try {
    if (model?.internalModel?.hitTest) {
      const rect = canvas.getBoundingClientRect();
      const hits = model.internalModel.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hits?.length) hitArea = hits[0];
    }
  } catch { /* ignore */ }

  // 连击检测
  const now = Date.now();
  if (now - lastTapTs < 3000) tapCount++; else tapCount = 1;
  lastTapTs = now;

  let reaction;
  if (tapCount >= 3) {
    reaction = "……你，很无聊吗？我可以分你一支画笔。";
  } else {
    const pool = MASHIRO_REACTIONS[hitArea] || MASHIRO_REACTIONS.default;
    reaction = pool[Math.floor(Math.random() * pool.length)];
  }

  // 延迟触发：280ms 内若出现第二次点击（双击开面板），取消戳反应，避免误语音
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    showBubble(reaction, 5000);
    if (voiceOn) window.kanban.playScene("click");
  }, 280);
}

// ---------- 打开大面板 ----------
// 双击角色打开；托盘"打开面板"也可
// （status-dot 是装饰提示）

// ---------- 气泡 ----------
let bubbleTimer = null;
function showBubble(text, duration = 5000) {
  bubbleText.textContent = text;
  bubble.classList.remove("hidden");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.add("hidden"), duration);
}

// ---------- 时间问候（一天一次） ----------
const TIME_GREETINGS = [
  { range: [5, 10], text: "……早。我还没想好今天画什么。你呢？" },
  { range: [10, 18], text: "光线不错。适合画素描……也适合学习。" },
  { range: [18, 20], text: "……天要暗了。该收画笔了。你收工了吗？" },
  { range: [20, 23], text: "……这么晚还醒着。记得早点睡。" },
  { range: [0, 5], text: "……夜晚的颜色其实很好看。但你该睡了。" },
];

function maybeTimeGreeting() {
  try {
    const h = new Date().getHours();
    const g = TIME_GREETINGS.find((x) => h >= x.range[0] && h < x.range[1]);
    if (!g) return;
    const today = new Date().toISOString().slice(0, 10);
    const key = "mashiro-greeting-" + today;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, g.text);
    showBubble(g.text, 8000);
    if (voiceOn) window.kanban.speak(g.text);
  } catch { /* ignore */ }
}

// ---------- 启动 ----------
loadModel();
