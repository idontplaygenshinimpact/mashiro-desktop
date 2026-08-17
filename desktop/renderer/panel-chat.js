// 真白面板 · 对话/产出/杂项域（纵向拆分）
// ============ 对话 ============
let chatHistory = [];
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

function addChatMsg(role, text) {
  const log = $("chat-log");
  const div = document.createElement("div");
  div.className = "chat-msg " + role;
  // 真白回复是 Markdown（标题/列表/代码块/表格）→ 复用 renderMd 解析，聊天气泡内完整渲染
  div.innerHTML = `<div class="avatar">${role === "user" ? "👤" : "🎀"}</div><div class="msg-main"><div class="who">${role === "user" ? "你" : "真白"}</div><div class="body">${role === "user" ? esc(text) : renderMd(text)}</div></div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function sendChat() {
  const msg = $("chat-input").value.trim();
  if (!msg) return;
  $("chat-input").value = "";
  addChatMsg("user", msg);
  const thinking = addChatMsg("bot", "🤔 真白思考中...");
  thinking.querySelector(".body").className = "body thinking";
  try {
    const r = await window.kanban.chat(msg, chatHistory);
    chatHistory = r.history || [];
    // 语音：用回复文本匹配日语预设台词（r.voice 已不再由 LLM 生成）
    if (voiceOn) window.kanban.speak(r.voice || r.reply || msg);
    thinking.querySelector(".body").className = "body";
    thinking.querySelector(".body").innerHTML = renderMd(r.reply || "（无回复）");
  } catch (e) {
    thinking.querySelector(".body").textContent = "⚠️ " + e.message;
  }
}

// ============ 爬取产出 ============
async function loadCrawlData() {
  const r = await window.kanban.getData();
  if (!r?.ok) return;
  const prog = r.progress || {};
  if (prog.status === "running") {
    $("crawl-progress").textContent = "🔍 " + (prog.message || "爬取中...");
    $("crawl-bar-wrap").classList.remove("hidden");
    const pct = prog.total ? Math.min(100, Math.round(prog.current / prog.total * 100)) : 8;
    $("crawl-bar").style.width = pct + "%";
  } else if (prog.status === "done") {
    $("crawl-progress").textContent = "✅ " + (prog.message || "完成");
    $("crawl-bar-wrap").classList.remove("hidden");
    $("crawl-bar").style.width = "100%";
  } else {
    $("crawl-progress").textContent = "暂无任务";
    $("crawl-bar-wrap").classList.add("hidden");
  }
  const files = r.files || [];
  $("file-list").innerHTML = files.length
    ? files.slice(0, 12).map((f) => `
      <div class="file-item">
        <span class="tag">${esc(f.company || "?")}</span>
        <span class="t">${esc(f.title || "")}</span>
        <span style="color:#6c6c7c;font-size:10px">${esc(f.dir || "")}</span>
      </div>`).join("")
    : '<div style="color:#7c7c7c;font-size:12px">暂无产出</div>';
  // 今日推荐（笔试/面经轮转建议）
  const reco = r.plan || {};
  const recoItems = [...(reco.bishi || []).map((f) => ({ ...f, tag: "笔试" })), ...(reco.mianshi || []).map((f) => ({ ...f, tag: "面经" }))];
  if (recoItems.length) {
    $("today-reco").classList.remove("hidden");
    $("today-reco-body").innerHTML = recoItems.map((f) => `
      <div class="file-item">
        <span class="tag reco-${f.tag === "笔试" ? "bishi" : "mianshi"}">${f.tag}</span>
        <span class="t">${esc(f.title || f.file || "")}</span>
      </div>`).join("");
  } else {
    $("today-reco").classList.add("hidden");
  }
  // 使用统计（对话/复习/面试）
  try {
    const s = await window.kanban.getStats();
    if (s?.ok && s.stats) {
      $("stats-row").innerHTML = `
        <div class="stat-chip">💬 对话 <b>${s.stats.chats || 0}</b></div>
        <div class="stat-chip">📝 复盘 <b>${s.stats.reviewsDone || 0}</b></div>
        <div class="stat-chip">🎤 面试 <b>${s.stats.interviewsDone || 0}</b></div>
        <div class="stat-chip">📚 复习 <b>${r.review?.total || 0}</b></div>`;
    }
  } catch { /* ignore */ }
  // 可观测性：LLM 调用统计
  try {
    const o = await window.kanban.getObservability();
    if (o?.ok && o.llm) {
      const l = o.llm;
      $("obs-row").innerHTML = `
        <div class="stat-chip">⚡ LLM 调用 <b>${l.total}</b></div>
        <div class="stat-chip">⏱️ 总耗时 <b>${(l.totalDurationMs / 1000).toFixed(1)}s</b></div>
        <div class="stat-chip">📥 输入 <b>${(l.totalInputTokens / 1000).toFixed(1)}k</b></div>
        <div class="stat-chip">📤 输出 <b>${(l.totalOutputTokens / 1000).toFixed(1)}k</b></div>
        <div class="stat-chip ${l.fail > 0 ? "chip-fail" : ""}">❌ 失败 <b>${l.fail}</b></div>`;
      // 最近调用
      $("obs-list").innerHTML = (l.recent || []).map((r2) => `
        <div class="obs-item">
          <span class="tag ${r2.ok ? "" : "tag-fail"}">${r2.ok ? "✅" : "❌"} ${esc(r2.role)}</span>
          <span class="t">${esc(String(r2.model || "").slice(0, 22))}${r2.stream ? " ⤳" : ""}</span>
          <span style="color:#6c6c7c;font-size:10px">${r2.durationMs}ms ${r2.input_tokens ? "· " + r2.input_tokens + "→" + (r2.output_tokens || 0) + "tok" : ""}</span>
        </div>`).join("") || '<div style="color:#7c7c7c;font-size:12px">暂无调用记录</div>';
    }
  } catch { /* ignore */ }
  // 上下文计量（当前对话用量，防上下文盲区）
  try {
    const cm = await fetch("http://127.0.0.1:8899/api/context-meter").then((r) => r.json());
    const meter = document.getElementById("ctx-meter");
    if (meter && cm?.ok) {
      const ratio = cm.ratio || 0;
      const color = ratio > 70 ? "#e05a5a" : ratio > 40 ? "#e0a03a" : "#5fd85f";
      meter.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;font-size:12px;color:#c9c6dd;">
          <span>🧠 对话上下文</span>
          <div style="flex:1;max-width:220px;height:8px;background:rgba(255,255,255,.1);border-radius:4px;overflow:hidden;">
            <div style="width:${ratio}%;height:100%;background:${color};transition:width .4s;"></div>
          </div>
          <span>${cm.current.toLocaleString()} tok / ${(cm.budget / 1000).toFixed(0)}k（${ratio}%）</span>
          <span style="color:#8a87a8">消息 ${cm.messages} 条 · ${cm.rounds} 轮${ratio >= 30 ? " · 已触发压缩阈值" : ""}</span>
        </div>`;
    }
  } catch { /* ignore */ }
  // 自动巡检配置（开关/频率/状态）
  loadPatrolConfig();
  // 系统自检报告（表堆积/产出污染/巡检停摆/LLM 失败率）
  loadSelfCheck();
  // 面试历史（点击展开完整复盘 + 五维雷达）
  try {
    const h = await window.kanban.interviewHistory();
    const list = (h?.history || []).slice(-5).reverse();
    $("interview-history").innerHTML = list.length
      ? list.map((it) => {
          const dims = DIM_LABELS.map(([k, l]) => [k, l, Math.round((it.dims || {})[k] ?? 0)]);
          const dimsBars = dims.map(([k, l, v]) => scoreBarHtml(l, v)).join("");
          return `
        <div class="iv-hist-item">
          <div class="iv-hist-head">${esc(it.position || "模拟面试")} · ${esc(it.role || "")} · ${it.rounds || 0} 轮
            <span class="iv-hist-score">均分 ${it.avg ?? it.avgScore ?? "-"}</span>
            ${it.report ? `<button class="iv-hist-expand">详情 ▾</button>` : ""}</div>
          ${it.report ? `<div class="iv-hist-report">${esc(it.report).slice(0, 120)}${it.report.length > 120 ? "..." : ""}</div>` : ""}
          <div class="iv-hist-detail hidden">
            <div class="iv-hist-dims">${dimsBars}</div>
            <div class="iv-radar-wrap small"><canvas width="210" height="170"></canvas></div>
            <div class="iv-hist-full">${esc(it.report || "")}</div>
          </div>
        </div>`;
        }).join("")
      : '<div style="color:#7c7c7c;font-size:12px">暂无面试记录，去「🎤 模拟面试」来一场吧</div>';
    // 展开/收起 + 雷达图（dims 已存在 item.dataset 上）
    $("interview-history").querySelectorAll(".iv-hist-item").forEach((item) => {
      const btn = item.querySelector(".iv-hist-expand");
      if (!btn) return;
      btn.addEventListener("click", () => {
        const detail = item.querySelector(".iv-hist-detail");
        const hidden = detail.classList.toggle("hidden");
        btn.textContent = hidden ? "详情 ▾" : "收起 ▴";
        if (!hidden) {
          const canvas = detail.querySelector("canvas");
          try {
            const d = JSON.parse(item.dataset.dims || "{}");
            drawIvRadar(canvas, DIM_LABELS.map(([k, l]) => [k, l, Math.round(d[k] ?? 0)]));
          } catch { /* ignore */ }
        }
      });
    });
    // 把 dims 存到 item 上（雷达图展开时用）
    list.forEach((it, i) => {
      const item = $("interview-history").querySelectorAll(".iv-hist-item")[i];
      if (item) item.dataset.dims = JSON.stringify(it.dims || {});
    });
  } catch { /* ignore */ }
}

