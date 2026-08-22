// 真白面板 · 核心（纵向拆分：desktop/renderer/panel.js → 5 个文件，普通 script 按序加载共享全局作用域）
/* exported pickMicDevice, safeUrl */
// 加载顺序：panel-core.js → panel-study.js → panel-chat.js → panel-jobs.js → panel-rest.js
// 真白面板逻辑：模拟面试 / 学习清单 / 对话 / 爬取产出
// 通过 preload 的 window.kanban 访问主进程 IPC（与桌宠共享）

// ============ 全局错误捕获（任何未捕获 JS 错误 → 主进程日志 + 面板可见，便于定位） ============
window.addEventListener("error", (e) => {
  const msg = `[panel-error] ${String(e.message || e.error || "未知错误").slice(0, 200)} @ ${String(e.filename || "").split("/").pop()}:${e.lineno || ""}`;
  console.error(msg);
  try { window.kanban?.notify?.("⚠️ 面板错误", msg.replace("[panel-error] ", "").slice(0, 80)); } catch { /* ignore */ }
});
window.addEventListener("unhandledrejection", (e) => {
  const stack = (e.reason?.stack || "").split("\n").slice(0, 4).join(" | ");
  const msg = `[panel-error] unhandledrejection: ${String(e.reason?.message || e.reason || "未知").slice(0, 200)} ${stack.slice(0, 300)}`;
  console.error(msg);
  try { window.kanban?.notify?.("⚠️ 面板错误", String(e.reason?.message || e.reason || "未知").slice(0, 80)); } catch { /* ignore */ }
});

// ============ Tab 切换 ============
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (btn) btn.classList.add("active");
  const panel = document.getElementById("tab-" + name);
  if (panel) panel.classList.add("active");
  if (name === "interview") { loadIvWeakChips(); loadIvResumeAuto(); }
  if (name === "study") { loadStudyPlan(); loadFocus(); }
  if (name === "crawl") { loadCrawlData(); loadRss(); }
  if (name === "review") loadReview();
  if (name === "kb") { loadKbStats(); loadDocs(); loadDocsProject(); }
  if (name === "dashboard") loadDashboard();
  if (name === "jobs") { loadSchedule(); startJobsSchedTimer(); }
  else stopJobsSchedTimer();
  if (name === "settings") { loadSettings(); loadProfileStatus(); }
  $("settings-gear")?.classList.toggle("active", name === "settings");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// 主进程菜单「✍️ 手写/算法题库」→ 切到校招 Tab 并滚动到题库区块
window.kanban?.onPanelGotoChallenges?.(() => {
  switchTab("jobs");
  setTimeout(() => {
    const el = document.getElementById("challenge-status");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.closest(".jobs-setup")?.scrollIntoView({ behavior: "smooth", block: "start" });
      loadChallenges();
    }
  }, 300);
});
// 桌宠快捷菜单「💬 聊天 / ⚙️ 设置」→ 切到对应 Tab
window.kanban?.onPanelGotoTab?.((tab) => {
  if (tab === "chat" || tab === "settings") switchTab(tab);
});

const $ = (id) => document.getElementById(id);

// 选择可用麦克风：Chromium getUserMedia 用系统默认输入设备——若默认设备是无声的
// （实测本机默认=MCHOSE 麦克风采集全零，Realtek 显式指定 98.5% 非零），必须显式选物理麦克风
async function pickMicDevice() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const inputs = devs.filter((d) => d.kind === "audioinput" && !/^(default|communications)$/i.test(String(d.deviceId)));
    if (!inputs.length) return null;
    // 优先物理麦克风（Realtek/麦克风/Microphone），避开 立体声混音/虚拟/无实际输入设备
    const physical = inputs.find((d) => /realtek|麦克风|microphone/i.test(d.label || "") && !/stereo|mix|混音|virtual|virtual audio/i.test(d.label || ""));
    return (physical || inputs[0]).deviceId;
  } catch { return null; }
}

// 链接安全：只允许 http/https/mailto（防 javascript: 协议注入）
function safeUrl(u) {
  return /^(https?:|mailto:)/i.test(String(u || "")) ? u : "#";
}

