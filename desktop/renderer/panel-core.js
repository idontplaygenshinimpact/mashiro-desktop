// 真白面板 · 核心（纵向拆分：desktop/renderer/panel.js → 5 个文件，普通 script 按序加载共享全局作用域）
/* exported pickMicDevice, safeUrl */
// 加载顺序：panel-core.js → panel-study.js → panel-chat.js → panel-jobs.js → panel-rest.js
// 真白面板逻辑：模拟面试 / 学习清单 / 对话 / 爬取产出
// 通过 preload 的 window.kanban 访问主进程 IPC（与桌宠共享）

// ============ API 基址单一来源（Phase 2 §3.5：收编 117 处硬编码 8899 直连） ============
// 与 desktop/renderer/api-client.mjs 的 BASE_URL 保持一致（同值双入口：普通 script 用常量，模块化代码用 client）
// 架构 P1-4：动态解析实际端口（widget 端口回退 EADDRINUSE 后同步——主进程读 widget-port.json），
// 启动即预取，解析前兜底 8899；所有 panel-*.js 共享本全局。
let API_BASE = "http://127.0.0.1:8899";
(async () => {
  try {
    const r = await window.kanban?.getApiBase?.();
    if (r && typeof r.base === "string" && r.base) API_BASE = r.base;
  } catch { /* 保持兜底 */ }
})();

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
  // 广播 tab 切换（M9：panel-rest 轮询按 Tab 门控——非当前 Tab 的轮询暂停）
  window.dispatchEvent(new CustomEvent("mianshi:tabchange", { detail: { tab: name } }));
  if (name === "interview") { loadIvWeakChips(); loadIvResumeAuto(); loadIvResume(); loadIvHistory(); }
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

// ---------- 渲染层同窗切换（方案 D：互斥容器，不叠加；挂载/卸载对称防事件泄漏） ----------
const rendererState = { interview: "native", review: "native", study: "native", chat: "native", crawl: "native", jobs: "native", dashboard: "native", kb: "native" };
const reactRoot = { current: null }; // React root 引用（对称卸载）
const vueApp = { current: null };    // Vue app 引用（对称卸载）

// 按需加载框架 bundle（M9：首屏不加载——切到对应面板才 import；动态 import 是 module 脚本，同源 CSP OK）
async function ensureBundle(kind) {
  if (kind === "react") {
    if (window.__mountReactPanel) return true;
    try { await import("./panel-react/dist/assets/react-panel.js"); return !!window.__mountReactPanel; }
    catch (e) { console.warn("[panel] React bundle 加载失败:", e); return false; }
  }
  if (kind === "vue") {
    if (window.__mountVueReview) return true;
    try { await import("./panel-vue-review/dist/assets/vue-review.js"); return !!window.__mountVueReview; }
    catch (e) { console.warn("[panel] Vue bundle 加载失败:", e); return false; }
  }
  return false;
}