$("crawl-run").addEventListener("click", async () => {
  await window.kanban.runDiscover();
  $("crawl-progress").textContent = "🔍 爬取已启动...";
});
$("crawl-output").addEventListener("click", () => window.kanban.openOutput());

// ============ 自动巡检设置 ============
async function loadPatrolConfig() {
  try {
    const r = await window.kanban.patrolConfig();
    if (!r?.ok) { $("patrol-status").textContent = "⚠️ " + (r?.error || "读取失败"); return; }
    const sel = $("patrol-interval");
    $("patrol-enabled").checked = !!r.enabled;
    sel.value = String(r.intervalMin);
    if (sel.value !== String(r.intervalMin)) { // 自定义频率不在预设下拉里 → 追加选项
      const opt = document.createElement("option");
      opt.value = String(r.intervalMin);
      opt.textContent = `${r.intervalMin} 分钟`;
      sel.appendChild(opt);
      sel.value = String(r.intervalMin);
    }
    renderPatrolStatus(r);
  } catch (e) {
    $("patrol-status").textContent = "⚠️ " + String(e.message || e).slice(0, 60);
  }
}
function renderPatrolStatus(cfg) {
  const fmt = (ts) => (ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "—");
  const parts = [
    `当前配置：${cfg.enabled ? "开启" : "关闭"} · 每 ${cfg.intervalMin} 分钟`,
    `上次巡检：${fmt(cfg.lastRun)}`,
    `下次巡检：${cfg.enabled && cfg.nextRun ? fmt(cfg.nextRun) : "—"}`,
  ];
  if (cfg.note) parts.push(`（${cfg.note}）`);
  $("patrol-status").innerHTML = parts.join("　");
}
async function savePatrolConfig(patch, tip) {
  try {
    const r = await window.kanban.patrolConfig(patch);
    if (!r?.ok) {
      window.kanban.notify("🛰️ 自动巡检", "保存失败：" + (r?.error || "未知错误"));
      loadPatrolConfig(); // 回滚到服务端实际配置
      return;
    }
    renderPatrolStatus(r);
    if (tip) window.kanban.notify("🛰️ 自动巡检", tip);
  } catch (e) {
    window.kanban.notify("🛰️ 自动巡检", "保存失败：" + String(e.message || e).slice(0, 60));
    loadPatrolConfig();
  }
}
$("patrol-enabled").addEventListener("change", () => {
  savePatrolConfig({ enabled: $("patrol-enabled").checked }, $("patrol-enabled").checked ? "自动巡检已开启" : "自动巡检已关闭");
});
$("patrol-interval").addEventListener("change", () => {
  savePatrolConfig({ intervalMin: parseInt($("patrol-interval").value, 10) }, `巡检频率已改为每 ${$("patrol-interval").value} 分钟`);
});
$("patrol-run").addEventListener("click", async () => {
  try {
    const r = await window.kanban.patrolRun();
    if (r?.ok) {
      $("patrol-run").textContent = "⏳ 已触发…";
      setTimeout(() => { $("patrol-run").textContent = "🚀 立即巡检"; }, 2000);
      window.kanban.notify("🛰️ 自动巡检", "已触发一次巡检，可在爬取产出/日志查看结果");
    } else {
      window.kanban.notify("🛰️ 自动巡检", "触发失败：" + (r?.error || "未知错误"));
    }
  } catch (e) {
    window.kanban.notify("🛰️ 自动巡检", "触发失败：" + String(e.message || e).slice(0, 60));
  }
});

// ============ 系统自检（自行发现隐患：表堆积/产出污染/巡检停摆/LLM 失败率） ============
async function loadSelfCheck() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/self-check");
    const j = await r.json();
    renderSelfCheck(j.report);
  } catch (e) {
    $("self-check-status").textContent = "⚠️ " + String(e.message || e).slice(0, 60);
  }
}
function renderSelfCheck(report) {
  const statusEl = $("self-check-status");
  const issuesEl = $("self-check-issues");
  const timeEl = $("self-check-time");
  if (!report) { statusEl.textContent = "还没跑过自检——点「🔄 立即检查」或等启动后 1 分钟自动首检"; issuesEl.innerHTML = ""; timeEl.textContent = ""; return; }
  const fmt = new Date(report.at).toLocaleString("zh-CN", { hour12: false });
  timeEl.textContent = `（${fmt}）`;
  const warns = report.issues || [];
  if (!warns.length) {
    statusEl.textContent = `✅ 全部正常（${(report.checks || []).length} 项检查）`;
    issuesEl.innerHTML = (report.checks || []).map((c) =>
      `<div style="color:#6b9d7d;">✓ ${esc(c.name)}：${esc(c.detail)}</div>`).join("");
    return;
  }
  statusEl.textContent = `⚠️ 发现 ${warns.length} 个问题（自动修复 ${warns.filter((i) => i.fixed).length} 个）`;
  issuesEl.innerHTML = warns.map((i) => `
    <div style="color:${i.fixed ? "#6b9d7d" : "#d98a3d"};margin-top:4px;">
      ${i.fixed ? "🔧" : "⚠️"} <b>${esc(i.name)}</b>：${esc(i.detail)}
      ${i.fixed ? '<span style="color:#8a87a8;">（已自动修复）</span>' : ""}
    </div>`).join("");
}
$("self-check-btn")?.addEventListener("click", async () => {
  const btn = $("self-check-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 检查中…";
  try {
    const r = await fetch("http://127.0.0.1:8899/api/self-check", { method: "POST" });
    const j = await r.json();
    renderSelfCheck(j.ok ? j : j.report);
    if (!j.ok) { $("self-check-status").textContent = "⚠️ " + (j.error || "检查失败"); return; }
    if (j.issues?.length) window.kanban.notify("🔍 系统自检", `发现 ${j.issues.length} 个问题（自动修复 ${j.issues.filter((i) => i.fixed).length} 个）`);
    else window.kanban.notify("🔍 系统自检", "全部正常");
  } catch (e) {
    $("self-check-status").textContent = "⚠️ " + String(e.message || e).slice(0, 60);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 立即检查";
  }
});

// ============ 语音开关 ============
let voiceOn = true;
$("voice-btn").addEventListener("click", () => {
  voiceOn = !voiceOn;
  window.kanban.setVoiceEnabled(voiceOn);   // 面板本地语音（对话/复习反馈）
  window.kanban.setGlobalVoice?.(voiceOn);  // 全局广播（桌宠同步静音）
  $("voice-btn").textContent = voiceOn ? "🔊" : "🔇";
});
$("refresh-btn").addEventListener("click", () => {
  loadCrawlData();
  loadStudyPlan();
});
// ⚙️ 齿轮：设置中心（方向/简历/邮箱/巡检/桌宠/数据维护）
$("settings-gear")?.addEventListener("click", () => switchTab("settings"));

// ============ 工具 ============
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============ 讲解弹层字号调节（localStorage 记忆） ============
const SD_FONT_MIN = 9, SD_FONT_MAX = 22, SD_FONT_STEP = 1;
function sdFontSize() {
  const v = parseInt(localStorage.getItem("sd-font-size") || "", 10);
  return v >= SD_FONT_MIN && v <= SD_FONT_MAX ? v : 13;
}
function applySdFontSize() {
  document.documentElement.style.setProperty("--sd-font-size", sdFontSize() + "px");
}
function changeSdFont(delta) {
  const next = Math.min(SD_FONT_MAX, Math.max(SD_FONT_MIN, sdFontSize() + delta));
  localStorage.setItem("sd-font-size", String(next));
  applySdFontSize();
}
document.getElementById("sd-font-plus")?.addEventListener("click", () => changeSdFont(SD_FONT_STEP));
document.getElementById("sd-font-minus")?.addEventListener("click", () => changeSdFont(-SD_FONT_STEP));
applySdFontSize();

// ============ 权限审批（human-in-the-loop） ============
// agent 请求执行敏感工具（solve_question / record_interview_topics）时，
// 顶部弹出确认条，用户决定 拒绝/允许/本会话允许（对标 Claude Code permission）
let currentApproval = null;

async function checkApprovals() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/approval-pending");
    const j = await r.json();
    const first = j?.pending?.[0] || null;
    const bar = document.getElementById("approval-bar");
    if (!bar) return;
    if (first && !currentApproval) {
      currentApproval = first;
      const nameMap = { solve_question: "生成完整讲解", record_interview_topics: "记录面试知识点" };
      document.getElementById("approval-text").textContent =
        `真白想执行：${nameMap[first.toolName] || first.toolName} —— ${first.reason || ""}`;
      bar.hidden = false;
    } else if (!first && currentApproval) {
      currentApproval = null;
      bar.hidden = true;
    }
  } catch { /* 服务未就绪忽略 */ }
}