async function switchRenderer(tab, mode) {
  const native = document.getElementById(`${tab}-native`);
  const react = document.getElementById(`${tab}-react`);
  const vue = document.getElementById(`${tab}-vue`);
  if (!native) return;
  // 框架容器不存在（该 Tab 的框架版未实现）→ 提示开发中（S1→S4 推进）
  if (mode === "react" && !react) {
    window.kanban?.notify?.("🎨 渲染层", `「${TAB_LABELS[tab] || tab}」的 React 版开发中（按 S1→S4 推进）`);
    return;
  }
  if (mode === "vue" && !vue) {
    window.kanban?.notify?.("🎨 渲染层", `「${TAB_LABELS[tab] || tab}」的 Vue 版开发中（按 S1→S4 推进）`);
    return;
  }
  if (mode === "react") {
    const ready = await ensureBundle("react");
    if (!ready) { window.kanban?.notify?.("🎨 渲染层", "React 版加载失败，请刷新面板重试"); return; }
    native.style.display = "none";
    react.style.display = "";
    if (!reactRoot.current) {
      try { reactRoot.current = window.__mountReactPanel(tab, react); }
      catch (e) { window.kanban?.notify?.("🎨 渲染层", "React 版挂载失败: " + (e?.message || e)); }
    }
  } else if (mode === "vue") {
    const ready = await ensureBundle("vue");
    if (!ready) { window.kanban?.notify?.("🎨 渲染层", "Vue 版加载失败，请刷新面板重试"); return; }
    native.style.display = "none";
    vue.style.display = "";
    if (!vueApp.current) {
      try { vueApp.current = window.__mountVueReview(tab, vue); }
      catch (e) { window.kanban?.notify?.("🎨 渲染层", "Vue 版挂载失败: " + (e?.message || e)); }
    }
  } else {
    if (react) react.style.display = "none";
    if (vue) vue.style.display = "none";
    native.style.display = "";
    if (reactRoot.current) {
      try { reactRoot.current.unmount(); } catch { /* 渲染异常时卸载失败不阻塞切换 */ }
      reactRoot.current = null; // 无论卸载成败都清引用（防"切不回来"：引用残留 → 再切 React 不重新挂载）
    }
    if (vueApp.current) {
      try { vueApp.current.unmount(); } catch { /* 渲染异常时卸载失败不阻塞切换 */ }
      vueApp.current = null; // 无论卸载成败都清引用（防"切不回来"）
    }
  }
  // 任务1 实现项 4：切换时状态处理——原生面板流式进行中切走：DOM 只隐藏不销毁（内容/滚动位置保留），
  // 后台任务本来也不依赖渲染层，这里只需明确告知"切换不中断"，避免用户误以为切走=取消
  if (mode !== "native" && window.panelState?.studyDetailState?.streaming) {
    window.kanban?.notify?.("🎨 渲染层", "讲解仍在后台生成：切回「原生」可见完整内容（切换不中断任务）");
  }
  rendererState[tab] = mode;
  saveRendererPref(tab, mode);
  // 按钮高亮同步
  document.querySelectorAll(`#tab-${tab} .renderer-switch-btn`).forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}

// 前端三态并行展示工单任务 1：偏好持久化（localStorage——刷新/重启保持）
// 工单原文写 settings.renderer_pref（后端设置表），这里改落 localStorage 的理由：渲染层偏好是"本客户端显示哪套 UI"，
// 归属前端；且 preload 没有通用 settingsGet/Set 桥（只有 ragConfig 这类专用通道），为一条 UI 偏好新增 IPC 通道不划算。
// Electron 的 localStorage 落在 userData 内，刷新/重启同样保持；后端 settings 表继续只放业务配置（薄弱点计数/追问缓存）。
const RENDERER_PREF_KEY = "renderer_pref";
/** 读偏好（损坏/非对象 → 空表：脏数据不阻塞切换，下次保存自动重建） */
function readRendererPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(RENDERER_PREF_KEY) || "{}");
    return prefs && typeof prefs === "object" ? prefs : {};
  } catch { return {}; }
}
function saveRendererPref(tab, mode) {
  try {
    const prefs = readRendererPrefs();
    prefs[tab] = mode;
    localStorage.setItem(RENDERER_PREF_KEY, JSON.stringify(prefs));
  } catch { /* localStorage 不可用（隐私模式/配额满）忽略——渲染层偏好非关键路径 */ }
}
/** 启动时恢复各 Tab 渲染层偏好（刷新/重启保持） */
function restoreRendererPrefs() {
  for (const [tab, mode] of Object.entries(readRendererPrefs())) {
    if (mode === "native") continue;
    if (document.getElementById(`${tab}-${mode}`)) switchRenderer(tab, mode);
  }
}