async function sendApproval(action) {
  if (!currentApproval) return;
  const allow = action !== "deny";
  const session = action === "allow-session";
  try {
    await fetch("http://127.0.0.1:8899/api/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: currentApproval.toolName, allow, session }),
    });
  } catch { /* ignore */ }
  currentApproval = null;
  document.getElementById("approval-bar").hidden = true;
  setTimeout(checkApprovals, 800); // 立即查下一个
}

document.querySelectorAll(".approval-btn").forEach((btn) => {
  btn.addEventListener("click", () => sendApproval(btn.dataset.action));
});

// ============ 提问条（agent 的 ask_user / plan_mode 挂起等待点选） ============
let currentAsk = null;

async function checkAsks() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/ask/pending");
    const j = await r.json();
    const first = j?.asks?.[0] || null;
    const bar = document.getElementById("ask-bar");
    if (!bar) return;
    if (first && !currentAsk) {
      currentAsk = first;
      document.getElementById("ask-text").textContent = first.kind === "plan" ? first.question : `❓ ${first.question}`;
      const optsBox = document.getElementById("ask-options");
      optsBox.innerHTML = (first.options || []).map((o, i) => `
        <button class="approval-btn" data-opt="${esc(o.label)}" data-idx="${i}" title="${esc(o.description || "")}"
          style="background:${o.label.startsWith("✅") ? "rgba(80,200,120,.2)" : o.label.startsWith("❌") ? "rgba(220,80,80,.2)" : "rgba(109,79,216,.25)"}">${esc(o.label)}</button>`).join("");
      optsBox.querySelectorAll("button[data-opt]").forEach((btn) => {
        btn.addEventListener("click", () => sendAskAnswer(btn.dataset.opt));
      });
      bar.hidden = false;
    } else if (!first && currentAsk) {
      currentAsk = null;
      bar.hidden = true;
    }
  } catch { /* 服务未就绪忽略 */ }
}

async function sendAskAnswer(label) {
  if (!currentAsk) return;
  try {
    await fetch("http://127.0.0.1:8899/api/ask/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: currentAsk.id, selected: [label] }),
    });
  } catch { /* ignore */ }
  currentAsk = null;
  document.getElementById("ask-bar").hidden = true;
  setTimeout(checkAsks, 800);
}

// ============ 一键重启（改代码后点它即生效：自动检测并重建前端 bundle + 重启桌宠/后台服务） ============
document.getElementById("restart-btn")?.addEventListener("click", async () => {
  if (!confirm("确定重启桌宠吗？\n后台服务会一并重启（约 3-5 秒）。改过前端代码会自动重新构建，点这个就能生效。")) return;
  const btn = document.getElementById("restart-btn");
  btn.disabled = true;
  btn.textContent = "⏳";
  try {
    await window.kanban.restartApp();
  } catch { /* 进程即将退出，忽略 */ }
});

// ============ 服务版本检测（后台 widget 是旧进程时提示重启桌宠） ============
async function checkServiceVersion() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/health", { cache: "no-store" });
    const j = await r.json();
    const warn = document.getElementById("service-warn");
    if (!warn) return;
    // 旧版 widget 无 version 字段 → 提示（面板是新代码但后台是旧进程）
    if (j?.ok && !j.version) {
      document.getElementById("service-warn-text").textContent =
        "⚠️ 后台服务是旧版本（面板已更新但 widget 未重启）——功能可能异常，请重启桌宠：托盘退出后重新运行 start-kanban.bat";
      warn.hidden = false;
    } else if (!j?.ok) {
      document.getElementById("service-warn-text").textContent = "⚠️ 后台服务未响应，请确认桌宠已启动";
      warn.hidden = false;
    }
  } catch { /* 服务未启动：其他请求也会失败，不重复提示 */ }
}