// 前端三态并行展示工单任务 1：全 Tab 三态切换按钮（interview/review 手写条只含已实现的框架版——这里补齐到统一三态）
const TAB_LABELS = { interview: "面试", review: "复习", study: "清单", chat: "对话", crawl: "爬取", jobs: "校招", dashboard: "驾驶舱", kb: "知识库" };
const RENDERER_MODES = [["native", "🎨 原生"], ["react", "⚛️ React 版"], ["vue", "🟢 Vue 版"]];
function initRendererSwitches() {
  for (const [tab, label] of Object.entries(TAB_LABELS)) {
    const panel = document.getElementById(`tab-${tab}`);
    if (!panel) continue;
    let bar = panel.querySelector(".renderer-switch-bar");
    if (!bar) {
      // 无手写切换条的 Tab：包 native 容器（切换时只隐藏不销毁）+ 新建切换条
      const native = document.createElement("div");
      native.id = `${tab}-native`;
      while (panel.firstChild) native.appendChild(panel.firstChild);
      bar = document.createElement("div");
      bar.className = "renderer-switch-bar";
      bar.innerHTML = `<span class="renderer-switch-label">渲染层：</span>`;
      panel.appendChild(bar);
      panel.appendChild(native);
    }
    bar.setAttribute("aria-label", `${label} 渲染层切换`);
    // 补齐缺失的模式按钮（如面试缺 Vue、复习缺 React）——点进去由 switchRenderer 提示"开发中"
    // 注意：手写按钮的点击绑定已在下方各自注册，这里只给新建按钮绑（避免重复监听）
    for (const [mode, text] of RENDERER_MODES) {
      if (bar.querySelector(`.renderer-switch-btn[data-mode="${mode}"]`)) continue;
      const b = document.createElement("button");
      b.className = "renderer-switch-btn";
      b.dataset.mode = mode;
      b.textContent = text;
      b.addEventListener("click", () => switchRenderer(tab, b.dataset.mode));
      bar.appendChild(b);
    }
    // 初始高亮：无偏好时为原生（restoreRendererPrefs 恢复成功后会改写）
    const cur = rendererState[tab] || "native";
    bar.querySelectorAll(".renderer-switch-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === cur));
  }
}

// 切换按钮绑定（面试 Tab：原生/React；复习 Tab：原生/Vue）
document.getElementById("iv-renderer-switch")?.addEventListener("click", () => switchRenderer("interview", "native"));
document.getElementById("iv-renderer-react")?.addEventListener("click", () => switchRenderer("interview", "react"));
document.getElementById("rv-renderer-switch")?.addEventListener("click", () => switchRenderer("review", "native"));
document.getElementById("rv-renderer-vue")?.addEventListener("click", () => switchRenderer("review", "vue"));

// 渲染层切换下拉（方案 B 入口，D 合入后语义调整为同窗切换）——选 React → 面试 Tab 切 React；选 Vue → 复习 Tab 切 Vue
const rendererSwitch = document.getElementById("renderer-switch");
if (rendererSwitch) {
  rendererSwitch.addEventListener("change", () => {
    const v = rendererSwitch.value;
    if (v === "react") { switchRenderer("interview", "react"); switchTab("interview"); }
    else if (v === "vue") { switchRenderer("review", "vue"); switchTab("review"); }
    rendererSwitch.value = "native"; // 切回原生（下拉是"跳转+切换"入口，不持久化）
  });
}

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

// ============ 🧩 插件面板动态渲染（阶段 3：manifest.panel.tabs/settings → 真实 tab） ============
// panel-core 先于 panel-chat 加载，esc() 此时未定义——用本地转义助手
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function initPluginTabs() {
  try {
    const r = await fetch(API_BASE + "/api/plugins");
    const j = await r.json();
    if (!j?.ok || !Array.isArray(j.plugins)) return;
    const nav = document.querySelector("nav.tabs");
    const main = document.querySelector("main");
    if (!nav || !main) return;
    for (const p of j.plugins) {
      if (p.disabled || !p.load?.ok) continue;
      const tabs = p.panel?.tabs || [];
      if (!tabs.length) continue;
      for (const t of tabs) {
        const tabName = `plg-${p.id}-${t.id}`;
        if (document.getElementById("tab-" + tabName)) continue; // 幂等
        const btn = document.createElement("button");
        btn.className = "tab";
        btn.dataset.tab = tabName;
        btn.textContent = t.label || t.id;
        btn.title = `插件：${p.name}`;
        btn.addEventListener("click", () => switchTab(tabName));
        nav.appendChild(btn);
        const sec = document.createElement("section");
        sec.id = "tab-" + tabName;
        sec.className = "tab-panel";
        sec.innerHTML = `<div class="jobs-setup">
          <div class="form-row">
            <label>${escHtml(t.label)} <span style="font-weight:normal;color:#6a6790;font-size:11px;">—— 来自插件 ${escHtml(p.name)} v${escHtml(p.version || "")}</span></label>
          </div>
          <div class="plg-tab-body" data-plg="${escHtml(p.id)}" data-tab="${escHtml(t.id)}" style="margin-top:8px;"></div>
        </div>`;
        main.appendChild(sec);
      }
      // 插件设置表单（panel.settings 声明）渲染到第一个 tab
      const decls = p.panel?.settings || [];
      const firstBody = document.querySelector(`#tab-plg-${p.id}-${tabs[0].id} .plg-tab-body`);
      if (!firstBody) continue;
      if (!decls.length) {
        firstBody.innerHTML = '<div style="color:#6a6790;font-size:12px;">该插件未声明面板设置</div>';
        continue;
      }
      try {
        const sr = await fetch(`${API_BASE}/api/plugins/settings?plugin=${p.id}`);
        const sj = await sr.json();
        const vals = (sj && sj.settings) || {};
        // 设置项输入框 id：p.id/s.key 均转义（原样拼 HTML 属性是 XSS 注入面），写入/读取必须用同一转义值
        const plgSetId = (pid, key) => "plg-set-" + escHtml(pid) + "-" + escHtml(key);
        const rows = decls.map((s) => {
          const v = vals[s.key];
          const label = escHtml(s.label || s.key);
          if (s.type === "toggle") {
            return `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
              <input type="checkbox" id="${plgSetId(p.id, s.key)}" ${v ? "checked" : ""} style="width:15px;height:15px;accent-color:#6d4fd8;">
              <span style="font-size:12px;color:#4a3a9d;">${label}</span></div>`;
          }
          const type = s.type === "password" ? "password" : "text";
          return `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;">
            <span style="font-size:12px;color:#4a3a9d;min-width:90px;">${label}</span>
            <input type="${type}" id="${plgSetId(p.id, s.key)}" value="${escHtml(v ?? "")}"
              style="flex:1;min-width:140px;padding:5px 8px;font-size:11px;border-radius:6px;border:1px solid rgba(138,90,220,.25);background:rgba(20,18,36,.6);color:#e8e6f2;"></div>`;
        }).join("");
        firstBody.innerHTML = `<div style="font-size:11px;color:#6a6790;">插件设置（存于本机，命名空间 plg_${escHtml(p.id)}_*）</div>
          ${rows}
          <div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
            <button class="secondary" style="padding:6px 12px;font-size:11px;" data-plg-save="${escHtml(p.id)}">💾 保存插件设置</button>
            <span class="resume-status" id="plg-save-status-${escHtml(p.id)}"></span>
          </div>`;
        const saveBtn = firstBody.querySelector(`[data-plg-save="${p.id}"]`);
        if (saveBtn) {
          saveBtn.addEventListener("click", async () => {
            const out = {};
            for (const s of decls) {
              const el = document.getElementById(plgSetId(p.id, s.key));
              if (!el) continue;
              out[s.key] = s.type === "toggle" ? el.checked : el.value;
            }
            let allOk = true;
            for (const [k, v] of Object.entries(out)) {
              try {
                const rr = await fetch(API_BASE + "/api/plugins/settings", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: p.id, key: k, value: v }),
                });
                const jj = await rr.json();
                if (!jj?.ok) allOk = false;
              } catch { allOk = false; }
            }
            const st = document.getElementById(`plg-save-status-${p.id}`);
            if (st) st.textContent = allOk ? "✅ 已保存" : "⚠️ 部分保存失败";
          });
        }
      } catch { firstBody.innerHTML = '<div style="color:#6a6790;font-size:12px;">设置加载失败（旧版后台服务）</div>'; }
    }
  } catch { /* 后台服务未启动 → 插件 tab 不渲染（不打扰面板） */ }
}
initPluginTabs();

// 前端三态并行展示工单任务 1：全 Tab 切换按钮 + 偏好恢复（刷新/重启保持）
initRendererSwitches();
restoreRendererPrefs();