document.getElementById("service-warn-close")?.addEventListener("click", () => {
  document.getElementById("service-warn").hidden = true;
});
// ============ 桌宠形象（Live2D 模型切换） ============
async function loadMascotModels() {
  try {
    const r = await window.kanban.mascotModels();
    if (!r?.ok || !Array.isArray(r.models) || !r.models.length) return;
    const box = document.getElementById("mascot-models");
    const cur = document.getElementById("mascot-current");
    if (!box) return;
    if (cur) cur.textContent = "· 当前：" + (r.models.find((m) => m.path === r.current)?.name || "默认");
    box.innerHTML = r.models.map((m) => `
      <button class="job-btn mascot-btn" data-path="${esc(m.path)}" data-name="${esc(m.name)}"
        style="${m.path === r.current ? "background:linear-gradient(135deg,#8a5adc,#6d4fd8);color:#fff;" : ""}">${esc(m.name)}</button>`).join("");
    box.querySelectorAll(".mascot-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const res = await window.kanban.mascotSetModel(btn.dataset.path);
        if (res?.ok) {
          window.kanban.notify("🎀 桌宠形象", `已切换为 ${res.model.name}，桌宠立即生效`);
          loadMascotModels();
        } else {
          window.kanban.notify("🎀 桌宠形象", String(res?.error || "切换失败").slice(0, 60));
        }
      });
    });
  } catch { /* 主进程未就绪忽略 */ }
}

// ============ 任务清单（agent todo：多步任务可见进度） ============
async function loadTodo() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/todo");
    const j = await r.json();
    const box = document.getElementById("todo-box");
    if (!box) return;
    const items = j?.items || [];
    if (!items.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    const done = items.filter((i) => i.done).length;
    document.getElementById("todo-progress").textContent = `（${done}/${items.length}）`;
    document.getElementById("todo-items").innerHTML = items.map((i, idx) => `
      <div style="display:flex;gap:6px;align-items:center;">
        <span>${i.done ? "✅" : "⬜"}</span>
        <span style="${i.done ? "text-decoration:line-through;color:#8a87a8" : "color:#e8e8ef"}">${esc(i.content)}</span>
      </div>`).join("");
  } catch { /* ignore */ }
}

