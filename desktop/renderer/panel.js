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
  if (name === "interview") loadIvWeakChips();
  if (name === "study") { loadStudyPlan(); loadFocus(); }
  if (name === "crawl") { loadCrawlData(); loadRss(); }
  if (name === "review") loadReview();
  if (name === "kb") { loadKbStats(); loadDocs(); loadDocsProject(); }
  if (name === "dashboard") loadDashboard();
  if (name === "jobs") loadSchedule();
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

// 链接安全：只允许 http/https/mailto（防 javascript: 协议注入）
function safeUrl(u) {
  return /^(https?:|mailto:)/i.test(String(u || "")) ? u : "#";
}

// ============ 简历文件解析（移植 ai-career：txt/md/json/docx/pdf） ============
const fileBtn = $("iv-file-btn");
const fileInput = $("iv-file");
const resumeStatus = $("resume-status");
const resumeText = $("iv-resume");

function ext(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

async function parseResumeFile(file) {
  const extension = ext(file.name);
  if (extension === ".pdf" || extension === ".docx") {
    // 主进程本地解析（pdfjs/mammoth Node 端；浏览器端 bare import + CDN worker 不可靠）
    const buffer = await file.arrayBuffer();
    const r = await window.kanban.parseResumeFile(file.name, buffer);
    if (!r?.ok) throw new Error(r?.error || "解析失败");
    return { text: r.text, msg: r.msg };
  }
  if (extension === ".doc") throw new Error("暂不支持旧版 .doc，请另存为 .docx");
  if (extension === ".txt" || extension === ".md" || extension === "") {
    return { text: (await file.text()).trim(), msg: "已读取文本简历" };
  }
  if (extension === ".json") {
    const raw = await file.text();
    return { text: JSON.stringify(JSON.parse(raw), null, 2), msg: "已读取 JSON 简历" };
  }
  throw new Error(`暂不支持 ${extension || "未知"} 格式，支持 .txt/.md/.json/.docx/.pdf`);
}

fileBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const r = await parseResumeFile(file);
    resumeText.value = r.text;
    resumeStatus.textContent = "✅ " + r.msg;
    resumeStatus.className = "resume-status";
  } catch (err) {
    resumeStatus.textContent = "⚠️ " + err.message;
    resumeStatus.className = "resume-status error";
  }
});

// ============ 简历项目 → 学习清单（拷打准备）+ 简历存档（画像+原文） ============
document.getElementById("resume-plan-btn")?.addEventListener("click", async () => {
  const resume = (resumeText.value || "").trim();
  if (!resume || resume.length < 40) {
    resumeStatus.textContent = "⚠️ 请先上传或粘贴简历（至少 40 字）";
    resumeStatus.className = "resume-status error";
    return;
  }
  const btn = document.getElementById("resume-plan-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 提取项目中…";
  try {
    // 1) 存档简历：画像（岗位匹配）+ 原文（后续复用/拷打）
    const profileRes = await fetch("http://127.0.0.1:8899/api/jobs/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume }),
    });
    const profileJ = await profileRes.json();
    // 2) 简历项目 → 学习清单
    const res = await fetch("http://127.0.0.1:8899/api/resume-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume }),
    });
    const j = await res.json();
    resumeStatus.textContent = profileJ.ok ? `📄 简历已存档（技能 ${(profileJ.skills || []).length} 个）· ${j.message || "完成"}` : j.message || "完成";
    resumeStatus.className = "resume-status";
    if (j.added > 0) {
      loadStudyPlan(); // 刷新学习清单
      switchTab("study"); // 跳到清单页
    }
  } catch (err) {
    resumeStatus.textContent = "⚠️ " + err.message;
    resumeStatus.className = "resume-status error";
  } finally {
    btn.disabled = false;
    btn.textContent = "🎯 生成拷打清单";
  }
});

// 拖拽上传
const uploadZone = $("resume-upload");
uploadZone.addEventListener("dragover", (e) => { e.preventDefault(); uploadZone.style.borderColor = "#8a5adc"; });
uploadZone.addEventListener("dragleave", () => { uploadZone.style.borderColor = ""; });
uploadZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  uploadZone.style.borderColor = "";
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    const r = await parseResumeFile(file);
    resumeText.value = r.text;
    resumeStatus.textContent = "✅ " + r.msg;
    resumeStatus.className = "resume-status";
  } catch (err) {
    resumeStatus.textContent = "⚠️ " + err.message;
    resumeStatus.className = "resume-status error";
  }
});

// ============ 模拟面试 ============
let ivSession = null; // { question, basis, dimension, criteria, boundary, round }
let ivTotalRounds = 9;      // 后端 start 返回（兜底 9）
let ivRound = 0;            // 当前轮
let ivRoundType = "";       // 当前轮类型（项目拷打/八股…）
let ivTimer = null;         // 本题计时器
let ivRoundStart = 0;       // 本题开始时间戳
let ivRoundSeconds = 0;     // 本题已用秒
let ivScoreSum = { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0 }; // 全场累计
let ivScoreCount = 0;       // 已评分轮数
const ivSetup = $("interview-setup");
const ivSessionEl = $("interview-session");

// 评分条渲染：五维 + 总分（0-100，颜色分级）
const DIM_LABELS = [["tech", "技术"], ["expr", "表达"], ["depth", "深度"], ["edge", "边界"], ["reflect", "复盘"]];
function scoreBarHtml(label, val, big = false) {
  const v = Math.max(0, Math.min(100, Number(val) || 0));
  const color = v >= 80 ? "linear-gradient(90deg,#3a8a5a,#2f7d4e)" : v >= 60 ? "linear-gradient(90deg,#8a5adc,#6d4fd8)" : "linear-gradient(90deg,#d98a3d,#c07020)";
  return `<div class="score-bar${big ? " big" : ""}">
    <span class="sb-label">${label}</span>
    <span class="sb-track"><i style="width:${v}%;background:${color}"></i></span>
    <span class="sb-val">${v}</span>
  </div>`;
}
function renderIvScores(scores, total) {
  const box = $("iv-scores");
  box.innerHTML = `<div class="iv-total">总分 <b>${Number(total) || 0}</b></div>` +
    DIM_LABELS.map(([k, l]) => scoreBarHtml(l, (scores || {})[k])).join("");
}

// 轮次进度点（总轮数圆点，当前轮高亮，已过轮打勾）
function renderIvProgress() {
  const el = $("iv-progress");
  if (!el) return;
  const dots = Array.from({ length: ivTotalRounds }, (_, i) => {
    const n = i + 1;
    if (n < ivRound) return `<span class="iv-dot done">✓</span>`;
    if (n === ivRound) return `<span class="iv-dot cur">${n}</span>`;
    return `<span class="iv-dot">${n}</span>`;
  }).join("");
  el.innerHTML = dots + `<span class="iv-progress-txt">${ivRound}/${ivTotalRounds}</span>`;
}

// 本题计时
function startIvTimer() {
  stopIvTimer();
  ivRoundStart = Date.now();
  ivRoundSeconds = 0;
  const tick = () => {
    ivRoundSeconds = Math.floor((Date.now() - ivRoundStart) / 1000);
    const m = String(Math.floor(ivRoundSeconds / 60)).padStart(2, "0");
    const s = String(ivRoundSeconds % 60).padStart(2, "0");
    const el = $("iv-timer");
    if (el) {
      el.textContent = `⏱ ${m}:${s}`;
      el.style.color = ivRoundSeconds > 180 ? "#c05050" : ivRoundSeconds > 90 ? "#b07020" : "";
    }
  };
  tick();
  ivTimer = setInterval(tick, 1000);
}
function stopIvTimer() { if (ivTimer) { clearInterval(ivTimer); ivTimer = null; } }

$("iv-start").addEventListener("click", () => {
  startIvSession({
    position: $("iv-position").value.trim() || "前端实习生",
    role: $("iv-role").value,
    focus: $("iv-focus").value.trim(),
    resume: $("iv-resume").value.trim(),
  });
});

// 启动面试会话（iv-start 按钮 + 复习检验共用）：成功即切到面试中形态
async function startIvSession(cfg) {
  $("iv-start").disabled = true;
  $("iv-start").textContent = "⏳ 面试官准备中...";
  try {
    const r = await window.kanban.invStart(cfg);
    if (r.error) { alert("启动失败: " + r.error); return; }
    ivSetup.classList.add("hidden");
    ivSessionEl.classList.remove("hidden");
    $("iv-log").innerHTML = "";
    $("iv-review").classList.add("hidden");
    $("iv-review").textContent = "";
    $("iv-summary").classList.add("hidden");
    $("iv-scores").innerHTML = "";
    $("iv-answer-area").style.display = "";
    ivTotalRounds = Number(r.totalRounds) || 9;
    ivScoreSum = { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0 };
    ivScoreCount = 0;
    clearIvRecordings(); // 新面试开始 → 清理上一场录音（本场录音从 0 开始）
    showQuestion(r);
  } finally {
    $("iv-start").disabled = false;
    $("iv-start").textContent = "🎤 开始模拟面试";
  }
}

const IV_MAX_CHAIN = 3; // 同一追问点最大深挖次数（与服务端 MAX_DEPTH 一致）

function showQuestion(r) {
  ivRound = Number(r.round) || 1;
  ivRoundType = r.roundType || (ivRound === 1 ? "开场与自我介绍" : "");
  $("iv-status").textContent = `面试中 · 第 ${ivRound} 轮`;
  // 追问链指示：同一追问点的第 N 次深挖
  const chain = Number(r.depth) || 0;
  const chainHtml = chain > 0
    ? ` <span class="iv-chain" title="同一追问点的第 ${chain} 次深挖（最多 ${IV_MAX_CHAIN} 次）">🔗 追问 ${chain}/${IV_MAX_CHAIN}</span>`
    : "";
  $("iv-round-type").innerHTML = `${ivRoundType ? `📍 本轮：${esc(ivRoundType)}` : ""}${chainHtml}`;
  $("iv-question").textContent = r.question || "请继续";
  // 薄弱点优先考察计划（开场轮展示一次）
  let weakPlan = "";
  if (ivRound === 1 && Array.isArray(r.weakQueue) && r.weakQueue.length) {
    weakPlan = `<div class="iv-weak-plan">🎯 本次优先考察薄弱点：${r.weakQueue.map((w) => `${esc(w.topic)}×${w.failCount}`).join("、")}（技术轮逐个击破）</div>`;
  }
  $("iv-meta").innerHTML = weakPlan + `
    <div>🎯 维度：${esc(r.dimension || "-")}</div>
    <div>📌 依据：${esc(r.basis || "-")}</div>
    <div>✅ 合格标准：${esc(r.criteria || "-")}</div>
    <div>🚧 边界：${esc(r.boundary || "-")}</div>`;
  $("iv-answer").value = "";
  $("iv-answer").focus();
  renderIvProgress();
  startIvTimer();
  addIvLog(`轮${ivRound}【${ivRoundType || "问答"}】问题：${(r.question || "").slice(0, 60)}`);
}

$("iv-send").addEventListener("click", submitAnswer);
$("iv-answer").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitAnswer();
});

async function submitAnswer() {
  const answer = $("iv-answer").value.trim();
  if (!answer) return;
  $("iv-send").disabled = true;
  $("iv-send").textContent = "评分中...";
  stopIvTimer();
  addIvLog(`我的回答（${ivRoundSeconds}s）：${answer.slice(0, 60)}`, { play: true });
  try {
    const r = await window.kanban.invAnswer(answer);
    if (r.error) { alert(r.error); return; }
    // 评分展示：条形图 + 全场累计
    if (r.scores) {
      renderIvScores(r.scores, r.total);
      ivScoreCount++;
      for (const k of ["tech", "expr", "depth", "edge", "reflect"]) {
        ivScoreSum[k] += Number(r.scores[k]) || 0;
      }
      ivScoreSum.total += Number(r.total) || 0;
    }
    if (r.comment) $("iv-scores").insertAdjacentHTML("beforeend", `<div class="iv-comment">💬 ${esc(r.comment)}</div>`);
    // 🎯 薄弱点队列命中（本轮问题来自已知薄弱点 → 已从队列移除）
    if (r.weakHit && r.weakTopic) {
      $("iv-scores").insertAdjacentHTML("beforeend", `<div class="iv-weak-hit">🎯 薄弱点命中：${esc(r.weakTopic)}（已击破，本场不再重复考察）</div>`);
    }
    if (r.finished) {
      $("iv-status").textContent = "面试结束，正在生成复盘...";
      $("iv-answer-area").style.display = "none";
      addIvLog("✅ 面试结束");
      const end = await window.kanban.invEnd();
      if (end?.ok && end.report) {
        renderIvSummary();
        $("iv-review").classList.remove("hidden");
        $("iv-review").textContent = end.report;
        addIvLog(end.hint || "");
        // 薄弱点覆盖统计（录音保留：复盘时可回听）
        if (end.weakTotal > 0) {
          addIvLog(`🎯 本场薄弱点覆盖：${end.weakCovered ?? 0}/${end.weakTotal}${end.weakCoveredTopics?.length ? "（" + end.weakCoveredTopics.join("、") + "）" : ""}`);
        }
      }
      return;
    }
    showQuestion(r);
  } finally {
    $("iv-send").disabled = false;
    $("iv-send").textContent = "提交回答";
  }
}

// 结束小结：全场均分 + 五维均分条（基于每轮累计）
function renderIvSummary() {
  const box = $("iv-summary");
  if (!box || !ivScoreCount) return;
  const n = ivScoreCount;
  const dims = DIM_LABELS.map(([k, l]) => [k, l, Math.round(ivScoreSum[k] / n)]);
  const avg = Math.round(ivScoreSum.total / n);
  const best = dims.slice().sort((a, b) => b[2] - a[2])[0];
  const worst = dims.slice().sort((a, b) => a[2] - b[2])[0];
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="iv-summary-head">🎓 本场小结 <span>共 ${n} 轮 · 均分 <b>${avg}</b></span></div>
    ${dims.map(([k, l, v]) => scoreBarHtml(l, v)).join("")}
    <div class="iv-summary-tip">💡 强项：${esc(best[1])}（${best[2]}）· 待提升：${esc(worst[1])}（${worst[2]}）——复盘报告下方有逐题点评</div>
    <div class="iv-radar-wrap"><canvas id="iv-radar" width="240" height="190"></canvas></div>`;
  drawIvRadar($("iv-radar"), dims);
}

// 五维雷达图（canvas）：tech/expr/depth/edge/reflect 均分可视化
function drawIvRadar(canvas, dims) {
  if (!canvas || !dims?.length) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) / 2 - 30;
  const n = dims.length;
  ctx.clearRect(0, 0, W, H);
  // 网格（4 环）
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      const rr = (R * ring) / 4;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(109,79,216,.15)"; ctx.lineWidth = 1; ctx.stroke();
  }
  // 轴线 + 维度标签
  ctx.font = "11px sans-serif"; ctx.fillStyle = "#6a6790"; ctx.textAlign = "center";
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
    ctx.strokeStyle = "rgba(109,79,216,.12)"; ctx.stroke();
    ctx.fillText(dims[i][1], cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16) + 3);
  }
  // 数据多边形
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    const rr = (R * Math.max(0, Math.min(100, dims[i][2]))) / 100;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(138,90,220,.28)"; ctx.fill();
  ctx.strokeStyle = "#6d4fd8"; ctx.lineWidth = 1.6; ctx.stroke();
  // 顶点数值
  ctx.fillStyle = "#5d48b8"; ctx.font = "bold 10px sans-serif";
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    const rr = (R * Math.max(0, Math.min(100, dims[i][2]))) / 100;
    ctx.fillText(dims[i][2], cx + Math.cos(a) * rr, cy + Math.sin(a) * rr - 5);
  }
}

$("iv-end").addEventListener("click", async () => {
  stopIvTimer();
  const end = await window.kanban.invEnd();
  if (end?.ok && end.report) {
    renderIvSummary();
    $("iv-review").classList.remove("hidden");
    $("iv-review").textContent = end.report;
    $("iv-status").textContent = "面试已结束";
    addIvLog(end.hint || "");
    if (end.weakTotal > 0) {
      addIvLog(`🎯 本场薄弱点覆盖：${end.weakCovered ?? 0}/${end.weakTotal}${end.weakCoveredTopics?.length ? "（" + end.weakCoveredTopics.join("、") + "）" : ""}`);
    }
  }
});

function addIvLog(text, opts = {}) {
  const log = $("iv-log");
  const div = document.createElement("div");
  div.textContent = text;
  // 录音回听：本轮有录音 → 附 ▶️ 回听按钮
  if (opts.play && ivRecordings[ivRound]) {
    const rec = ivRecordings[ivRound];
    const btn = document.createElement("button");
    btn.className = "iv-replay";
    btn.textContent = `▶️ 回听 ${fmtIvTime(rec.secs)}`;
    btn.title = "回听自己刚才的回答录音（说出来的才是真实表达）";
    btn.addEventListener("click", () => {
      try {
        const a = new Audio(rec.url);
        a.play().catch(() => window.kanban.notify("面试录音", "播放失败：浏览器不支持该录音格式"));
      } catch { /* ignore */ }
    });
    div.appendChild(btn);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function fmtIvTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ============ 面试录音（🎙️ 说答案 → whisper 转写回填 + 录音留存本场回听） ============
// 一路双采：MediaRecorder → webm（回听）；ScriptProcessor → 16k PCM（转写）
let ivMicStream = null, ivMicRec = null, ivMicCtx = null, ivMicSource = null, ivMicProc = null;
let ivMicChunks = [], ivMicPcm = [], ivMicRecording = false, ivMicAutoStop = null;
let ivMicTimer = null, ivMicSecs = 0;
const ivRecordings = {}; // 轮次 -> { url, secs }

function setIvMicState(st) {
  const btn = $("iv-mic");
  if (!btn) return;
  btn.classList.remove("recording", "transcribing");
  if (st === "rec") {
    btn.classList.add("recording");
    btn.textContent = "⏹ 00:00";
    btn.title = "点击停止：转写 + 保存录音";
  } else if (st === "transcribing") {
    btn.classList.add("transcribing");
    btn.textContent = "⏳";
    btn.disabled = true;
  } else {
    btn.textContent = "🎙️";
    btn.disabled = false;
    btn.title = "录音回答：说答案 → 自动转写回填输入框，录音留存本场可回听";
  }
}

function pickIvRecMime() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* ignore */ }
  }
  return "";
}

async function startIvMic() {
  try {
    ivMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (err) {
    window.kanban.notify("面试录音", "麦克风不可用: " + (err?.name || "请检查系统麦克风权限"));
    return;
  }
  ivMicChunks = []; ivMicPcm = []; ivMicSecs = 0;
  const mime = pickIvRecMime();
  ivMicRec = mime ? new MediaRecorder(ivMicStream, { mimeType: mime }) : new MediaRecorder(ivMicStream);
  ivMicRec.ondataavailable = (e) => { if (e.data?.size) ivMicChunks.push(e.data); };
  ivMicRec.onstop = () => {
    try {
      const blob = new Blob(ivMicChunks, { type: ivMicRec?.mimeType || "audio/webm" });
      ivRecordings[ivRound] = { url: URL.createObjectURL(blob), secs: ivMicSecs };
    } catch { /* ignore */ }
    ivMicChunks = [];
    transcribeIvPcm(); // 转写回填（录音已保存，转写失败不影响回听）
  };
  ivMicRec.start(250);
  // PCM 采集（whisper 16k 单声道）
  try {
    ivMicCtx = new AudioContext({ sampleRate: 16000 });
    ivMicSource = ivMicCtx.createMediaStreamSource(ivMicStream);
    ivMicProc = ivMicCtx.createScriptProcessor(4096, 1, 1);
    ivMicProc.onaudioprocess = (e) => {
      if (ivMicRecording) ivMicPcm.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    ivMicSource.connect(ivMicProc);
    ivMicProc.connect(ivMicCtx.destination);
  } catch { /* ignore */ }
  ivMicRecording = true;
  setIvMicState("rec");
  ivMicTimer = setInterval(() => {
    ivMicSecs++;
    const btn = $("iv-mic");
    if (btn) btn.textContent = "⏹ " + fmtIvTime(ivMicSecs);
  }, 1000);
  ivMicAutoStop = setTimeout(() => { if (ivMicRecording) stopIvMic(); }, 120000); // 2 分钟上限
}

async function stopIvMic() {
  ivMicRecording = false;
  clearTimeout(ivMicAutoStop);
  if (ivMicTimer) { clearInterval(ivMicTimer); ivMicTimer = null; }
  try { ivMicSource?.disconnect(); ivMicProc?.disconnect(); } catch { /* ignore */ }
  try { ivMicCtx?.close(); } catch { /* ignore */ }
  if (ivMicStream) { ivMicStream.getTracks().forEach((t) => t.stop()); ivMicStream = null; }
  if (ivMicRec && ivMicRec.state !== "inactive") {
    ivMicRec.stop(); // onstop → 保存录音 + 转写
  } else {
    setIvMicState("idle");
  }
}

async function transcribeIvPcm() {
  if (!ivMicPcm.length) { setIvMicState("idle"); return; }
  setIvMicState("transcribing");
  const total = ivMicPcm.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const c of ivMicPcm) { pcm.set(c, off); off += c.length; }
  ivMicPcm = [];
  try {
    const r = await window.kanban.speechToText(pcm);
    if (r?.ok && r.text) {
      const box = $("iv-answer");
      box.value = box.value.trim() ? box.value.trim() + "\n" + r.text : r.text;
      box.focus();
    } else {
      window.kanban.notify("面试录音", "转写失败（录音已保存可回听）: " + (r?.error || ""));
    }
  } catch (err) {
    window.kanban.notify("面试录音", "转写异常: " + String(err?.message || err).slice(0, 80));
  } finally {
    setIvMicState("idle");
  }
}

$("iv-mic").addEventListener("click", () => { ivMicRecording ? stopIvMic() : startIvMic(); });

function clearIvRecordings() {
  for (const k of Object.keys(ivRecordings)) {
    try { URL.revokeObjectURL(ivRecordings[k].url); } catch { /* ignore */ }
    delete ivRecordings[k];
  }
  if (ivMicRecording) stopIvMic();
}

// 🎯 已知薄弱点 chips（面试设置页）：点击填入重点方向 → 面试优先考察
// 数据源与面试薄弱点队列一致（memory 可信薄弱点：topic + 答错次数）
async function loadIvWeakChips() {
  const row = $("iv-weak-row"), chips = $("iv-weak-chips");
  if (!row || !chips) return;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/weak-points");
    const j = await r.json();
    const weak = (j.weak || []).slice(0, 6);
    if (!weak.length) { row.classList.add("hidden"); chips.innerHTML = ""; return; }
    row.classList.remove("hidden");
    chips.innerHTML = weak.map((w) => `
      <button class="job-chip iv-weak-chip" data-topic="${esc(w.topic)}" title="答错 ${w.failCount ?? 1} 次（${esc(w.source || "模拟面试")}），面试将优先考察">
        ${esc(w.topic)} <i>×${w.failCount ?? 1}</i></button>`).join("");
    chips.querySelectorAll(".iv-weak-chip").forEach((b) => {
      b.addEventListener("click", () => {
        const f = $("iv-focus");
        const t = b.dataset.topic;
        const parts = f.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
        if (!parts.includes(t)) parts.push(t);
        f.value = parts.join("、");
        b.classList.add("picked");
        window.kanban.notify("🎯 薄弱点", `已加入重点方向：${t}`);
      });
    });
  } catch { /* ignore */ }
}

// ============ 复习（FSRS 间隔重复） ============
let reviewQueue = [];
let reviewIdx = 0;

async function loadReview() {
  const r = await window.kanban.reviewDue();
  if (!r?.ok) return;
  renderReviewStats(r.stats || {});
  renderReviewTrend(r.trend || { trend: [], streak: 0 });
  renderReviewTestBtn(r.todayReviewed || []);
  loadWrongBook();
  reviewQueue = r.due || [];
  reviewIdx = 0;
  if (reviewQueue.length) {
    $("review-empty").classList.add("hidden");
    showReviewCard();
  } else {
    $("review-card").classList.add("hidden");
    $("review-empty").classList.remove("hidden");
    const streak = r.trend?.streak || 0;
    $("review-empty").textContent = streak > 1
      ? `🎉 今日复习完成！已连续复习 ${streak} 天，保持节奏`
      : "🎉 今日没有到期的复习卡片";
  }
  renderReviewBatch(reviewQueue);
  loadMastery(); // 掌握度区块（弱项优先，默认收起）
}

// 今日复习批次分布（艾宾浩斯节奏：首次/第2次/3次+，直观看到复习结构）
function renderReviewBatch(queue) {
  const box = $("review-batch");
  if (!box) return;
  if (!queue.length) { box.innerHTML = ""; return; }
  const first = queue.filter((c) => !(c.history?.length)).length;
  const r2 = queue.filter((c) => c.history?.length === 1).length;
  const r3p = queue.length - first - r2;
  const chip = (label, n, color) => `<span class="job-badge" style="background:${color};color:#fff;">${label} ${n}</span>`;
  box.innerHTML = `今日 ${queue.length} 张：${chip("🆕 首次", first, "rgba(80,160,255,.75)")} ${chip("🔁 第2次", r2, "rgba(138,90,220,.75)")} ${chip("🔁 3次+", r3p, "rgba(109,79,216,.55)")} <span style="font-size:10px;color:#8a87a8;">· 预计 ${Math.max(1, Math.round(queue.length / 2))} 分钟</span>`;
}

// 复习统计渲染：总卡/到期/今日完成/学习/掌握 + 今日进度条（今日完成 / 今日到期）
function renderReviewStats(stats) {
  const due = stats.due || 0;
  const todayDone = stats.todayDone || 0;
  const pct = due ? Math.min(100, Math.round(todayDone / due * 100)) : 0;
  $("review-stats").innerHTML = `
    <div class="stat-chip">总卡片 <b>${stats.total || 0}</b></div>
    <div class="stat-chip">今日到期 <b>${due}</b></div>
    <div class="stat-chip" style="background:rgba(80,220,120,.12);color:#2e9e5b;">今日完成 <b>${todayDone}</b></div>
    <div class="stat-chip">学习中 <b>${stats.learning || 0}</b></div>
    <div class="stat-chip">已掌握 <b>${stats.mastered || 0}</b></div>
    ${due ? `<div class="mini-progress" style="width:100%;margin:6px 0 0;">
      <span class="track"><i style="width:${pct}%"></i></span>
      <b>${todayDone}/${due}</b></div>` : ""}`;
}

// 7 天复习趋势柱状图 + 连续天数（复用专注周图风格）
function renderReviewTrend({ trend = [], streak = 0 }) {
  const box = $("review-trend");
  if (!box) return;
  if (!trend.length) { box.innerHTML = ""; return; }
  const max = Math.max(...trend.map((d) => d.count), 1);
  const todayStr = new Date().toISOString().slice(0, 10);
  const dayLabel = (d) => {
    const n = new Date(d.date + "T00:00:00").getDay();
    return ["日", "一", "二", "三", "四", "五", "六"][n] || d.date.slice(5);
  };
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span style="font-size:11px;color:#6a6790;font-weight:600;">🔥 连续复习 <b style="color:#8a5adc;">${streak}</b> 天</span>
      <span style="font-size:11px;color:#8a87a8;">近 7 天复习量：</span>
      ${trend.map((d) => {
        const h = Math.max(3, Math.round((d.count / max) * 30));
        const isToday = d.date === todayStr;
        return `<span title="${d.date} · 复习 ${d.count} 张" style="display:inline-block;margin:0 3px;text-align:center;">
          <span style="display:block;font-size:9px;color:${d.count ? "#8a87a8" : "#c4c1d8"};">${d.count || ""}</span>
          <span style="display:block;width:16px;height:${h}px;background:${d.count ? "linear-gradient(180deg,#8a5adc,#5a3d9e)" : "rgba(109,79,216,.1)"};border-radius:3px;${isToday ? "outline:1.5px solid #8a5adc;outline-offset:1px;" : ""}"></span>
          <span style="font-size:9px;color:${isToday ? "#8a5adc" : "#8a87a8"};font-weight:${isToday ? "700" : "400"};">${dayLabel(d)}</span>
        </span>`;
      }).join("")}
    </div>`;
}

// 评分后单独刷新统计（不打断当前队列）
async function refreshReviewStats() {
  try {
    const r = await window.kanban.reviewDue();
    if (r?.ok) renderReviewStats(r.stats || {});
  } catch { /* ignore */ }
}

// 相对时间："x 分钟后 / x 小时后 / x 天后"
function relDue(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "现在";
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min} 分钟后`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时后`;
  return `${Math.round(h / 24)} 天后`;
}

// ============ 掌握度（知识点 23 项，弱项优先） ============
async function loadMastery() {
  const r = await window.kanban.getMastery();
  if (!r?.ok || !r.mastery) return;
  const mastery = r.mastery || [];
  const weak = r.weak || mastery.filter((k) => k.score < 50).slice(0, 5);
  const weakCount = r.stats?.weakCount ?? mastery.filter((k) => k.score < 50).length;
  const weakSpan = $("mastery-weak-count");
  if (weakSpan) weakSpan.textContent = weakCount;
  const weakBox = $("mastery-weak");
  if (weakBox) {
    weakBox.innerHTML = weak.length
      ? `<h4 class="mastery-sub">🔥 弱项优先（${weakCount} 个）</h4>` + weak.map(masteryBar).join("")
      : `<div class="mastery-none">🎉 暂无弱项，继续保持</div>`;
  }
  const allBox = $("mastery-all");
  if (allBox) {
    allBox.innerHTML = `<h4 class="mastery-sub">🗺️ 全部知识点（${mastery.length} 项）</h4>` + mastery.map(masteryBar).join("");
  }
}

// 单个知识点条形：颜色按 score（<50 红 / 50-70 黄 / >=70 绿），宽度按 score%
function masteryBar(k) {
  const score = Math.max(0, Math.min(100, Number(k.score) || 0));
  const color = score < 50 ? "#d9534f" : score < 70 ? "#e0a800" : "#3a8d5a";
  return `<div class="mastery-item" title="${esc(k.id)}">
    <span class="mastery-name">${esc(k.title)}</span>
    <span class="mastery-bar"><i style="width:${score}%;background:${color}"></i></span>
    <span class="mastery-score" style="color:${color}">${score}</span>
  </div>`;
}

$("mastery-toggle").addEventListener("click", () => {
  const body = $("mastery-body");
  const hidden = body.classList.toggle("hidden");
  const toggle = $("mastery-toggle");
  const count = $("mastery-weak-count")?.textContent || "-";
  toggle.textContent = `📊 掌握度（${count} 弱项）${hidden ? "▸" : "▾"}`;
  if (!hidden) loadMastery(); // 展开时刷新数据
});

function showReviewCard() {
  const card = reviewQueue[reviewIdx];
  if (!card) { loadReview(); return; }
  // 会话进度：第 x/N 张 + 进度条
  const total = reviewQueue.length;
  const done = reviewIdx;
  const pct = total ? Math.round(done / total * 100) : 0;
  $("rc-progress").textContent = `第 ${done + 1}/${total} 张`;
  $("rc-progress-bar").style.width = pct + "%";
  $("rc-progress-pct").textContent = pct + "%";
  $("rc-topic").textContent = "🔁 " + card.topic;
  $("rc-question").textContent = card.question || card.topic;
  $("rc-answer").textContent = card.answer || "";
  $("rc-answer").classList.add("hidden");
  $("rc-show").classList.remove("hidden");
  $("rc-buttons").classList.add("hidden");
  $("rc-feedback").classList.add("hidden");
  $("rc-explain")?.classList.add("hidden"); // 新卡不显示讲解按钮（答错后才出现）
  loadCardQuiz(card.id); // 🧠 复习自测选择题（懒生成，异步加载）
  // 来源 + 复习次数 + 下次到期（FSRS 反馈）
  const src = card.source || "";
  const times = card.history?.length || 0;
  const dueIn = card.fsrs?.due ? relDue(card.fsrs.due) : "";
  const srcTag = document.getElementById("rc-src");
  if (srcTag) {
    srcTag.textContent = `${src ? "来源：" + src + " · " : ""}已复习 ${times} 次${dueIn ? " · 下次到期：" + dueIn : ""}`;
    srcTag.style.display = "block";
  }
  // 记忆方法可视化：复习阶段徽章 + 记忆强度条（FSRS 遗忘曲线估算）
  const memEl = $("rc-memory");
  if (memEl) {
    const stage = card.stage || { label: "🆕 首次复习" };
    const memPct = card.memPct;
    if (memPct === null || memPct === undefined) {
      memEl.innerHTML = `<span class="rc-stage-badge">${esc(stage.label)}</span>
        <span style="font-size:11px;color:#8a87a8;">首次复习，学完记住它</span>`;
    } else {
      const color = memPct >= 80 ? "linear-gradient(90deg,#3a8a5a,#2f7d4e)" : memPct >= 60 ? "linear-gradient(90deg,#8a5adc,#6d4fd8)" : "linear-gradient(90deg,#d98a3d,#c07020)";
      memEl.innerHTML = `<span class="rc-stage-badge">${esc(stage.label)}</span>
        <span class="rc-mem-track"><i style="width:${memPct}%;background:${color}"></i></span>
        <b class="rc-mem-pct" style="color:${memPct >= 80 ? "#2e9e5b" : memPct >= 60 ? "#5d48b8" : "#c07a20"};">${memPct}%</b>
        <span style="font-size:10px;color:#8a87a8;">记忆强度</span>`;
    }
  }
}

// 评分反馈：显示 FSRS 下次复习时间 + 间隔（记忆方法反馈）
function showReviewFeedback(rating, nextDue, nextCard) {
  const fb = $("rc-feedback");
  if (!fb) return;
  const label = ["😵 忘了", "😕 困难", "🙂 记得", "😄 简单"][rating] || "";
  const color = rating >= 2 ? "#3a8d5a" : "#c05050";
  const schedDays = nextCard?.fsrs?.scheduled_days;
  fb.innerHTML = `<span style="color:${color};font-weight:600;">${label}</span> · 间隔 <b>${schedDays || 1}</b> 天 · 下次复习：<b>${nextDue ? relDue(nextDue) : "—"}</b>`;
  fb.classList.remove("hidden");
}

$("rc-show").addEventListener("click", () => {
  $("rc-answer").classList.remove("hidden");
  $("rc-show").classList.add("hidden");
  $("rc-buttons").classList.remove("hidden");
});

document.querySelectorAll(".rc-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const card = reviewQueue[reviewIdx];
    const rating = parseInt(btn.dataset.rating, 10);
    const r = await window.kanban.reviewSubmit(card.id, rating);
    // FSRS 反馈：下次复习时间 + 间隔
    if (r?.nextDue) showReviewFeedback(rating, r.nextDue, r.card);
    // 答错（忘了/困难）→ 显示「让真白讲一遍」（复习即学闭环）+ 后台换一批选择题
    const explainBtn = $("rc-explain");
    if (explainBtn) {
      if (rating < 2) {
        explainBtn.classList.remove("hidden");
        explainBtn.dataset.cardId = card.id;
        explainBtn.dataset.topic = card.topic;
        quizSwapBatch(card.id); // 换批：下次复习该卡抽新题
      } else {
        explainBtn.classList.add("hidden");
      }
    }
    // 真白情感反馈：显示中文，语音播日语预设场景台词（emotionScene）
    if (r?.emotion) {
      window.kanban.notify("🎀 真白", r.emotion);
      if (voiceOn) {
        if (r.emotionScene) window.kanban.playScene(r.emotionScene);
        else window.kanban.speak(r.emotion);
      }
    }
    reviewIdx++;
    if (reviewIdx < reviewQueue.length) showReviewCard();
    else loadReview(); // 复习完一轮刷新
    refreshReviewStats(); // 今日进度实时更新
  });
});

// ============ 复习自测：选择题快速回忆（题库化：懒生成 6 题 → 每次随机抽 3 + 选项洗牌；答错自动换批） ============
let quizState = null; // { questions, chosen: {qi: oi} }

async function loadCardQuiz(cardId) {
  const box = $("rc-quiz");
  if (!box) return;
  quizState = null;
  box.classList.remove("hidden");
  box.innerHTML = '<div class="quiz-loading">🧠 复习自测加载中…</div>';
  try {
    let r = await fetch(`http://127.0.0.1:8899/api/review/quiz?id=${encodeURIComponent(cardId)}`).then((x) => x.json());
    if (!r.questions?.length) {
      // 题库空 → 懒生成（首次约 10-20s；失败/无 LLM 降级为纯文本卡，不阻塞复习）
      box.innerHTML = '<div class="quiz-loading">🧠 生成自测题中（首次约 10-20s，可先点「显示答案」）…</div>';
      const g = await fetch("http://127.0.0.1:8899/api/review/quiz/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardId }),
      }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (g.ok && g.total > 0) {
        r = await fetch(`http://127.0.0.1:8899/api/review/quiz?id=${encodeURIComponent(cardId)}`).then((x) => x.json());
      } else {
        box.classList.add("hidden");
        return;
      }
    }
    if (!r.questions?.length) { box.classList.add("hidden"); return; }
    renderQuiz(r.questions);
  } catch { /* 降级：隐藏选择题区 */ box.classList.add("hidden"); }
}

function renderQuiz(questions) {
  quizState = { questions, chosen: {} };
  const box = $("rc-quiz");
  box.innerHTML = `<div class="quiz-head">🧠 复习自测 · 快速回忆（答完再评分）</div>` +
    questions.map((q, qi) => `
    <div class="quiz-q" data-qi="${qi}">
      <div class="quiz-question">${qi + 1}. ${esc(q.question)}</div>
      <div class="quiz-options">
        ${q.options.map((o, oi) => `<button class="quiz-opt" data-qi="${qi}" data-oi="${oi}">${String.fromCharCode(65 + oi)}. ${esc(o)}</button>`).join("")}
      </div>
      <div class="quiz-fb hidden" data-fb="${qi}"></div>
    </div>`).join("") +
    `<div class="quiz-foot">
      <button id="quiz-submit" class="secondary">✅ 提交自测</button>
      <span id="quiz-summary" class="quiz-summary"></span>
    </div>`;
  box.querySelectorAll(".quiz-opt").forEach((b) => {
    b.addEventListener("click", () => {
      const qi = Number(b.dataset.qi), oi = Number(b.dataset.oi);
      quizState.chosen[qi] = oi;
      box.querySelectorAll(`.quiz-opt[data-qi="${qi}"]`).forEach((x) => x.classList.remove("picked"));
      b.classList.add("picked");
    });
  });
  $("quiz-submit").addEventListener("click", submitQuizAnswers);
}

async function submitQuizAnswers() {
  const card = reviewQueue[reviewIdx];
  if (!card || !quizState?.questions?.length) return;
  const btn = $("quiz-submit");
  btn.disabled = true;
  btn.textContent = "判分中…";
  const answers = quizState.questions.map((q, qi) => ({ questionId: q.id, chosen: quizState.chosen[qi] ?? -1 }));
  try {
    const r = await fetch("http://127.0.0.1:8899/api/review/quiz/submit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: card.id, answers }),
    }).then((x) => x.json());
    const byQ = {};
    for (const res of r.results || []) byQ[res.questionId] = res;
    // 逐题对错 + 解析
    quizState.questions.forEach((q, qi) => {
      const res = byQ[q.id];
      const fb = $("rc-quiz").querySelector(`.quiz-fb[data-fb="${qi}"]`);
      if (!fb || !res) return;
      fb.classList.remove("hidden");
      fb.innerHTML = res.correct
        ? `<span class="quiz-right">✅ 正确</span> <span class="quiz-explain">${esc(res.explain)}</span>`
        : `<span class="quiz-wrong">❌ 选错了</span> <span class="quiz-explain">${esc(res.explain)}</span>`;
      // 高亮正确项
      const opts = $("rc-quiz").querySelectorAll(`.quiz-opt[data-qi="${qi}"]`);
      opts.forEach((o, oi) => {
        if (oi === res.rightIndex) o.classList.add("right");
        else if (Number(o.dataset.oi) === (quizState.chosen[qi] ?? -1)) o.classList.add("wrong");
      });
    });
    const summary = $("quiz-summary");
    if (r.total > 0 && r.correct === r.total) {
      summary.innerHTML = `✅ 全对 ${r.correct}/${r.total}——可以放心评分（记得/简单）`;
      summary.className = "quiz-summary good";
    } else if (r.total > 0) {
      summary.innerHTML = `❌ 对 ${r.correct}/${r.total}——记忆不牢，建议按「忘了/困难」评分，评分后自动换一批新题`;
      summary.className = "quiz-summary bad";
    }
    btn.classList.add("hidden");
  } catch (e) {
    const summary = $("quiz-summary");
    if (summary) { summary.textContent = "⚠️ 判分失败：" + String(e.message || e).slice(0, 60); }
  } finally {
    btn.disabled = false;
    btn.textContent = "✅ 提交自测";
  }
}

// 评分后：答错（0/1）→ 后台换批（下次复习抽新题）
function quizSwapBatch(cardId) {
  try {
    fetch("http://127.0.0.1:8899/api/review/quiz/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardId }),
    }).catch(() => { /* 换批失败不影响复习 */ });
  } catch { /* ignore */ }
}

// ============ 复习即学：答错 → 让真白讲一遍（SSE 流式，结合知识库） ============
$("rc-explain")?.addEventListener("click", () => {
  const btn = $("rc-explain");
  openReviewExplain(btn.dataset.cardId, btn.dataset.topic);
});

async function openReviewExplain(cardId, topic) {
  const overlay = $("review-explain-overlay");
  const body = $("rex-body");
  const planBtn = $("rex-plan-btn");
  const status = $("rex-status");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  $("rex-title").textContent = `🤔 让真白讲一遍：${topic || ""}`;
  body.textContent = "真白正在翻知识库 + 组织讲解…";
  planBtn.classList.add("hidden");
  planBtn.dataset.topic = topic || "";
  status.textContent = "生成中（首次约 20-60s）…";
  try {
    const res = await fetch(`http://127.0.0.1:8899/api/review/explain-stream?id=${encodeURIComponent(cardId || "")}`);
    if (!res.ok || !res.body) throw new Error("讲解流启动失败");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of evt.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.type === "delta") {
              full += j.delta;
              body.textContent = full;
              body.scrollTop = body.scrollHeight;
            } else if (j.type === "done") {
              status.textContent = "✅ 已生成（讲解已存入复习卡答案，下次复习可对照）";
              planBtn.classList.remove("hidden");
            } else if (j.type === "error") {
              status.textContent = "⚠️ " + (j.error || "生成失败");
              if (!full) body.textContent = "讲解生成失败：" + (j.error || "未知错误");
            }
          } catch { /* ignore */ }
        }
      }
    }
  } catch (e) {
    status.textContent = "⚠️ 失败";
    body.textContent = "讲解生成失败：" + String(e.message || e).slice(0, 120);
  }
}

$("rex-close")?.addEventListener("click", () => {
  $("review-explain-overlay")?.classList.add("hidden");
});
$("review-explain-overlay")?.addEventListener("click", (e) => {
  if (e.target === $("review-explain-overlay")) $("review-explain-overlay").classList.add("hidden");
});

// 讲解完 → 一键加入学习清单（复用面试实录接口：加清单 + 建复习卡）
$("rex-plan-btn")?.addEventListener("click", async () => {
  const topic = $("rex-plan-btn").dataset.topic;
  if (!topic) return;
  try {
    const r = await window.kanban.interviewNotes(topic);
    window.kanban.notify("📌 学习清单", r?.hint || (r?.ok ? "已加入" : "加入失败"));
    $("rex-plan-btn").disabled = true;
    $("rex-plan-btn").textContent = "✅ 已加入清单";
  } catch (e) {
    window.kanban.notify("📌 学习清单", "加入失败：" + String(e.message || e).slice(0, 60));
  }
});

// ============ 复习完 → 面试检验（用今天复习过的主题出题） ============
function renderReviewTestBtn(todayReviewed) {
  const btn = $("review-test-btn");
  if (!btn) return;
  const list = todayReviewed || [];
  if (!list.length) { btn.classList.add("hidden"); return; }
  btn.classList.remove("hidden");
  btn.textContent = `🎤 面试检验今日复习（刚复习 ${list.length} 个主题：${list.slice(0, 3).map((t) => t.topic).join("、")}${list.length > 3 ? "…" : ""}）`;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "⏳ 面试官准备中…";
    try {
      // 把今天复习的主题作为重点方向（复习 → 面试检验闭环）
      $("iv-focus").value = list.map((t) => t.topic).join("、");
      switchTab("interview");
      await startIvSession({
        position: $("iv-position").value.trim() || "前端实习生",
        role: "技术深挖型",
        focus: $("iv-focus").value.trim(),
        resume: $("iv-resume").value.trim(),
      });
    } finally {
      btn.disabled = false;
    }
  };
}

// ============ 错题本（答错 >=2 次，点击直接复习 / 讲解） ============
async function loadWrongBook() {
  const countEl = $("wrong-book-count");
  const listEl = $("wrong-book-list");
  if (!countEl || !listEl) return;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/review/wrong");
    const j = await r.json();
    const wrong = j.wrong || [];
    countEl.textContent = wrong.length;
    if (!wrong.length) {
      listEl.innerHTML = '<div style="font-size:11px;color:#8a87a8;">暂无错题（答错 ≥2 次才进错题本）</div>';
      return;
    }
    listEl.innerHTML = wrong.map((w) => `
      <div class="wrong-item" data-id="${esc(w.id)}" data-topic="${esc(w.topic)}">
        <div class="wrong-head">
          <b>${esc(w.topic)}</b>
          <span class="job-badge" style="background:rgba(220,90,60,.15);color:#c05030;">错 ${w.wrongCount} 次</span>
        </div>
        <div class="job-meta">${esc(w.question || "请完整回答并讲清原理").slice(0, 60)}${w.lastWrongAt ? ` · 上次错 ${new Date(w.lastWrongAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric" })}` : ""}</div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <button class="job-btn wrong-review" style="padding:2px 10px;">📖 现在复习</button>
          <button class="job-btn wrong-explain" style="padding:2px 10px;">🤔 让真白讲</button>
        </div>
      </div>`).join("");
    listEl.querySelectorAll(".wrong-review").forEach((b) => {
      b.addEventListener("click", () => {
        const item = b.closest(".wrong-item");
        const card = reviewQueue.find((c) => c.id === item.dataset.id);
        if (card) {
          // 已在队列 → 跳到它
          reviewIdx = reviewQueue.indexOf(card);
        } else {
          // 不在队列 → 插到最前立即复习
          reviewQueue.unshift({ ...cardStub(item.dataset.id, item.dataset.topic) });
          reviewIdx = 0;
        }
        $("review-empty").classList.add("hidden");
        $("review-card").classList.remove("hidden");
        showReviewCard();
      });
    });
    listEl.querySelectorAll(".wrong-explain").forEach((b) => {
      b.addEventListener("click", () => {
        const item = b.closest(".wrong-item");
        openReviewExplain(item.dataset.id, item.dataset.topic);
      });
    });
  } catch { /* ignore */ }
}

// 错题本点击复习时的兜底卡对象（topic/question 用题目，fsrs 空状态）
function cardStub(id, topic) {
  return {
    id, topic,
    question: `请完整回答并讲清原理：${topic}`,
    answer: "", source: "错题本", fsrs: { due: new Date().toISOString() },
    history: [], stage: { label: "🔁 重学" }, memPct: null,
  };
}

$("wrong-book-toggle")?.addEventListener("click", () => {
  const body = $("wrong-book-body");
  const hidden = body.classList.toggle("hidden");
  $("wrong-book-toggle").textContent = `📕 错题本（${$("wrong-book-count")?.textContent || "-"} 道）${hidden ? "▸" : "▾"}`;
  if (!hidden) loadWrongBook(); // 展开时刷新
});

// 键盘快捷键：1-4 快速评分（仅当评分按钮可见时生效；Ctrl/Cmd 不干扰）
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement?.tagName || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const btns = $("rc-buttons");
  if (!btns || btns.classList.contains("hidden")) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 4) {
    const btn = btns.querySelector(`.rc-btn[data-rating="${n - 1}"]`);
    if (btn) btn.click();
  }
});
async function loadStudyPlan() {
  const r = await window.kanban.studyPlan();
  if (!r?.ok) return;
  const items = r.plan?.items || [];
  const list = $("study-list");
  const doneToggle = $("study-done-toggle");
  const doneList = $("study-done-list");
  // 前端筛选：搜索词 + 级别 + 状态（作用于全部条目）
  const q = String(studySearchQuery || "").trim().toLowerCase();
  const lv = studyLvFilter;
  const st = studyStateFilter;
  const stateOf = (it) => {
    if (it.reviewDue) return "review";           // 复习卡到期 → 待复习（闭环最优先）
    if (it.done) return "mastered";              // 完成且卡未到期 → 已掌握
    if (it.hasFile) return "learning";           // 打开过讲解 → 学习中
    return "todo";                               // 未开始 → 待学习
  };
  const pass = (it) => {
    if (lv && it.level !== lv) return false;
    if (st && stateOf(it) !== st) return false;
    if (q && !String(it.topic + " " + (it.why || "")).toLowerCase().includes(q)) return false;
    return true;
  };
  const filtered = items.filter(pass);
  if (!items.length) {
    list.innerHTML = '<div style="color:#7c7c7c;font-size:12px">未生成，点「✨ 从产出生成清单」</div>';
    const pw0 = $("study-progress-wrap");
    if (pw0) pw0.style.display = "none";
    doneToggle.style.display = "none";
    doneList.style.display = "none";
    return;
  }
  // 完成进度条（总进度，不受筛选影响）
  const pw = $("study-progress-wrap");
  if (pw) {
    const total = items.length;
    const doneN = items.filter((i) => i.done).length;
    const pct = total ? Math.round(doneN / total * 100) : 0;
    pw.style.display = "";
    pw.innerHTML = `<span style="font-size:11px;color:#6a6790;">📋 学习进度</span>
      <span class="track"><i style="width:${pct}%"></i></span>
      <b>${doneN}/${total}（${pct}%）</b>`;
  }
  // 状态流分组（产品语义：待学 → 学习中 → 待复习 → 已掌握）
  const groups = { todo: [], learning: [], review: [], mastered: [] };
  for (const it of filtered) groups[stateOf(it)].push(it);
  const masteredN = groups.mastered.length;
  list.innerHTML = renderStateGroups([
    { key: "todo", label: "📥 待学习", items: groups.todo },
    { key: "learning", label: "📖 学习中", items: groups.learning },
    { key: "review", label: "🔁 待复习（复习卡到期）", items: groups.review, cls: "lv-adv" },
  ]);
  if (!filtered.length && (q || lv || st)) {
    list.innerHTML = `<div style="color:#8a87a8;font-size:12px">没有匹配「${esc(q || lv || st)}」的条目</div>`;
  }
  // 已掌握折叠区（完成且无到期复习卡）
  doneToggle.style.display = masteredN ? "" : "none";
  if (masteredN) doneToggle.textContent = `📜 已掌握条目（${masteredN}，点击${doneList.style.display === "none" ? "展开" : "收起"}）`;
  if (doneList.style.display !== "none") {
    doneList.innerHTML = renderStateGroups([{ key: "mastered", label: "✅ 已掌握", items: groups.mastered }]);
    bindPlanItems(doneList, true);
  }
}

// 状态流分组渲染：一级状态组（待学/学习中/待复习/已掌握），组内按主题簇子分组
function renderStateGroups(groups) {
  return groups.map((g) => {
    if (!g.items.length) return "";
    return `
      <div class="study-state-group" data-state="${g.key}">
        <div class="study-state-head ${g.cls || ""}">${g.label} <span class="sg-count">${g.items.length}</span></div>
        ${renderGrpBody(g.items)}
      </div>`;
  }).join("");
}

// 组内按主题簇 grp 子分组（未分类置最后），组头可折叠
function renderGrpBody(items) {
  const byGrp = new Map();
  for (const it of items) {
    const g = String(it.grp || "").trim() || "未分类";
    if (!byGrp.has(g)) byGrp.set(g, []);
    byGrp.get(g).push(it);
  }
  if (byGrp.size > 1 && byGrp.has("未分类")) {
    const uncat = byGrp.get("未分类");
    byGrp.delete("未分类");
    byGrp.set("未分类", uncat);
  }
  return [...byGrp].map(([g, its]) => `
      <div class="study-group" data-grp="${esc(g)}">
        <div class="study-group-head" data-grp="${esc(g)}">📁 ${esc(g)}（${its.length}）</div>
        <div class="study-group-body">${its.map(renderPlanItemHtml).join("")}</div>
      </div>`).join("");
}

// 学习清单筛选状态（搜索框/级别/状态 chips 驱动）
let studySearchQuery = "";
let studyLvFilter = "";
let studyStateFilter = "";
$("study-search")?.addEventListener("input", (e) => { studySearchQuery = e.target.value; loadStudyPlan(); });
document.querySelectorAll(".study-lv-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    studyLvFilter = btn.dataset.lv;
    document.querySelectorAll(".study-lv-chip").forEach((b) => b.classList.toggle("active", b === btn));
    loadStudyPlan();
  });
});
document.querySelectorAll(".study-state-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    studyStateFilter = btn.dataset.st;
    document.querySelectorAll(".study-state-chip").forEach((b) => b.classList.toggle("active", b === btn));
    loadStudyPlan();
  });
});

// 单条清单条目渲染（状态流分组内使用；来源徽章 + 级别徽章 + 复习状态）
function renderPlanItemHtml(it) {
  const lvCls = { "必会": "lv-must", "进阶": "lv-adv", "拓展": "lv-ext" };
  const srcBadge = (() => {
    if (it.fromInterview) return '<span class="s-src">面试</span>';
    const s = String(it.source || "");
    if (s.includes("真题")) return '<span class="s-src">真题</span>';
    if (s.includes("简历") || s.includes("拷打")) return '<span class="s-src">简历</span>';
    if (s.includes("复习卡")) return '<span class="s-src">复习</span>';
    if (s.includes("产出")) return '<span class="s-src">产出</span>';
    return s ? `<span class="s-src" title="${esc(s)}">${esc(s.slice(0, 5))}</span>` : "";
  })();
  return `
    <div class="study-item ${it.done ? "done" : ""}" data-id="${it.id}">
      <input type="checkbox" ${it.done ? "checked" : ""} />
      <div style="flex:1">
        <div class="s-topic">${esc(it.topic)} ${it.level ? `<span class="s-lv ${lvCls[it.level] || "lv-must"}">${esc(it.level)}</span>` : ""} ${srcBadge}${it.reviewDue ? '<span class="s-src" style="background:rgba(220,150,60,.2);color:#b07020;">🔁 复习到期</span>' : ""}</div>
        <div class="s-why">${esc(it.why || "")}</div>
      </div>
      <button class="s-learn" data-id="${it.id}">${it.hasFile ? "📖 学习" : "💡 讲解"}</button>
      <span class="s-badge ${it.reviewed ? "reviewed" : ""}">${it.reviewed ? "已复盘" : "待学"}</span>
    </div>`;
}

function bindPlanItems(root, isDone) {
  root.querySelectorAll(".study-item").forEach((el) => {
    const cb = el.querySelector("input");
    cb.addEventListener("change", async (e) => {
      // 归并模式：勾选用于归并选择（不改变完成状态）
      if (clusterMode) {
        el.classList.toggle("cluster-selected", e.target.checked);
        updateClusterBtn();
        return;
      }
      const r = await window.kanban.studyCheck(el.dataset.id, e.target.checked);
      // 勾选/取消后重新渲染（完成项移入/移出"已完成"折叠区）
      loadStudyPlan();
      // 真白情感反馈（庆祝/安慰）+ 语音：显示中文，播日语预设场景台词
      if (r?.emotion) {
        window.kanban.notify("🎀 真白", r.emotion);
        if (voiceOn) {
          if (r.emotionScene) window.kanban.playScene(r.emotionScene);
          else window.kanban.speak(r.emotion);
        }
      }
    });
    el.querySelector(".s-learn").addEventListener("click", () => showStudyDetail(el.dataset.id));
  });
  // 主题簇组头：点击折叠/展开（状态存内存，重渲染后按状态恢复；默认展开）
  root.querySelectorAll(".study-group-head").forEach((head) => {
    const grp = head.dataset.grp;
    const body = head.parentElement?.querySelector(".study-group-body");
    if (!body) return;
    const apply = () => {
      if (groupCollapsed.has(grp)) { body.style.display = "none"; head.classList.add("collapsed"); }
      else { body.style.display = ""; head.classList.remove("collapsed"); }
    };
    apply();
    head.addEventListener("click", () => {
      if (groupCollapsed.has(grp)) groupCollapsed.delete(grp);
      else groupCollapsed.add(grp);
      apply();
    });
  });
}

$("study-done-toggle")?.addEventListener("click", () => {
  const dl = $("study-done-list");
  const show = dl.style.display === "none";
  dl.style.display = show ? "" : "none";
  if (show) loadStudyPlan(); // 重新渲染以填充已完成列表
  else $("study-done-toggle").textContent = `📜 已完成条目（${dl.querySelectorAll(".study-item").length}，点击展开）`;
});

// ============ 多条目批量模式（归并 / 批量完成 / 批量移除） ============
let clusterMode = false;
// 主题簇组折叠状态（内存变量：仅影响主清单 visible 区渲染，默认展开）
const groupCollapsed = new Set();
const clusterBtn = () => $("study-cluster-btn");

function updateClusterBtn() {
  const n = document.querySelectorAll(".study-item.cluster-selected").length;
  clusterBtn().textContent = clusterMode ? (n >= 2 ? `🔗 确认归并(${n})` : "🔗 确认归并") : (n >= 2 ? `🔗 批量(${n})` : "🔗 批量");
  // 批量操作条联动
  const bar = $("study-batch-bar");
  if (bar) {
    bar.classList.toggle("hidden", !clusterMode);
    const count = $("study-batch-count");
    if (count) count.textContent = `已选 ${n} 项`;
    const doneBtn = $("study-batch-done");
    if (doneBtn) doneBtn.disabled = n === 0;
    const delBtn = $("study-batch-del");
    if (delBtn) delBtn.disabled = n === 0;
  }
}

// 批量标记完成
$("study-batch-done")?.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".study-item.cluster-selected")].map((el) => el.dataset.id);
  if (!ids.length) return;
  for (const id of ids) await window.kanban.studyCheck(id, true);
  window.kanban.notify("📋 学习清单", `已标记完成 ${ids.length} 项（自动生成复习卡，进入复习闭环）`);
  exitClusterMode();
  loadStudyPlan();
});

// 退出批量模式
function exitClusterMode() {
  clusterMode = false;
  clusterBtn().textContent = "🔗 批量";
  clusterBtn().classList.remove("cluster-active");
  document.querySelectorAll(".study-item.cluster-selected").forEach((el) => el.classList.remove("cluster-selected"));
  updateClusterBtn();
  loadStudyPlan();
}
$("study-batch-exit")?.addEventListener("click", exitClusterMode);

clusterBtn().addEventListener("click", async () => {
  if (!clusterMode) {
    // 进入批量模式
    clusterMode = true;
    clusterBtn().textContent = "🔗 确认归并";
    clusterBtn().classList.add("cluster-active");
    document.querySelectorAll(".study-item.cluster-selected").forEach((el) => el.classList.remove("cluster-selected"));
    // 自动展开已完成折叠区，让已完成条目也能参与批量选择
    $("study-done-list").style.display = "";
    loadStudyPlan();
    updateClusterBtn();
    window.kanban.notify("🔗 批量模式", "勾选条目后：🔗 归并生成主题簇讲解 / ✅ 批量标记完成 / 🗑 批量移除");
    return;
  }
  // 确认归并
  const ids = [...document.querySelectorAll(".study-item.cluster-selected")].map((el) => el.dataset.id);
  if (ids.length < 2) { window.kanban.notify("🔗 归并", "至少选 2 个条目"); return; }
  exitClusterMode();
  // 弹层展示归并结果
  await showClusterResult(ids);
});

// 归并结果弹层（复用学习弹层，流式显示）
async function showClusterResult(ids) {
  sdCurrentId = "cluster-" + ids.join("-");
  sdOverlay().classList.remove("hidden");
  $("sd-modal-title").textContent = "🔗 归并中...";
  sdBody().innerHTML = '<div style="color:#8a87a8;font-size:13px;padding:12px">📚 正在归并多个讲解为主题簇综合讲解（去重合并 + 扩展关联考点）...</div>';
  try {
    let merged = "";
    const r = await window.kanban.studyCluster(ids, (delta) => {
      merged += delta;
      sdBody().innerHTML = renderMd(merged) + '<div class="sd-streaming">⏳ 归并中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight;
    });
    const name = r?.clusterName || "综合讲解";
    $("sd-modal-title").textContent = "🔗 " + name;
    studyDetailCache[sdCurrentId] = { content: merged, topic: name };
    sdBody().innerHTML = renderMd(merged);
    buildToc(); // 锚点目录（归并版）
    sdBody().scrollTop = 0;
    // 提示存档位置
    if (r?.saved) {
      window.kanban.notify("🔗 归并完成", `已生成《${name}》综合讲解，存档于 study_notes/`);
    }
  } catch (e) {
    sdBody().innerHTML = `<div style="color:#c05050;font-size:13px;padding:12px">⚠️ ${esc(e.message)}</div>`;
  }
}

// ============ 学习详情：全屏弹层展开讲解 + 追问补充 ============
let studyDetailCache = {}; // id -> { content, topic }
let sdCurrentId = null;    // 当前弹层打开的条目 id
const sdOverlay = () => $("study-detail-overlay");
const sdBody = () => $("sd-modal-body");

async function showStudyDetail(id) {
  sdCurrentId = id;
  // 显示弹层 + 加载态
  sdOverlay().classList.remove("hidden");
  sdBody().innerHTML = '<div style="color:#8a87a8;font-size:13px;padding:12px">📖 加载讲解中...</div>';
  try {
    // 缓存命中：直接展示
    if (studyDetailCache[id]?.content) {
      $("sd-modal-title").textContent = "📖 " + studyDetailCache[id].topic;
      sdBody().innerHTML = renderMd(studyDetailCache[id].content);
      buildToc(); // 锚点目录
      sdBody().scrollTop = 0;
      return;
    }
    // 流式获取（SSE）：逐段渲染，无文件条目也能边生成边看
    const topic = await streamStudyDetail(id, (content) => {
      sdBody().innerHTML = renderMd(content) + '<div class="sd-streaming">⏳ 生成中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight; // 生成中跟随最新内容
    });
    $("sd-modal-title").textContent = "📖 " + topic;
    buildToc(); // 锚点目录（流式生成完成）
    // 生成完成：回到顶部（从头阅读，不留在末尾）
    sdBody().scrollTop = 0;
  } catch (e) {
    sdBody().innerHTML = `<div style="color:#c05050;font-size:13px;padding:12px">⚠️ ${esc(e.message)}</div>`;
  }
}

// 追问补充：基于已有讲解继续深入（流式显示 + 更新缓存）
let sdAsking = false;
async function askStudyDetail() {
  const question = $("sd-ask-input").value.trim();
  if (!question || !sdCurrentId || sdAsking) return;
  sdAsking = true;
  const btn = $("sd-ask-btn");
  btn.disabled = true;
  btn.textContent = "补充中...";
  $("sd-ask-input").value = "";
  try {
    // 初始内容（未生成时先生成）
    if (!studyDetailCache[sdCurrentId]?.content) {
      const topic = await streamStudyDetail(sdCurrentId, (c) => {
        sdBody().innerHTML = renderMd(c) + '<div class="sd-streaming">⏳ 生成中...</div>';
        sdBody().scrollTop = sdBody().scrollHeight;
      });
      $("sd-modal-title").textContent = "📖 " + topic;
    }
    const base = studyDetailCache[sdCurrentId]?.content || "";
    // 追加分隔 + 追问标题
    sdBody().innerHTML = renderMd(base) + `<div class="sd-ask-q">💬 追问：${esc(question)}</div><div class="sd-streaming">⏳ 补充中...</div>`;
    sdBody().scrollTop = sdBody().scrollHeight;
    // 流式补充
    let extra = "";
    await window.kanban.studyDetailAppend(sdCurrentId, question, (delta) => {
      extra += delta;
      sdBody().innerHTML = renderMd(base) + `<div class="sd-ask-q">💬 追问：${esc(question)}</div>` + renderMd(extra) + '<div class="sd-streaming">⏳ 补充中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight;
    });
    // 完成：更新缓存（下次打开能看到补充内容）
    const topic = studyDetailCache[sdCurrentId]?.topic || "讲解";
    studyDetailCache[sdCurrentId] = { content: base + `\n\n## 💬 追问：${question}\n\n` + extra, topic };
    sdBody().innerHTML = renderMd(studyDetailCache[sdCurrentId].content);
    buildToc(); // 锚点目录（含新追问章节）
    sdBody().scrollTop = sdBody().scrollHeight; // 停留在补充处
  } catch (e) {
    const box = document.createElement("div");
    box.style.cssText = "color:#c05050;font-size:12px;padding:8px";
    box.textContent = "⚠️ " + e.message;
    sdBody().appendChild(box);
  } finally {
    sdAsking = false;
    btn.disabled = false;
    btn.textContent = "💬 追问";
  }
}

$("sd-ask-btn").addEventListener("click", askStudyDetail);
$("sd-ask-input").addEventListener("keydown", (e) => { if (e.key === "Enter") askStudyDetail(); });

// 整理全文：把原始讲解 + 多轮追问整合成结构统一的完整讲解（流式显示 + 写回文件）
let sdConsolidating = false;
async function consolidateStudyDetail() {
  if (!sdCurrentId || sdConsolidating) return;
  sdConsolidating = true;
  const btn = $("sd-consolidate-btn");
  btn.disabled = true;
  btn.textContent = "整理中...";
  try {
    // 初始内容（未生成时先生成）
    if (!studyDetailCache[sdCurrentId]?.content) {
      const topic = await streamStudyDetail(sdCurrentId, (c) => {
        sdBody().innerHTML = renderMd(c) + '<div class="sd-streaming">⏳ 生成中...</div>';
        sdBody().scrollTop = sdBody().scrollHeight;
      });
      $("sd-modal-title").textContent = "📖 " + topic;
    }
    const base = studyDetailCache[sdCurrentId]?.content || "";
    sdBody().innerHTML = '<div style="color:#8a87a8;font-size:13px;padding:12px">📚 正在整合全文（去重合并、统一结构）...</div>';
    // 流式整合
    let merged = "";
    await window.kanban.studyConsolidate(sdCurrentId, (delta) => {
      merged += delta;
      sdBody().innerHTML = renderMd(merged) + '<div class="sd-streaming">⏳ 整合中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight;
    });
    // 完成：更新缓存（下次打开看到整理版）
    const topic = studyDetailCache[sdCurrentId]?.topic || "讲解";
    studyDetailCache[sdCurrentId] = { content: merged, topic };
    $("sd-modal-title").textContent = "📖 " + topic + "（已整理）";
    sdBody().innerHTML = renderMd(merged);
    buildToc(); // 锚点目录（整理版）
    sdBody().scrollTop = 0; // 从头阅读整理版
  } catch (e) {
    const box = document.createElement("div");
    box.style.cssText = "color:#c05050;font-size:12px;padding:8px";
    box.textContent = "⚠️ " + e.message;
    sdBody().appendChild(box);
  } finally {
    sdConsolidating = false;
    btn.disabled = false;
    btn.textContent = "📚 整理";
  }
}
$("sd-consolidate-btn").addEventListener("click", consolidateStudyDetail);

// 流式获取讲解（走 IPC 通道，避开渲染层 fetch 的 webSecurity 限制）
async function streamStudyDetail(id, onUpdate) {
  let content = "";
  let topic = "讲解";
  const result = await window.kanban.studyDetailStream(id, (delta) => {
    if (!delta) return;
    content += delta;
    onUpdate(content);
  });
  // JSON 模式（有文件）：result 带 topic/content
  if (result?.fromFile) {
    content = result.content || content;
    topic = result.topic || topic;
  }
  if (!content) throw new Error("没有获取到内容");
  studyDetailCache[id] = { content, topic };
  return topic;
}

$("sd-modal-close").addEventListener("click", () => sdOverlay().classList.add("hidden"));
sdOverlay().addEventListener("click", (e) => {
  if (e.target === sdOverlay()) sdOverlay().classList.add("hidden"); // 点遮罩关闭
});

// 轻量 Markdown 渲染：标题/代码块/列表/表格/引用/加粗/斜体/行内代码/分隔线
let tocSeq = 0; // 锚点 id 计数器（讲解内容标题用）

/**
 * 构建讲解锚点目录：扫描弹层内的标题（.sd-h）与追问块（.sd-ask-q），
 * 生成可点击 chips（横向滚动），点击平滑滚动定位 + 高亮闪烁
 */
function buildToc() {
  const body = sdBody();
  const toc = $("sd-toc");
  if (!body || !toc) return;
  const items = [];
  body.querySelectorAll(".sd-h, .sd-ask-q").forEach((el) => {
    if (!el.id) { tocSeq++; el.id = `sd-anchor-${tocSeq}`; }
    const isQ = el.classList.contains("sd-ask-q");
    const hl = isQ ? 1 : Number(el.dataset.hl || 1);
    let text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 26);
    if (isQ) text = text.replace(/^💬\s*追问[：:]\s*/, ""); // 目录已有 💬 图标，去掉前缀
    items.push({ id: el.id, text, hl, q: isQ });
  });
  if (items.length <= 1) {
    toc.classList.add("hidden");
    toc.innerHTML = "";
    return;
  }
  toc.classList.remove("hidden");
  // 滚轮横向滚动（chips 横向容器用滚轮滚动，绑定一次）
  if (!toc.dataset.wheelBound) {
    toc.dataset.wheelBound = "1";
    toc.addEventListener("wheel", (e) => {
      if (e.deltaY && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        toc.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
  }
  toc.innerHTML = items.map((it) => `
    <button class="sd-toc-item" data-target="${it.id}" data-hl="${it.hl}" title="${esc(it.text)}">${it.q ? "💬 " : ""}${esc(it.text)}</button>`).join("");
  toc.querySelectorAll(".sd-toc-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.add("sd-anchor-flash");
      setTimeout(() => target.classList.remove("sd-anchor-flash"), 1600);
    });
  });
}

function renderMd(md) {
  const lines = String(md || "").split("\n");
  let html = "";
  let inCode = false;
  let tableBuf = [];
  let quoteBuf = [];
  const flushTable = () => {
    if (!tableBuf.length) return;
    // 拆行 → 单元格（去首尾 |）
    const rows = tableBuf.map((r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
    // 过滤分隔行 |---|---|
    const dataRows = rows.filter((r) => !(r.length && r.every((c) => /^:?-{2,}:?$/.test(c.replace(/<[^>]*>/g, "")))));
    let t = "<table class='sd-table'><tbody>";
    dataRows.forEach((r, i) => {
      t += "<tr>";
      r.forEach((c) => {
        t += i === 0 ? `<th>${inlineMd(c)}</th>` : `<td>${inlineMd(c)}</td>`;
      });
      t += "</tr>";
    });
    html += t + "</tbody></table>";
    tableBuf = [];
  };
  const flushQuote = () => {
    if (!quoteBuf.length) return;
    html += `<blockquote class="sd-quote">${quoteBuf.map((q) => `<div>${inlineMd(q)}</div>`).join("")}</blockquote>`;
    quoteBuf = [];
  };
  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      flushTable(); flushQuote();
      if (inCode) { html += "</code></pre>"; inCode = false; }
      else { html += "<pre class='sd-code'><code>"; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(raw) + "\n"; continue; }
    const t = raw.trim();
    // 表格
    if (t.startsWith("|")) { flushQuote(); tableBuf.push(t); continue; }
    flushTable();
    // 引用
    if (t.startsWith(">")) { const q = t.replace(/^>\s?/, ""); if (q) quoteBuf.push(q); continue; }
    flushQuote();
    if (!t) { html += "<div class='sd-blank'></div>"; continue; }
    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(t)) { html += "<hr class='sd-hr'>"; continue; }
    // 标题（带层级 data-hl + 锚点 id，供目录导航跳转）
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      const tag = `h${Math.min(lv + 2, 5)}`; // h1→h3、h2→h4、h3/h4→h5
      tocSeq++;
      html += `<${tag} class="sd-h" data-hl="${lv <= 2 ? 1 : 2}" id="sd-anchor-${tocSeq}">${inlineMd(h[2])}</${tag}>`;
      continue;
    }
    // 列表
    if (/^[-*•]\s/.test(t)) { html += `<div class="sd-li">• ${inlineMd(t.replace(/^[-*•]\s/, ""))}</div>`; continue; }
    if (/^\d+\.\s/.test(t)) { html += `<div class="sd-li">${inlineMd(t)}</div>`; continue; }
    // 段落
    html += `<p>${inlineMd(t)}</p>`;
  }
  flushTable(); flushQuote();
  if (inCode) html += "</code></pre>";
  return html;
}

// 行内格式：**加粗** / *斜体* / `行内代码` / [文字](链接)
function inlineMd(s) {
  const escaped = esc(s);
  // 链接 href 二次净化：esc() 已把引号转成 &quot;，若直接拼进 href，浏览器解析时解码回引号 → 属性逃逸（XSS）。
  // 这里清掉引号/尖括号类实体 + 截断长度，保证 href 内不再出现任何可闭合属性的字符。
  const cleanHref = (u) => u.replace(/&quot;|&#34;|&#x22;|&#39;|&apos;|&lt;|&gt;|&#60;|&#62;/gi, "").slice(0, 2048);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code class='sd-inline-code'>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${cleanHref(u)}" target="_blank" rel="noopener">${t}</a>`);
}

$("study-gen").addEventListener("click", async () => {
  $("study-gen").disabled = true;
  $("study-gen").textContent = "生成中...";
  const r = await window.kanban.studyGenerate();
  loadStudyPlan();
  $("study-gen").disabled = false;
  $("study-gen").textContent = "✨ 从产出生成清单";
  // 反馈生成结果：新增 N 条 / 全部与现有清单重复
  const p = r?.plan;
  if (p?.error) {
    window.kanban.notify("✨ 生成清单", `生成失败：${p.error}`);
  } else if (p?.addedCount > 0) {
    window.kanban.notify("✨ 生成清单", `已新增 ${p.addedCount} 个知识点${(p.skippedSimilar || p.skippedExact) ? `，${(p.skippedSimilar || 0) + (p.skippedExact || 0)} 条与现有重复已跳过` : ""}`);
  } else {
    const dup = (p?.skippedSimilar || 0) + (p?.skippedExact || 0);
    window.kanban.notify("✨ 生成清单", dup > 0
      ? `本次提炼 ${dup} 条知识点全部与现有清单重复，已跳过（清单已覆盖这些考点，无需膨胀）`
      : "未提炼到新知识点");
  }
});

// ============ 面试实录：被问住的知识点入清单 ============
$("iv-notes-btn").addEventListener("click", async () => {
  const input = $("iv-notes-input").value.trim();
  if (!input) return;
  const btn = $("iv-notes-btn");
  const result = $("iv-notes-result");
  btn.disabled = true;
  btn.textContent = "记录中...";
  result.className = "iv-notes-result";
  result.textContent = "⏳ 正在加入学习清单...";
  try {
    const r = await window.kanban.interviewNotes(input);
    if (!r?.ok) { result.textContent = "⚠️ " + (r?.error || "记录失败"); return; }
    result.innerHTML = `
      <div style="color:#3a8a5a">✅ 新增 ${r.added?.length || 0} 个：${esc((r.added || []).join("、") || "无")}</div>
      ${r.existing?.length ? `<div style="color:#b07020">已在清单：${esc(r.existing.join("、"))}</div>` : ""}
      ${r.skipped?.length ? `<div style="color:#8a87a8">跳过非知识点：${esc(r.skipped.map((s) => s.topic).join("、"))}</div>` : ""}
      <div style="color:#8a87a8;font-size:11px;margin-top:4px">${esc(r.hint || "")}</div>`;
    $("iv-notes-input").value = "";
    loadStudyPlan(); // 刷新清单显示新条目
  } catch (e) {
    result.textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "📌 记录";
  }
});
$("iv-notes-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("iv-notes-btn").click(); });

$("study-review").addEventListener("click", async () => {
  const r = await window.kanban.studyReview();
  if (!r?.ok) { alert(r?.error || "无复盘内容"); return; }
  const box = $("review-box");
  box.classList.remove("hidden");
  $("review-questions").innerHTML = (r.questions || []).map((q, i) => `
    <div class="rq" data-id="${q.id}">
      <div class="rq-topic">${i + 1}. ${esc(q.topic)}</div>
      <div class="rq-q">${esc(q.question)}</div>
      <textarea placeholder="输入你的回答..."></textarea>
      <div class="rq-verdict"></div>
    </div>`).join("");
});

$("review-submit").addEventListener("click", async () => {
  const answers = [];
  $("review-questions").querySelectorAll(".rq").forEach((el) => {
    answers.push({ id: el.dataset.id, answer: el.querySelector("textarea").value });
  });
  const r = await window.kanban.studyAnswer(answers);
  if (!r?.ok) { alert(r?.error || "判分失败"); return; }
  (r.results || []).forEach((res) => {
    // 匹配题目显示判分
    const el = [...$("review-questions").querySelectorAll(".rq")].find((x) =>
      x.querySelector(".rq-topic").textContent.includes(res.topic?.slice(0, 8)));
    if (!el) return;
    const vd = el.querySelector(".rq-verdict");
    const cls = res.verdict === "对" ? "good" : res.verdict === "部分对" ? "mid" : "bad";
    vd.className = "rq-verdict " + cls;
    vd.textContent = `${res.verdict}：${res.comment || ""}`;
  });
  loadStudyPlan();
});

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

// ============ 校招（简历驱动匹配 + 投递管理） ============
const STATUS_LABEL = { new: "🆕 未处理", ready: "📮 已投递", ready_bishi: "✍️ 待笔试", done: "✅ 已拿offer/结束" };
const DIRECTION_LABEL = { frontend: "前端", agent: "AI Agent", fullstack: "全栈", backend: "后端", other: "其他" };

let jobsFilter = { status: "", fav: false }; // 校招筛选：status 走后端过滤，fav 客户端过滤

// ============ 学习-求职闭环（多向驱动状态 + 规则建议） ============
async function loadLoop() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/loop");
    const j = await r.json();
    if (!j?.ok) return;
    const box = document.getElementById("loop-box");
    if (!box) return;
    const n = j.nodes || {};
    const chip = (label, val, color) => `<span class="job-badge" style="background:${color || "rgba(109,79,216,.12)"};color:${color ? "#fff" : "#7c6fd8"}">${label} ${esc(String(val))}</span>`;
    box.innerHTML = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 0;">
        ${chip("🎯 方向", n.direction || "未设置", n.direction ? "rgba(80,160,255,.2)" : "rgba(220,120,80,.2)")}
        ${chip("📚 待学", n.learning?.todo ?? "—", n.learning?.todo > 0 ? "rgba(220,160,60,.2)" : "rgba(80,220,120,.2)")}
        ${chip("🔧 薄弱", n.learning?.weak ?? "—", n.learning?.weak > 0 ? "rgba(220,80,80,.2)" : "rgba(80,220,120,.2)")}
        ${chip("💼 未投", n.jobs?.open ?? "—")}
        ${chip("📮 已投", n.jobs?.applied ?? "—")}
        ${chip("🎤 最近面试", n.interview ? `${n.interview.avg}分` : "无", n.interview ? "rgba(138,90,220,.25)" : "rgba(120,120,140,.15)")}
      </div>
      <div style="padding:4px 0 2px;line-height:1.7;font-size:12px;color:#c9c6dd;">
        ${(j.suggestions || []).map((s) => `<div>${esc(s)}</div>`).join("") || '<div style="color:#8a87a8">暂无建议</div>'}
      </div>`;
  } catch { /* widget 未启动忽略 */ }
}

// ============ 全局闭环状态条（顶栏下，所有 Tab 可见） ============
async function loadLoopBar() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/loop");
    const j = await r.json();
    if (!j?.ok) return;
    const bar = document.getElementById("loop-bar");
    if (!bar) return;
    const n = j.nodes || {};
    const ch = (label, val, cls = "") => `<span class="loop-chip ${cls}">${label} <b>${esc(String(val))}</b></span>`;
    // 题库进度：手写/算法 91 题闭环
    const cs = n.challenges || { total: 0, done: 0 };
    const pct = cs.total ? Math.round(cs.done / cs.total * 100) : 0;
    const focus = n.focus || {};
    bar.innerHTML = `
      ${ch("🎯", n.direction || "未设置", n.direction ? "" : "warn")}
      ${ch("📚 待学", n.learning?.todo ?? 0, n.learning?.todo > 0 ? "warn" : "ok")}
      ${ch("🔁 复习到期", n.learning?.reviewDue ?? 0, n.learning?.reviewDue > 0 ? "warn" : "ok")}
      ${ch("💼 未投", n.jobs?.open ?? 0)}
      ${focus.streak > 0 ? ch("🔥 专注", `${focus.streak}天`, "ok") : ""}
      <span class="loop-progress" title="手写/算法题库进度：${cs.done}/${cs.total}">
        <span style="font-size:10px;color:#6a6790;">✍️ 题库</span>
        <span class="track"><i style="width:${pct}%"></i></span>
        <span class="pct">${cs.done}/${cs.total}</span>
      </span>`;
  } catch { /* widget 未启动忽略 */ }
}

// ============ 平台账号（BOSS 等：AI 逛网搜岗 + 半自动投递） ============
const AUTH_STATUS = { none: "未配置", cookie: "已配置 Cookie", edge: "浏览器会话", browser: "浏览器会话" };
const P_API = "http://127.0.0.1:8899/api/platforms";

async function loadPlatforms() {
  try {
    const r = await fetch(P_API);
    const j = await r.json();
    if (!j?.ok || !Array.isArray(j.platforms)) return;
    const box = document.getElementById("platforms-box");
    if (!box) return;
    box.innerHTML = j.platforms.map((p) => `
      <div class="platform-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0;border-bottom:1px dashed rgba(109,79,216,.15);">
        <b style="min-width:90px">${esc(p.label)}</b>
        <span class="job-badge" style="background:${p.enabled ? "rgba(80,220,120,.15);color:#2e9e5b" : "rgba(120,120,140,.15);color:#7c7c8c"}">${p.enabled ? "🟢 已启用" : "⚪ 未启用"}</span>
        <span class="job-badge">登录态：${AUTH_STATUS[p.authStatus] || p.authStatus}</span>
        <span class="job-badge">今日投递 ${p.applyToday}/${p.applyDailyLimit}</span>
        <button class="job-btn" data-pname="${p.name}" data-act="toggle" title="${p.enabled ? "停用后不再搜岗/投递" : "启用后 AI 可搜索该平台岗位"}">${p.enabled ? "🔌 停用" : "▶️ 启用"}</button>
        <button class="job-btn" data-pname="${p.name}" data-act="config">⚙️ 配置</button>
      </div>
      <div class="platform-config" id="pcfg-${p.name}" hidden style="padding:8px 10px;background:rgba(109,79,216,.06);border-radius:8px;margin:4px 0;">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0;">
          <input id="pcookie-${p.name}" placeholder="Cookie 头（登录 ${esc(p.label)} 后 F12 → Application → Cookies 复制）" style="flex:1;min-width:200px;padding:5px 8px;border:1px solid rgba(109,79,216,.25);border-radius:6px;font-size:11px;background:rgba(255,255,255,.85);">
          <button class="job-btn" data-pname="${p.name}" data-act="save-cookie">💾 保存 Cookie</button>
          <button class="job-btn" data-pname="${p.name}" data-act="import-edge" title="从 Edge/Chrome 浏览器读取 ${esc(p.label)} 登录态（需本机浏览器已登录）">🔄 导入浏览器登录态</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0;">
          <textarea id="pgreet-${p.name}" placeholder="投递招呼语（发送给 HR 的第一句话，可点「✨ 生成」自动写一段展示优势的）" style="flex:2;min-width:220px;padding:5px 8px;border:1px solid rgba(109,79,216,.25);border-radius:6px;font-size:11px;background:rgba(255,255,255,.85);height:36px;">${esc(p.greeting || "")}</textarea>
          <button class="job-btn" data-pname="${p.name}" data-act="greet-gen" title="根据简历（学校/实习/项目/技能）自动生成展示优势的招呼语">✨ 生成</button>
          <button class="job-btn" data-pname="${p.name}" data-act="greet-polish" title="用 AI 把招呼语改写得更有吸引力（消耗一次 LLM 调用，写完点保存生效）">🪄 AI 精修</button>
          <label style="font-size:11px;color:#8a87a8;align-self:center">每日上限</label>
          <input id="plimit-${p.name}" type="number" min="1" max="50" value="${p.applyDailyLimit}" style="width:56px;padding:5px 8px;border:1px solid rgba(109,79,216,.25);border-radius:6px;font-size:11px;background:rgba(255,255,255,.85);">
          <button class="job-btn" data-pname="${p.name}" data-act="save-config">💾 保存设置</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0;">
          <input id="pkw-${p.name}" placeholder="🔍 搜岗位关键词，如：前端开发 / React 工程师" style="flex:1;min-width:200px;padding:5px 8px;border:1px solid rgba(109,79,216,.25);border-radius:6px;font-size:11px;background:rgba(255,255,255,.85);">
          <button class="job-btn" data-pname="${p.name}" data-act="search">🔍 搜索并入库</button>
        </div>
        <div id="presult-${p.name}" class="jobs-list" style="margin-top:6px;"></div>
      </div>`).join("");
    box.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => platformAction(btn));
    });
  } catch { /* widget 未启动忽略 */ }
}

async function platformAction(btn) {
  const name = btn.dataset.pname;
  const act = btn.dataset.act;
  const post = (body) => fetch(P_API, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, patch: body }),
  }).then((r) => r.json());
  try {
    if (act === "toggle") {
      const st = await fetch(P_API).then((r) => r.json());
      const p = (st.platforms || []).find((x) => x.name === name);
      await post({ enabled: !p?.enabled });
      loadPlatforms();
      return;
    }
    if (act === "config") {
      const box = document.getElementById(`pcfg-${name}`);
      if (box) box.hidden = !box.hidden;
      return;
    }
    if (act === "save-cookie") {
      const cookie = document.getElementById(`pcookie-${name}`).value.trim();
      const r = await post({ cookie, authMethod: cookie ? "cookie" : "none" });
      window.kanban.notify("🤖 平台账号", r.ok ? "✅ Cookie 已保存" : `保存失败：${r.error || ""}`);
      loadPlatforms();
      return;
    }
    if (act === "import-edge") {
      const r = await post({ authMethod: "edge", cookie: "" });
      window.kanban.notify("🤖 平台账号", r.ok ? "✅ 已设为浏览器登录态（搜索/投递时自动读取 Edge/Chrome）" : `设置失败：${r.error || ""}`);
      loadPlatforms();
      return;
    }
    if (act === "save-config") {
      const greeting = document.getElementById(`pgreet-${name}`).value.trim();
      const limit = Math.min(Math.max(parseInt(document.getElementById(`plimit-${name}`).value, 10) || 10, 1), 50);
      const r = await post({ greeting, applyDailyLimit: limit });
      window.kanban.notify("🤖 平台账号", r.ok ? `✅ 已保存（每日上限 ${limit}）` : `保存失败：${r.error || ""}`);
      loadPlatforms();
      return;
    }
    if (act === "greet-gen" || act === "greet-polish") {
      // 生成/精修投递招呼语（✨ 规则版即时生成；🪄 LLM 精修较慢）
      const box = document.getElementById(`pgreet-${name}`);
      const btn = document.querySelector(`[data-act="${act}"][data-pname="${name}"]`);
      btn.disabled = true;
      btn.textContent = act === "greet-gen" ? "⏳ 生成中…" : "⏳ 精修中（约 10-30s）…";
      try {
        const isPolish = act === "greet-polish";
        const res = await fetch("http://127.0.0.1:8899/api/greeting", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ company: "", title: "", summary: "", polish: isPolish }),
        });
        const j = await res.json();
        if (j.ok) {
          box.value = j.greeting;
          window.kanban.notify("🤖 平台账号", isPolish ? "🪄 已精修——点「💾 保存设置」生效" : "✨ 已生成优势招呼语——点「💾 保存设置」生效");
        } else {
          window.kanban.notify("🤖 平台账号", `生成失败：${j.error || ""}`);
        }
      } catch (e) {
        window.kanban.notify("🤖 平台账号", "生成失败：" + String(e.message || e).slice(0, 60));
      } finally {
        btn.disabled = false;
        btn.textContent = act === "greet-gen" ? "✨ 生成" : "🪄 AI 精修";
      }
      return;
    }
    if (act === "search") {
      const kw = document.getElementById(`pkw-${name}`).value.trim();
      if (!kw) { window.kanban.notify("🤖 平台账号", "请输入搜索关键词"); return; }
      const resultBox = document.getElementById(`presult-${name}`);
      resultBox.innerHTML = '<div class="empty-hint">🔍 搜索中（首次需启动浏览器，约 10-20 秒）…</div>';
      const res = await fetch(P_API + "/search", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: name, keyword: kw, limit: 15 }),
      });
      const j = await res.json();
      if (!j.ok || !Array.isArray(j.jobs) || !j.jobs.length) {
        resultBox.innerHTML = `<div class="empty-hint">${esc(j.error || j.warn || "未找到岗位")}</div>`;
        return;
      }
      resultBox.innerHTML = `
        <div class="resume-status">${esc(j.hint || "")}</div>
        ${j.jobs.map((job) => `
          <div class="job-item">
            <div class="job-head"><b>${esc(job.company)}</b><span class="job-title">${esc(job.title)}</span></div>
            <div class="job-meta">${esc(job.salary || "")} ${esc(job.location || "")} ${job.dup ? '<span style="color:#8a87a8">已入库</span>' : '<span style="color:#2e9e5b">新入库</span>'}</div>
            <div class="job-actions">
              <a class="job-link" href="${esc(safeUrl(job.url))}" target="_blank" rel="noopener">🔗 查看</a>
              <button class="job-btn" data-pname="${name}" data-apply="${esc(safeUrl(job.url))}" data-jid="${job.id || ""}">📮 投递</button>
            </div>
          </div>`).join("")}`;
      resultBox.querySelectorAll("button[data-apply]").forEach((b) => {
        b.addEventListener("click", () => platformApply(b.dataset.pname, b.dataset.apply, b.dataset.jid, b));
      });
      return;
    }
  } catch (e) {
    window.kanban.notify("🤖 平台账号", "操作失败：" + String(e.message || e).slice(0, 80));
  }
}

// 半自动投递（用户点击按钮 = 主动确认；走频率限制 + 平台执行）
async function platformApply(platform, url, jobId, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ 投递中…";
  try {
    const res = await fetch(P_API + "/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, url, jobId }),
    });
    const j = await res.json();
    if (j.ok) {
      window.kanban.notify("📮 投递结果", j.detail || "已发起投递");
      btn.textContent = "✅ 已投递";
    } else {
      window.kanban.notify("📮 投递失败", String(j.error || "未知错误").slice(0, 80));
      btn.textContent = old;
    }
    loadJobs(); // 刷新岗位列表（状态变化）
  } catch (e) {
    window.kanban.notify("📮 投递失败", String(e.message || e).slice(0, 80));
    btn.textContent = old;
  } finally {
    btn.disabled = false;
  }
}

// 已投天数文案（applied_at 为毫秒时间戳）
function appliedDaysText(job) {
  if (!job.appliedAt) return "";
  const days = Math.floor((Date.now() - job.appliedAt) / 86400000);
  return days > 0 ? `已投 ${days} 天` : "今天投递";
}

async function loadJobs() {
  try {
    // 非"全部"状态 → 走 GET /api/jobs?status=；否则用推荐列表（技术岗 + 匹配排序）
    const url = jobsFilter.status
      ? `http://127.0.0.1:8899/api/jobs?status=${encodeURIComponent(jobsFilter.status)}`
      : "http://127.0.0.1:8899/api/jobs/recommended";
    const r = await fetch(url);
    const j = await r.json();
    let jobs = j.recommended || j.jobs || [];
    if (jobsFilter.fav) jobs = jobs.filter((x) => x.favorite); // 收藏客户端过滤
    const list = document.getElementById("jobs-list");
    if (!jobs.length) {
      list.innerHTML = '<div class="empty-hint">暂无岗位——点上方「🔍 搜集校招」抓取，或先设置简历/方向</div>';
      return;
    }
    list.innerHTML = jobs.map((job) => `
      <div class="job-item">
        <div class="job-head">
          <b>${esc(job.company)}</b>
          <span class="job-title">${esc(job.title)}</span>
          <span class="job-badge">${DIRECTION_LABEL[job.direction] || job.direction}</span>
          <span class="job-badge" style="background:rgba(80,160,255,.15);color:#3a7bd5;">匹配 ${job.match || "—"}</span>
        </div>
        <div class="job-meta">
          ${job.jobType ? `<span>${esc(job.jobType)}</span>` : ""}
          ${job.deadline ? `<span>⏰ 截止 ${esc(job.deadline)}</span>` : ""}
          ${job.bishiDate ? `<span>📝 笔试 ${esc(job.bishiDate)}</span>` : ""}
          ${job.appliedAt ? `<span>📅 ${esc(appliedDaysText(job))}</span>` : ""}
          <span>${STATUS_LABEL[job.status] || job.status}</span>
        </div>
        ${job.summary ? `<div class="job-summary">${esc(job.summary)}</div>` : ""}
        ${job.jdText ? `<div class="job-jd" id="jd-${job.id}" hidden><pre>${esc(job.jdText)}</pre></div>` : ""}
        <div class="job-actions">
          <button class="job-btn job-fav" data-id="${job.id}" data-fav="${job.favorite ? 1 : 0}" title="收藏/取消收藏">${job.favorite ? "⭐" : "☆"}</button>
          ${job.applyUrl ? `<a class="job-link" href="${esc(safeUrl(job.applyUrl))}" target="_blank" rel="noopener">🔗 去投递</a>` : ""}
          ${job.jdText ? `<button class="job-btn jd-toggle" data-id="${job.id}">📋 JD</button>` : ""}
          <button class="job-btn loop-study" data-id="${job.id}" title="从岗位 JD 反推考点，加入学习清单（投递前知道要补什么）">📚 学考点</button>
          <button class="job-btn loop-iv" data-id="${job.id}" title="按该岗位 JD 开一场模拟面试（面试官按岗位考点出题）">🎤 按岗面试</button>
          <button class="job-btn" data-id="${job.id}" data-status="ready">📮 已投递</button>
          <button class="job-btn" data-id="${job.id}" data-status="ready_bishi">✍️ 待笔试</button>
          <button class="job-btn" data-id="${job.id}" data-status="done">✅ 完成</button>
        </div>
      </div>`).join("");
    // 📚 学考点：岗位 JD 反推学习清单（闭环：岗位 → 学习）
    document.querySelectorAll(".loop-study").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = "⏳ 提炼考点…";
        try {
          const res = await fetch("http://127.0.0.1:8899/api/loop/job-study", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId: id }),
          });
          const j = await res.json();
          if (j.ok) {
            window.kanban.notify("📚 岗位考点", `${j.hint || "已加入学习清单"}`);
            btn.textContent = "✅ 已入清单";
            loadStudyPlan(); // 刷新学习清单
          } else {
            window.kanban.notify("📚 岗位考点", String(j.error || "失败").slice(0, 80));
            btn.textContent = "📚 学考点";
          }
        } catch (e) {
          window.kanban.notify("📚 岗位考点", String(e.message || e).slice(0, 80));
          btn.textContent = "📚 学考点";
        } finally {
          btn.disabled = false;
        }
      });
    });
    // 🎤 按岗面试：按岗位 JD 出题（闭环：岗位 → 面试）
    document.querySelectorAll(".loop-iv").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = "⏳ 面试官就位…";
        try {
          const res = await fetch("http://127.0.0.1:8899/api/loop/interview-for-job", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId: id }),
          });
          const j = await res.json();
          if (j.ok) {
            window.kanban.notify("🎤 按岗面试", `第 ${j.round} 问（${j.dimension || ""}）：${String(j.question || "").slice(0, 60)}…`);
            btn.textContent = "🎤 面试已开始";
            // 切到面试 Tab（如已打开面试会话，面板面试 Tab 会展示）
            const ivTab = document.querySelector('[data-tab="interview"]');
            if (ivTab) switchTab("interview");
          } else {
            window.kanban.notify("🎤 按岗面试", String(j.error || "失败").slice(0, 80));
            btn.textContent = "🎤 按岗面试";
          }
        } catch (e) {
          window.kanban.notify("🎤 按岗面试", String(e.message || e).slice(0, 80));
          btn.textContent = "🎤 按岗面试";
        } finally {
          btn.disabled = false;
        }
      });
    });
    // 📋 JD 展开/收起（jd_text 来自外部页面，渲染已 esc() 转义防 XSS）
    document.querySelectorAll(".jd-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const box = document.getElementById(`jd-${btn.dataset.id}`);
        if (!box) return;
        const open = box.hidden;
        box.hidden = !open;
        btn.textContent = open ? "📕 收起" : "📋 JD";
      });
    });
    // ⭐ 收藏/取消收藏
    document.querySelectorAll(".job-fav").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const fav = btn.dataset.fav === "1" ? 0 : 1;
        await fetch("http://127.0.0.1:8899/api/jobs/favorite", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: btn.dataset.id, favorite: fav }),
        });
        loadJobs();
      });
    });
    document.querySelectorAll(".job-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!btn.dataset.status) return; // 收藏/其它无 data-status 的按钮不触发状态更新
        await fetch("http://127.0.0.1:8899/api/jobs/status", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: btn.dataset.id, status: btn.dataset.status }),
        });
        loadJobs();
      });
    });
  } catch (e) {
    document.getElementById("jobs-list").innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

// 校招状态筛选 chips（全部/未投递/已投递/待笔试/已完成 + 收藏）
document.querySelectorAll("#jobs-filter .job-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#jobs-filter .job-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    jobsFilter = { status: chip.dataset.status || "", fav: chip.dataset.fav === "1" };
    loadJobs();
  });
});

// 设置方向 + 生成建议
document.getElementById("jobs-direction-btn")?.addEventListener("click", async () => {
  const direction = document.getElementById("jobs-direction").value;
  const statusEl = document.getElementById("jobs-status");
  if (!direction) { statusEl.textContent = "⚠️ 请先选择想做的方向"; return; }
  statusEl.textContent = "⏳ 生成方向建议中…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/jobs/direction", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    const j = await res.json();
    if (!j.ok) { statusEl.textContent = j.error || "设置失败"; return; }
    statusEl.textContent = `已设置方向：${j.target}，推荐已按此重排`;
    document.getElementById("jobs-direction-advice").innerHTML =
      `<div class="jobs-advice-box"><h4>🎯 ${esc(j.target)} 方向调整建议</h4><pre>${esc(j.advice || "")}</pre></div>`;
    loadJobs();
  } catch (e) {
    statusEl.textContent = "⚠️ " + e.message;
  }
});

// 搜集校招（官网 → 公司名单 → 大小厂兜底）
document.getElementById("jobs-collect-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("jobs-collect-btn");
  const statusEl = document.getElementById("jobs-status");
  btn.disabled = true;
  btn.textContent = "⏳ 搜集校招中（可能 1-3 分钟）…";
  statusEl.textContent = "开始搜集：官网优先 → 公司名单 → 大小厂兜底…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/jobs/collect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await res.json();
    const parts = [];
    if (j.official) parts.push(`官网+${j.official.totalNew}`);
    if (j.companies) parts.push(`公司+${j.companies.totalNew}`);
    if (j.fallback) parts.push(`兜底+${j.fallback.totalNew}`);
    statusEl.textContent = `搜集完成：${parts.join(" / ") || "无新增"}`;
    loadJobs();
  } catch (e) {
    statusEl.textContent = "⚠️ 搜集失败：" + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 搜集校招";
  }
});

// ============ 官方学习文档（前端/AI/Agent 三类 + 版本检测） ============
async function loadDocs() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/learning");
    const j = await r.json();
    const list = document.getElementById("docs-list");
    if (!j.categories?.length) {
      list.innerHTML = '<div class="empty-hint">暂无文档清单</div>';
      return;
    }
    const statusEl = document.getElementById("docs-status");
    statusEl.textContent = j.lastCheck ? `上次检查：${new Date(j.lastCheck).toLocaleString("zh-CN")}` : "官方文档清单，点「检查最新版本」更新";
    list.innerHTML = j.categories.map((cat) => `
      <div class="jobs-cat">
        <div class="jobs-cat-title">${esc(cat.category)}</div>
        ${cat.sites.map((s) => {
          const c = s.check || {};
          let badge;
          if (c.ok && c.version) {
            badge = `✅ v${esc(c.version)}${c.date ? " · " + esc(c.date) : ""}`;
          } else if (c.ok && c.note) {
            badge = `📖 ${esc(c.note)}`;
          } else {
            badge = `⚠️ ${esc(c.error || "未检测")}`;
          }
          // 项目内版本对比：项目版本 < 最新 → 橙色升级提示
          let upgrade = "";
          if (c.version && c.localVersion && c.localVersion !== c.version) {
            upgrade = `<div class="job-meta" style="color:#c07a20;font-weight:600;">📌 你的项目：v${esc(c.localVersion)} → 最新 v${esc(c.version)}</div>`;
          }
          // 升级命令（registry 包名存在时）
          let cmd = "";
          if (s.registry?.pkg) {
            const c2 = s.registry.type === "pypi"
              ? `pip install ${esc(s.registry.pkg)} --upgrade`
              : `npm i ${esc(s.registry.pkg)}@latest`;
            cmd = `<button class="job-btn docs-copy" data-cmd="${esc(c2)}" title="复制升级命令">📋 ${esc(c2)}</button>`;
          }
          return `
          <div class="job-item">
            <div class="job-head">
              <b>${esc(s.name)}</b>
              <span class="job-badge" style="background:${c.ok ? "rgba(120,180,120,.15);color:#3a8d5a;" : "rgba(220,150,60,.15);color:#b07020;"}">${badge}</span>
            </div>
            <div class="job-meta">${esc(s.desc)}</div>
            ${upgrade}
            <div class="job-actions">
              <a class="job-link" href="${esc(safeUrl(s.official))}" target="_blank" rel="noopener">🔗 官方文档</a>
              ${s.versionPage && s.versionPage !== s.official ? `<a class="job-link" href="${esc(safeUrl(s.versionPage))}" target="_blank" rel="noopener">📄 版本页</a>` : ""}
              ${cmd}
            </div>
          </div>`;
        }).join("")}
      </div>`).join("");
    list.querySelectorAll(".docs-copy").forEach((btn) => {
      btn.addEventListener("click", () => {
        try { navigator.clipboard.writeText(btn.dataset.cmd); } catch { /* ignore */ }
        btn.textContent = "✅ 已复制";
        setTimeout(() => { btn.textContent = "📋 " + btn.dataset.cmd; }, 1500);
      });
    });
  } catch (e) {
    document.getElementById("docs-list").innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

// 项目路径：读取 + 保存（用于"最新版 vs 项目内版本"对比；输入框在设置中心）
async function loadDocsProject() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/learning/project");
    const j = await r.json();
    if (j?.ok && j.path) document.getElementById("set-docs-project").value = j.path;
  } catch { /* ignore */ }
}
document.getElementById("docs-project-btn")?.addEventListener("click", async () => {
  const p = document.getElementById("docs-project").value.trim();
  try {
    const r = await fetch("http://127.0.0.1:8899/api/learning/project", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }),
    });
    const j = await r.json();
    window.kanban.notify("📚 官方文档", j?.ok ? (j.message || "已保存") : "保存失败：" + (j?.error || ""));
    if (j?.ok) loadDocs(); // 重新拉取（check 结果带项目对比）
  } catch (e) {
    window.kanban.notify("📚 官方文档", "保存失败：" + String(e.message || e).slice(0, 60));
  }
});

document.getElementById("docs-check-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("docs-check-btn");
  const statusEl = document.getElementById("docs-status");
  btn.disabled = true;
  btn.textContent = "⏳ 检查中（约 1 分钟）…";
  statusEl.textContent = "正在抓取各官方文档版本页…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/learning/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await res.json();
    const ok = Object.entries(j.results || {}).filter(([, v]) => v?.ok).length;
    const total = Object.entries(j.results || {}).filter(([k]) => k !== "_lastCheck").length;
    statusEl.textContent = `检查完成：${ok}/${total} 个文档提取到最新版本`;
    loadDocs();
  } catch (e) {
    statusEl.textContent = "⚠️ 检查失败：" + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 检查最新版本";
  }
});

// ============ 求职驾驶舱（本周总览 + 7 天活动 + 累计进度 + 周报建议） ============
async function loadDashboard() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/dashboard");
    const j = await r.json();
    if (!j?.ok) return;
    const w = j.week || {};
    // 本周总览 chips
    $("dashboard-week").innerHTML = `
      <div class="stat-chip">📚 学习完成 <b>${w.studyDone ?? 0}</b></div>
      <div class="stat-chip">🔁 复习 <b>${w.reviewDone ?? 0}</b> 张</div>
      <div class="stat-chip">✍️ 刷题 <b>${w.challengeDone ?? 0}</b> 道</div>
      <div class="stat-chip">⏱️ 专注 <b>${Math.round((w.focusMinutes ?? 0) / 60 * 10) / 10}</b> 小时</div>
      <div class="stat-chip">💼 投递 <b>${w.applyCount ?? 0}</b> 家</div>
      <div class="stat-chip">🎤 面试 <b>${w.interviewCount ?? 0}</b> 场</div>`;
    // 7 天活动热力（四类活动堆叠条）
    const series = j.weekSeries || [];
    if (series.length) {
      const maxFocus = Math.max(...series.map((d) => d.focus), 1);
      const maxAct = Math.max(...series.map((d) => d.study + d.review + d.challenge), 1);
      const todayStr = new Date().toISOString().slice(0, 10);
      const dayLabel = (d) => {
        const n = new Date(d.date + "T00:00:00").getDay();
        return ["日", "一", "二", "三", "四", "五", "六"][n] || d.date.slice(5);
      };
      $("dashboard-series").innerHTML = `
        <div style="font-size:11px;color:#8a87a8;margin:8px 0 4px;">📈 近 7 天活动（绿=学习 · 紫=复习 · 蓝=刷题 · 底部条=专注时长）</div>
        <div style="display:flex;gap:6px;align-items:flex-end;">
          ${series.map((d) => {
            const isToday = d.date === todayStr;
            const h1 = Math.max(2, Math.round((d.study / maxAct) * 26));
            const h2 = Math.max(2, Math.round((d.review / maxAct) * 26));
            const h3 = Math.max(2, Math.round((d.challenge / maxAct) * 26));
            const hf = Math.max(2, Math.round((d.focus / maxFocus) * 10));
            return `<div style="flex:1;text-align:center;">
              <div style="display:flex;gap:2px;justify-content:center;align-items:flex-end;height:30px;">
                <span style="width:6px;height:${h1}px;background:${d.study ? "#3a8a5a" : "rgba(58,138,90,.08)"};border-radius:2px;" title="学习 ${d.study}"></span>
                <span style="width:6px;height:${h2}px;background:${d.review ? "#8a5adc" : "rgba(138,90,220,.08)"};border-radius:2px;" title="复习 ${d.review}"></span>
                <span style="width:6px;height:${h3}px;background:${d.challenge ? "#4a6fe0" : "rgba(74,111,224,.08)"};border-radius:2px;" title="刷题 ${d.challenge}"></span>
              </div>
              <div style="width:100%;height:4px;background:${d.focus ? "linear-gradient(90deg,#8a5adc,#5a3d9e)" : "rgba(109,79,216,.08)"};border-radius:2px;margin-top:2px;" title="专注 ${d.focus} 分钟"></div>
              <div style="font-size:9px;color:${isToday ? "#8a5adc" : "#8a87a8"};font-weight:${isToday ? "700" : "400"};">${dayLabel(d)}</div>
            </div>`;
          }).join("")}
        </div>`;
    }
    // 周报建议
    const rep = j.report || {};
    const lines = [];
    if (rep.highlights?.length) lines.push(`✅ 本周亮点：${rep.highlights.join("、")}`);
    if (rep.gaps?.length) lines.push(`⚠️ 待补：${rep.gaps.join("；")}`);
    lines.push("");
    (rep.suggestions || []).forEach((s) => lines.push(s));
    $("dashboard-report-body").textContent = lines.join("\n");
    // 累计进度
    const p = j.progress || {};
    const bar = (label, done, total, color = "linear-gradient(90deg,#8a5adc,#6d4fd8)") => {
      const pct = total ? Math.round(done / total * 100) : 0;
      return `<div class="mini-progress"><span style="width:110px;font-size:11px;color:#6a6790;">${label}</span>
        <span class="track"><i style="width:${pct}%;background:${color}"></i></span><b>${done}/${total}</b></div>`;
    };
    $("dashboard-progress").innerHTML = `
      <div style="font-size:11px;color:#8a87a8;margin:6px 0;">📌 累计进度（闭环总览）</div>
      ${bar("📚 学习清单", p.plan?.done, p.plan?.total)}
      ${bar("✍️ 手写/算法题库", p.challenges?.done, p.challenges?.total, "linear-gradient(90deg,#4a6fe0,#3a5bd5)")}
      ${bar("🔁 复习卡掌握", p.review?.mastered, p.review?.total, "linear-gradient(90deg,#3a8a5a,#2f7d4e)")}
      <div class="stats-row" style="margin-top:8px;">
        <div class="stat-chip">🎯 方向 <b>${esc(p.direction || "未设置")}</b></div>
        <div class="stat-chip">🔧 薄弱点 <b>${p.weak ?? 0}</b></div>
        <div class="stat-chip">🔁 复习到期 <b>${p.review?.due ?? 0}</b></div>
        <div class="stat-chip">💼 未投岗位 <b>${p.jobs?.open ?? 0}</b> · 已投 <b>${p.jobs?.applied ?? 0}</b></div>
      </div>`;
  } catch { /* widget 未启动忽略 */ }
}
$("dashboard-refresh-btn")?.addEventListener("click", loadDashboard);

// ============ 设置中心（全部配置统一入口，与各 Tab 共用后端配置） ============
async function loadSettings() {
  // 方向
  try {
    const r = await fetch("http://127.0.0.1:8899/api/loop");
    const j = await r.json();
    if (j?.ok && j.nodes?.direction) $("set-direction").value = j.nodes.direction;
  } catch { /* ignore */ }
  // 巡检
  try {
    const r = await window.kanban.patrolConfig();
    if (r?.ok) {
      $("set-patrol-enabled").checked = !!r.enabled;
      $("set-patrol-interval").value = String(r.intervalMin);
      $("set-patrol-status").textContent = r.enabled
        ? `每 ${r.intervalMin} 分钟${r.nextRun ? " · 下次 " + new Date(r.nextRun).toLocaleString("zh-CN", { hour12: false }) : ""}`
        : (r.note || "已关闭");
    }
  } catch { /* ignore */ }
  // RSS
  try {
    const r = await fetch("http://127.0.0.1:8899/api/rss/config");
    const j = await r.json();
    if (j?.ok) $("set-rss-feeds").value = (j.feeds || []).join("\n");
  } catch { /* ignore */ }
  // 邮箱
  try {
    const r = await fetch("http://127.0.0.1:8899/api/mail/config");
    const j = await r.json();
    if (j?.config?.email) $("set-mail-email").value = j.config.email;
    $("set-mail-status").textContent = j.config?.configured ? `✅ 已配置 ${j.config.email}` : "未配置";
  } catch { /* ignore */ }
  // 桌宠
  loadSettingsMascot();
  // 方向画像（讲解/面试/考点提炼角度）
  loadCareerProfile();
  // 知识树（掌握度骨架）
  loadKnowledgeTree();
  // 项目路径
  try {
    const r = await fetch("http://127.0.0.1:8899/api/learning/project");
    const j = await r.json();
    if (j?.ok && j.path) $("set-docs-project").value = j.path;
  } catch { /* ignore */ }
}

// 桌宠模型选择（设置中心；与对话 Tab 同一数据源）
async function loadSettingsMascot() {
  try {
    const r = await window.kanban.mascotModels();
    if (!r?.ok || !Array.isArray(r.models)) return;
    const box = $("set-mascot-models");
    if (!box) return;
    box.innerHTML = r.models.map((m) => `
      <button class="job-btn set-mascot-btn" data-path="${esc(m.path)}" data-name="${esc(m.name)}"
        style="${m.path === r.current ? "background:linear-gradient(135deg,#8a5adc,#6d4fd8);color:#fff;" : ""}">${esc(m.name)}</button>`).join("");
    box.querySelectorAll(".set-mascot-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const res = await window.kanban.mascotSetModel(btn.dataset.path);
        if (res?.ok) {
          window.kanban.notify("🎀 桌宠形象", `已切换为 ${res.model.name}，桌宠立即生效`);
          loadSettingsMascot();
        }
      });
    });
  } catch { /* ignore */ }
}

// ============ 🌳 知识树（掌握度骨架；转方向/开源可整体替换） ============
async function loadKnowledgeTree() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/knowledge/tree");
    const j = await r.json();
    if (!j?.ok) return;
    $("set-knowledge-tree").value = JSON.stringify(j.tree, null, 1);
    $("set-tree-status").textContent = j.isDefault
      ? "当前：默认前端知识树（" + j.tree.reduce((n, c) => n + c.points.length, 0) + " 个知识点）"
      : `当前：自定义知识树（${j.tree.length} 类 / ${j.tree.reduce((n, c) => n + c.points.length, 0)} 个知识点）`;
  } catch { /* ignore */ }
}

$("set-tree-save")?.addEventListener("click", async () => {
  const btn = $("set-tree-save");
  btn.disabled = true;
  try {
    let tree = null;
    try { tree = JSON.parse($("set-knowledge-tree").value); } catch { $("set-tree-status").textContent = "⚠️ JSON 解析失败，请检查格式"; return; }
    const r = await fetch("http://127.0.0.1:8899/api/knowledge/tree", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tree }),
    });
    const j = await r.json();
    $("set-tree-status").textContent = j.ok ? (j.message || "✅ 已保存") : "⚠️ " + (j.error || "保存失败");
    if (j.ok) loadKnowledgeTree();
  } catch (e) {
    $("set-tree-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
  }
});

$("set-tree-reset")?.addEventListener("click", async () => {
  const r = await fetch("http://127.0.0.1:8899/api/knowledge/tree", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
  const j = await r.json();
  $("set-tree-status").textContent = j.ok ? (j.message || "已重置") : "⚠️ " + (j.error || "重置失败");
  loadKnowledgeTree();
});

// 方向保存
$("set-direction-btn")?.addEventListener("click", async () => {
  const btn = $("set-direction-btn");
  btn.disabled = true;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/jobs/direction", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: $("set-direction").value }),
    });
    const j = await r.json();
    $("set-direction-status").textContent = j.ok ? `✅ 已保存${j.advice ? "，建议：" + String(j.advice).slice(0, 60) + "…" : ""}` : "⚠️ " + (j.error || "保存失败");
  } catch (e) {
    $("set-direction-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
  }
});

// ============ 🧭 方向画像（讲解/面试/考点提炼角度；转方向/开源只改这里） ============
async function loadCareerProfile() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/career/profile");
    const j = await r.json();
    if (!j?.ok || !j.profile) return;
    const p = j.profile;
    $("set-career-role").value = p.roleLabel || "";
    $("set-career-scope").value = p.scopeNote || "";
    $("set-career-ignore").value = p.ignoreNote || "";
    $("set-career-lang").value = p.codeLang || "";
    $("set-career-position").value = p.positionDefault || "";
    $("set-career-exam").value = p.examNote || "";
    $("set-career-tech").value = p.techKeywords || "";
    $("set-career-status").textContent = p.direction ? `当前方向：${p.direction} · 讲解角度：${(p.roleLabel || "").slice(0, 14)}…` : "未设置求职目标（讲解用默认前端角度）";
  } catch { /* ignore */ }
}

$("set-career-save")?.addEventListener("click", async () => {
  const btn = $("set-career-save");
  btn.disabled = true;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/career/profile", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roleLabel: $("set-career-role").value.trim(),
        scopeNote: $("set-career-scope").value.trim(),
        ignoreNote: $("set-career-ignore").value.trim(),
        codeLang: $("set-career-lang").value.trim(),
        positionDefault: $("set-career-position").value.trim(),
        examNote: $("set-career-exam").value.trim(),
        techKeywords: $("set-career-tech").value.trim(),
      }),
    });
    const j = await r.json();
    $("set-career-status").textContent = j.ok ? (j.message || "✅ 已保存") : "⚠️ " + (j.error || "保存失败");
  } catch (e) {
    $("set-career-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
  }
});

$("set-career-reset")?.addEventListener("click", async () => {
  const r = await fetch("http://127.0.0.1:8899/api/career/profile", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
  const j = await r.json();
  $("set-career-status").textContent = j.ok ? (j.message || "已重置") : "⚠️ " + (j.error || "重置失败");
  loadCareerProfile();
});

// 巡检开关/频率（共用 patrol-config API）
$("set-patrol-enabled")?.addEventListener("change", async () => {
  const r = await window.kanban.patrolConfig({ enabled: $("set-patrol-enabled").checked });
  if (r?.ok) $("set-patrol-status").textContent = $("set-patrol-enabled").checked ? "✅ 已开启" : "已关闭";
});
$("set-patrol-interval")?.addEventListener("change", async () => {
  const r = await window.kanban.patrolConfig({ intervalMin: parseInt($("set-patrol-interval").value, 10) });
  if (r?.ok) $("set-patrol-status").textContent = `✅ 每 ${$("set-patrol-interval").value} 分钟`;
});

// RSS 保存
$("set-rss-save")?.addEventListener("click", async () => {
  const feeds = $("set-rss-feeds").value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    const r = await fetch("http://127.0.0.1:8899/api/rss/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feeds }),
    });
    const j = await r.json();
    $("set-rss-status").textContent = j.ok ? `✅ 已保存 ${feeds.length} 个源` : "⚠️ " + (j.error || "");
  } catch (e) {
    $("set-rss-status").textContent = "⚠️ " + e.message;
  }
});

// 邮箱保存/测试（共用 mail API）
$("set-mail-save")?.addEventListener("click", async () => {
  const email = $("set-mail-email").value.trim();
  const authCode = $("set-mail-authcode").value.trim();
  if (!email || !authCode) { $("set-mail-status").textContent = "⚠️ 请填写邮箱和授权码"; return; }
  try {
    const r = await fetch("http://127.0.0.1:8899/api/mail/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, authCode }),
    });
    const j = await r.json();
    $("set-mail-status").textContent = j.ok ? "✅ 已保存：" + email : "⚠️ " + (j.error || "保存失败");
    if (j.ok) $("set-mail-authcode").value = "";
  } catch (e) { $("set-mail-status").textContent = "⚠️ " + e.message; }
});
$("set-mail-test")?.addEventListener("click", async () => {
  $("set-mail-status").textContent = "⏳ 测试中…";
  try {
    const r = await fetch("http://127.0.0.1:8899/api/mail/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await r.json();
    $("set-mail-status").textContent = j.ok ? "✅ 连接成功" : "⚠️ " + (j.error || "连接失败");
  } catch (e) { $("set-mail-status").textContent = "⚠️ " + e.message; }
});

// 语音开关（与对话 Tab 同步）
$("set-voice-btn")?.addEventListener("click", () => {
  voiceOn = !voiceOn;
  window.kanban.setVoiceEnabled(voiceOn);
  window.kanban.setGlobalVoice?.(voiceOn);
  $("set-voice-btn").textContent = voiceOn ? "🔊 语音开" : "🔇 语音关";
  const chatVoice = $("voice-btn");
  if (chatVoice) chatVoice.textContent = voiceOn ? "🔊" : "🔇";
});

// 项目路径保存
$("set-docs-project-btn")?.addEventListener("click", async () => {
  const p = $("set-docs-project").value.trim();
  try {
    const r = await fetch("http://127.0.0.1:8899/api/learning/project", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }),
    });
    const j = await r.json();
    window.kanban.notify("⚙️ 设置", j?.ok ? (j.message || "已保存") : "保存失败：" + (j?.error || ""));
  } catch (e) {
    window.kanban.notify("⚙️ 设置", "保存失败：" + String(e.message || e).slice(0, 60));
  }
});

// 数据维护：重建知识库 / 系统自检
$("set-kb-rebuild")?.addEventListener("click", async () => {
  const btn = $("set-kb-rebuild");
  btn.disabled = true;
  btn.textContent = "⏳ 重建中（约 15-60s）…";
  $("set-maintain-status").textContent = "正在重建索引…";
  try {
    const r = await fetch("http://127.0.0.1:8899/api/knowledge/rebuild", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await r.json();
    $("set-maintain-status").textContent = j.ok ? `✅ 重建完成：${j.items || "?"} 条` : "⚠️ " + (j.error || "");
  } catch (e) {
    $("set-maintain-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 重建知识库索引";
  }
});
$("set-self-check")?.addEventListener("click", async () => {
  $("set-maintain-status").textContent = "⏳ 自检中…";
  try {
    const r = await fetch("http://127.0.0.1:8899/api/self-check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await r.json();
    $("set-maintain-status").textContent = j.ok
      ? (j.issues?.length ? `⚠️ 发现 ${j.issues.length} 个问题（自动修复 ${j.issues.filter((i) => i.fixed).length} 个），详情见「爬取产出」Tab` : "✅ 全部正常")
      : "⚠️ " + (j.error || "");
  } catch (e) {
    $("set-maintain-status").textContent = "⚠️ " + e.message;
  }
});

// ============ 每日技术资讯（RSS 摘要）+ 已读标记 ============
// 已读：localStorage 按 link 记录；已读置灰，点击阅读原文自动标记
const RSS_READ_KEY = "rss-read-v1";
function rssReadSet() {
  try { return new Set(JSON.parse(localStorage.getItem(RSS_READ_KEY) || "[]")); } catch { return new Set(); }
}
function rssMarkRead(link) {
  try {
    const s = rssReadSet();
    s.add(link);
    localStorage.setItem(RSS_READ_KEY, JSON.stringify([...s]));
  } catch { /* ignore */ }
}
async function loadRss() {
  const list = $("rss-list");
  const statusEl = $("rss-status");
  try {
    const r = await fetch("http://127.0.0.1:8899/api/rss/digest");
    const j = await r.json();
    const last = j.lastDigestAt ? new Date(j.lastDigestAt).toLocaleString("zh-CN", { hour12: false }) : "—";
    if (!j.digest?.length) {
      statusEl.textContent = `还没有今日摘要（${j.feeds ?? "?"} 个源）· 点「🔄 立即刷新」生成`;
      list.innerHTML = '<div class="empty-hint">暂无今日资讯，点「🔄 立即刷新」抓取并 AI 摘要</div>';
      return;
    }
    const read = rssReadSet();
    const unread = j.digest.filter((d) => !read.has(d.link)).length;
    statusEl.textContent = `📰 今日 ${j.digest.length} 条 · ${unread} 条未读 · ${j.feeds ?? "?"} 个源 · 上次摘要 ${last}`;
    list.innerHTML = j.digest.map((d) => {
      const isRead = read.has(d.link);
      return `
      <div class="job-item" style="${isRead ? "opacity:.55;" : ""}">
        <div class="job-head">
          <b style="font-size:12px;">${isRead ? "✓ " : ""}${esc(d.title)}</b>
          ${d.feed ? `<span class="job-badge">${esc(d.feed)}</span>` : ""}
          ${isRead ? '<span class="job-badge" style="background:rgba(120,120,140,.15);color:#7c7c8c;">已读</span>' : ""}
        </div>
        <div class="job-meta">${esc(d.reason)}</div>
        <div class="job-actions">
          <a class="job-link rss-link" href="${esc(safeUrl(d.link))}" target="_blank" rel="noopener" data-link="${esc(d.link)}">🔗 阅读原文</a>
        </div>
      </div>`;
    }).join("");
    list.querySelectorAll(".rss-link").forEach((a) => {
      a.addEventListener("click", () => { rssMarkRead(a.dataset.link); loadRss(); });
    });
  } catch (e) {
    statusEl.textContent = "⚠️ " + e.message;
    list.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

$("rss-refresh-btn")?.addEventListener("click", async () => {
  const btn = $("rss-refresh-btn");
  const statusEl = $("rss-status");
  btn.disabled = true;
  btn.textContent = "⏳ 抓取摘要中（约 1 分钟）…";
  statusEl.textContent = "正在抓取 RSS 源并 AI 摘要…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/rss/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await res.json();
    if (!j.ok) statusEl.textContent = "⚠️ " + (j.error || "摘要失败");
  } catch (e) {
    statusEl.textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 立即刷新";
    loadRss();
  }
});

// ============ 个人主页（简历存档中心：上传/粘贴/保存/拷打清单） ============
const profileStatus = $("profile-status");
const profileResume = $("profile-resume");

// 加载已存档简历状态（画像 + 原文）+ 简历驱动全景（岗位/拷打清单/招呼语联动）
async function loadProfileStatus() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/jobs/profile");
    const j = await r.json();
    const savedBox = $("profile-saved");
    if (!j.profile) {
      savedBox.innerHTML = '<div class="empty-hint">📭 还没有存档简历——上传或粘贴后点「💾 保存简历」</div>';
      profileStatus.textContent = "";
      renderProfileDrive(null);
      return;
    }
    const skills = (j.profile.skills || []).join("、");
    const dirs = (j.profile.directions || []).map((d) => DIRECTION_LABEL[d] || d).join("、");
    const upd = j.rawUpdatedAt ? new Date(j.rawUpdatedAt).toLocaleString("zh-CN") : "—";
    savedBox.innerHTML = `
      <div class="jobs-advice-box">
        <h4>📄 已存档简历 <span style="font-weight:400;color:#8a87a8;">（${upd} 更新 · 原文 ${j.rawLength} 字）</span></h4>
        <div class="job-meta">技能：${esc(skills || "—")}</div>
        <div class="job-meta">方向：${esc(dirs || "—")}</div>
      </div>`;
    profileStatus.textContent = "✅ 简历已存档（修改后点「💾 保存简历」更新）";
    // 原文回填（便于修改；用户没填过时）
    if (j.rawSaved && !profileResume.value.trim()) profileResume.value = j.rawText || "";
    // 简历驱动全景：岗位匹配 / 面试 / 拷打清单 / 投递招呼语
    renderProfileDrive(j.profile);
  } catch (e) {
    profileStatus.textContent = "⚠️ 加载失败：" + e.message;
  }
}

// 简历驱动全景：并拉 岗位/清单/招呼语 → 展示联动状态 + 一键跳转
async function renderProfileDrive(profile) {
  const body = $("profile-drive-body");
  if (!body) return;
  if (!profile) {
    body.innerHTML = '<div style="color:#8a87a8;font-size:12px;">存档简历后这里会展示它驱动的模块：岗位匹配 / 面试拷打 / 投递招呼语 / 学习清单</div>';
    return;
  }
  const skills = profile.skills || [];
  const dirs = profile.directions || [];
  const skillChips = skills.slice(0, 10).map((s) =>
    `<span class="job-chip" style="padding:2px 9px;font-size:10px;background:rgba(138,90,220,.1);border-color:rgba(138,90,220,.25);color:#5d48b8;">${esc(s)}</span>`).join("");
  try {
    const [jobsR, planR, greetR] = await Promise.all([
      fetch("http://127.0.0.1:8899/api/jobs").then((x) => x.json()).catch(() => null),
      fetch("http://127.0.0.1:8899/api/study-plan").then((x) => x.json()).catch(() => null),
      fetch("http://127.0.0.1:8899/api/greeting").then((x) => x.json()).catch(() => null),
    ]);
    const jobs = jobsR?.ok ? (jobsR.jobs || jobsR.list || []) : [];
    const open = jobs.filter((j) => j.status === "new").length;
    const applied = jobs.filter((j) => j.status === "apply" || j.status === "ready").length;
    const planItems = planR?.plan?.items || [];
    const todoCount = planItems.filter((i) => !i.done).length;
    const greeting = greetR?.ok ? String(greetR.greeting || "") : "";
    // 拷打清单 = 简历驱动（source 含"简历"/"拷打"）+ 面试实录
    const drillCount = planItems.filter((i) => /简历|拷打|面试实录/.test(i.source || "")).length;
    body.innerHTML = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px;">
        <span style="font-size:11px;color:#8a87a8;align-self:center;">技能画像：</span>${skillChips || '<span style="font-size:11px;color:#8a87a8;">（未提取到技能，重新保存简历试试）</span>'}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <div class="stat-chip" style="cursor:pointer;" title="简历技能命中驱动的岗位推荐，点击去校招 Tab">
          💼 匹配岗位 <b>${jobs.length}</b>（未投 <b>${open}</b> · 已投 <b>${applied}</b>）
        </div>
        <div class="stat-chip" style="cursor:pointer;" title="简历项目拷打清单 + 面试实录条目，点击去学习清单">
          🎯 拷打清单 <b>${drillCount}</b>（待学 <b>${todoCount}</b>）
        </div>
        <div class="stat-chip" title="招呼语已自动用于 BOSS 投递，点「✨ 生成」可重新生成">
          ✍️ 投递招呼语 <b>${greeting ? "已就绪" : "未生成"}</b>
        </div>
      </div>
      ${greeting ? `<div class="job-meta" style="margin-top:6px;">招呼语预览：<span style="color:#6a6790;">${esc(greeting.slice(0, 90))}${greeting.length > 90 ? "…" : ""}</span></div>` : ""}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        <button class="job-btn" data-drive="jobs">🏢 去看匹配岗位</button>
        <button class="job-btn" data-drive="study">📋 去拷打清单</button>
        <button class="job-btn" data-drive="platforms">🤖 去平台配置招呼语</button>
        <button class="job-btn" data-drive="interview">🎤 按简历模拟面试</button>
      </div>`;
    body.querySelectorAll("[data-drive]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.drive;
        if (t === "platforms") switchTab("jobs");
        else switchTab(t);
        if (t === "platforms") {
          setTimeout(() => {
            const box = document.getElementById("pcfg-boss");
            if (box) box.hidden = false;
          }, 300);
        }
      });
    });
  } catch { /* 联动数据拉取失败不影响主状态 */ }
}

// 上传文件 → 填到主页文本框
$("profile-file-btn")?.addEventListener("click", () => $("profile-file").click());
$("profile-file")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const r = await parseResumeFile(file);
    profileResume.value = r.text;
    profileStatus.textContent = "✅ " + r.msg + "（点「💾 保存简历」存档）";
    profileStatus.className = "resume-status";
  } catch (err) {
    profileStatus.textContent = "⚠️ " + err.message;
    profileStatus.className = "resume-status error";
  }
});

// 保存简历（画像 + 原文）
$("profile-save-btn")?.addEventListener("click", async () => {
  const resume = (profileResume.value || "").trim();
  if (!resume || resume.length < 40) {
    profileStatus.textContent = "⚠️ 请先上传或粘贴简历（至少 40 字）";
    profileStatus.className = "resume-status error";
    return;
  }
  const btn = $("profile-save-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 保存中…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/jobs/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume }),
    });
    const j = await res.json();
    profileStatus.className = "resume-status";
    profileStatus.textContent = j.ok ? `✅ 已存档：技能 ${(j.skills || []).length} 个 · 方向 ${(j.directions || []).join(",") || "未识别"}` : "⚠️ " + (j.error || "保存失败");
    loadProfileStatus();
  } catch (e) {
    profileStatus.textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 保存简历";
  }
});

// 生成拷打清单（简历项目 → 学习清单）
$("profile-plan-btn")?.addEventListener("click", async () => {
  const resume = (profileResume.value || "").trim();
  if (!resume || resume.length < 40) {
    profileStatus.textContent = "⚠️ 请先上传或粘贴简历（至少 40 字）";
    profileStatus.className = "resume-status error";
    return;
  }
  const btn = $("profile-plan-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 提取项目中…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/resume-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume }),
    });
    const j = await res.json();
    profileStatus.className = "resume-status";
    profileStatus.textContent = j.message || "完成";
    loadStudyPlan();
  } catch (e) {
    profileStatus.textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🎯 生成拷打清单";
  }
});

// ============ 本地知识库（RAG 混合检索） ============
const KIND_LABEL = { mianjing: "📄 面经", jiaocheng: "📘 教程", job: "🏢 岗位", doc: "📚 文档", note: "📝 学习" };

async function loadKbStats() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/knowledge/stats");
    const j = await r.json();
    const statusEl = $("kb-status");
    if (!j.total) {
      statusEl.textContent = "⏳ 知识库为空——后端启动后会自动构建（约 15-60s），或点「🔄 重建索引」";
      return;
    }
    const kinds = (j.byKind || []).map((k) => `${KIND_LABEL[k.kind] || k.kind} ${k.n}`).join(" · ");
    statusEl.textContent = `📦 ${j.total} 条（${kinds}）${j.lastBuild ? " · 构建于 " + new Date(j.lastBuild).toLocaleString("zh-CN") : ""}${j.embedding ? " · 语义检索 ✅" : " · 仅关键词检索"}`;
  } catch (e) {
    $("kb-status").textContent = "⚠️ " + e.message;
  }
}

async function kbSearch() {
  const q = $("kb-input").value.trim();
  const list = $("kb-results");
  if (!q) { list.innerHTML = ""; return; }
  list.innerHTML = '<div class="empty-hint">🔍 检索中…</div>';
  try {
    const res = await fetch("http://127.0.0.1:8899/api/knowledge/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, topK: 8 }),
    });
    const j = await res.json();
    if (!j.hits?.length) { list.innerHTML = '<div class="empty-hint">没有命中——换个说法，或点「🔄 重建索引」</div>'; return; }
    list.innerHTML = `<div style="font-size:11px;color:#8a87a8;margin:2px 0 6px;">命中 ${j.hits.length} 条（语义+关键词混合检索）</div>` +
      j.hits.map((h) => `
      <div class="job-item">
        <div class="job-head">
          <span class="job-badge">${KIND_LABEL[h.kind] || h.kind}</span>
          <b style="font-size:12px;">${esc(h.title)}</b>
          ${h.vectorScore ? `<span class="job-badge" style="background:rgba(80,160,255,.15);color:#3a7bd5;">语义 ${(h.vectorScore * 100).toFixed(0)}%</span>` : ""}
          ${h.ftsScore ? `<span class="job-badge" style="background:rgba(120,180,120,.15);color:#3a8d5a;">关键词</span>` : ""}
        </div>
        <div class="job-summary">${esc(h.content.slice(0, 150))}${h.content.length > 150 ? "…" : ""}</div>
      </div>`).join("");
  } catch (e) {
    list.innerHTML = '<div class="empty-hint">⚠️ ' + esc(e.message) + "</div>";
  }
}

$("kb-search-btn")?.addEventListener("click", kbSearch);
$("kb-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") kbSearch(); });

// RAG 问答：检索 → 注入 → LLM 生成
$("kb-ask-btn")?.addEventListener("click", async () => {
  const q = $("kb-ask-input").value.trim();
  const box = $("kb-answer");
  if (!q) { box.innerHTML = ""; return; }
  box.innerHTML = '<div class="jobs-advice-box"><h4>⏳ 正在检索知识库并生成答案…</h4></div>';
  try {
    const res = await fetch("http://127.0.0.1:8899/api/knowledge/ask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const j = await res.json();
    if (!j.ok) { box.innerHTML = '<div class="jobs-advice-box"><h4>📭 未命中</h4><p style="font-size:11px;color:#6a6790;">' + esc(j.message || "") + "</p></div>"; return; }
    box.innerHTML = `
      <div class="jobs-advice-box">
        <h4>💬 回答</h4>
        <div style="font-size:12px;line-height:1.7;color:#2d2a45;">${renderMd(String(j.answer || ""))}</div>
        <div style="font-size:10px;color:#8a87a8;margin-top:8px;">📚 引用 ${j.hits.length} 条：${j.hits.map((h) => esc(h.title.slice(0, 24))).join(" / ")}</div>
      </div>`;
  } catch (e) {
    box.innerHTML = '<div class="jobs-advice-box"><h4>⚠️ 失败</h4><p style="font-size:11px;color:#6a6790;">' + esc(e.message) + "</p></div>";
  }
});
$("kb-ask-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("kb-ask-btn").click(); });
$("kb-rebuild-btn")?.addEventListener("click", async () => {
  const btn = $("kb-rebuild-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 重建中（约 15-60s）…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/knowledge/rebuild", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await res.json();
    $("kb-status").textContent = j.message || "重建完成";
    loadKbStats();
  } catch (e) {
    $("kb-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 重建索引";
  }
});

// ============ 笔试真题（大厂真题 + 平台模拟卷） ============
async function loadZhenti() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/zhenti");
    const j = await r.json();
    const statusEl = $("zhenti-status");
    const list = $("zhenti-list");
    if (!j.papers?.length) {
      statusEl.textContent = "暂无真题——点「🔍 搜集真题」抓取牛客官方试卷（大厂真题 + 模拟卷）";
      list.innerHTML = "";
      return;
    }
    const byKind = {};
    for (const k of j.byKind || []) byKind[k.kind] = k.n;
    statusEl.textContent = `📦 共 ${j.total} 套（真题 ${byKind.real || 0} / 模拟卷 ${byKind.simulate || 0}）· 练习需牛客账号（免费申请）`;
    list.innerHTML = j.papers.map((p) => `
      <div class="job-item">
        <div class="job-head">
          <span class="job-badge" style="${p.kind === "simulate" ? "background:rgba(120,180,120,.15);color:#3a8d5a;" : "background:rgba(109,79,216,.12);color:#5d48b8;"}">${p.kind === "simulate" ? "🧪 模拟卷" : "🏢 真题"}</span>
          <b style="font-size:12px;">${esc(p.company || "平台")}</b>
          <span class="job-title">${esc(p.title)}</span>
        </div>
        <div class="job-meta">
          ${p.questionCount ? `<span>总 ${p.questionCount} 题</span>` : ""}
          ${p.singleCount ? `<span>单选 ${p.singleCount}</span>` : ""}
          ${p.multiCount ? `<span>多选 ${p.multiCount}</span>` : ""}
          ${p.programCount ? `<span>编程 ${p.programCount}</span>` : ""}
          ${p.jobTags?.length ? `<span>${esc(p.jobTags.slice(0, 4).join(" / "))}</span>` : ""}
        </div>
        <div class="job-actions">
          <a class="job-link" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">📝 去练习</a>
          <button class="job-btn zhenti-fetch" data-id="${esc(p.test_id)}" title="登录态抓取完整题目（牛客账号，首次弹扫码窗口）">📖 抓题目</button>
          <button class="job-btn zhenti-plan" data-id="${esc(p.test_id)}" title="整套真题加入学习清单（练完用记错题回流）">➕ 入清单</button>
          <button class="job-btn zhenti-wrong" data-id="${esc(p.test_id)}" data-company="${esc(p.company)}" data-title="${esc(p.title)}" title="练习做错的题 → 入学习清单+复习卡">❌ 记错题</button>
        </div>
      </div>`).join("");
    // 整套真题 → 学习清单
    document.querySelectorAll(".zhenti-plan").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const res = await fetch("http://127.0.0.1:8899/api/zhenti/plan", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paperTestId: btn.dataset.id }),
          });
          const j = await res.json();
          alert(j.ok ? `✅ 已加入学习清单：${j.topic}\n（练习后做错的题点「❌ 记错题」回流）` : "⚠️ " + (j.error || "失败"));
          loadStudyPlan();
        } catch (e) { alert("⚠️ " + e.message); }
      });
    });
    // 抓题目（保留能力：同会话扫码可用）
    document.querySelectorAll(".zhenti-fetch").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "⏳ 抓取中…";
        try {
          const res = await fetch("http://127.0.0.1:8899/api/zhenti/questions", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paperTestId: btn.dataset.id }),
          });
          const j = await res.json();
          if (!j.ok) { alert("⚠️ " + (j.error || "抓取失败")); }
          else { alert(`✅ 抓到 ${j.questions.length} 道题（已缓存；完整题目在牛客答题页可回看）`); }
        } catch (e) { alert("⚠️ " + e.message); }
        finally { btn.disabled = false; btn.textContent = "📖 抓题目"; }
      });
    });
    // 记错题 → 学习清单 + 复习卡
    document.querySelectorAll(".zhenti-wrong").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const question = prompt(`记录你做错的题（题干，来自 ${btn.dataset.title}）：`);
        if (!question || !question.trim()) return;
        const answer = prompt("你的错误答案/卡壳点（可跳过，留空即可）：") || "";
        try {
          const res = await fetch("http://127.0.0.1:8899/api/zhenti/wrong", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paperId: btn.dataset.id, company: btn.dataset.company, paperTitle: btn.dataset.title, question, answer }),
          });
          const j = await res.json();
          alert(j.ok ? `✅ 已入学习清单 + 复习卡：${j.topic}` : "⚠️ " + (j.error || "失败"));
        } catch (e) { alert("⚠️ " + e.message); }
      });
    });
  } catch (e) {
    $("zhenti-status").textContent = "⚠️ " + e.message;
  }
}

// ============ 专项练习（牛客面试 TOP101） ============
let ojCategory = "";

async function loadOj() {
  try {
    const res = await fetch("http://127.0.0.1:8899/api/oj/problems?category=" + encodeURIComponent(ojCategory));
    const j = await res.json();
    const statusEl = $("oj-status");
    const cats = $("oj-cats");
    const list = $("oj-list");
    if (!j.problems?.length) {
      statusEl.textContent = "题库为空——点「🔄 更新题库」抓取牛客面试 TOP101（101 道高频算法题）";
      cats.innerHTML = "";
      list.innerHTML = "";
      return;
    }
    statusEl.textContent = `📦 共 ${j.total} 道（${(j.byCategory || []).length} 个分类）· 免登录随时刷，点击题目直达牛客答题页`;
    // 分类筛选 chips
    cats.innerHTML = `<button class="oj-cat-chip" data-cat="" style="${!ojCategory ? activeChip : ""}">全部</button>` +
      (j.byCategory || []).map((c) =>
        `<button class="oj-cat-chip" data-cat="${esc(c.category)}" style="${ojCategory === c.category ? activeChip : ""}">${esc(c.category)} (${c.count})</button>`
      ).join("");
    document.querySelectorAll(".oj-cat-chip").forEach((btn) => {
      btn.addEventListener("click", () => { ojCategory = btn.dataset.cat; loadOj(); });
    });
    // 题目列表
    list.innerHTML = j.problems.map((p) => `
      <div class="job-item" id="oj-${esc(p.bm_no)}">
        <div class="job-head">
          <span class="job-badge" style="background:rgba(109,79,216,.12);color:#5d48b8;">${esc(p.bm_no)}</span>
          <b style="font-size:12px;">${esc(p.category)}</b>
          <span class="job-title">${esc(p.title)}</span>
        </div>
        <div class="job-meta">
          <span style="color:${diffColor(p.difficulty)}">${esc(p.difficulty || "—")}</span>
          <span>通过 ${esc(p.people || "—")}</span>
        </div>
        <div class="job-actions">
          <button class="job-btn oj-view" data-url="${esc(safeUrl(p.url))}" data-title="${esc(p.title)}" title="抓取题目内容到本地（缓存，二次查看秒开）">📖 看题</button>
          <a class="job-link" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">✍️ 去刷题</a>
          <button class="job-btn oj-done" data-key="${esc(p.bm_no)}" data-title="${esc(p.title)}" data-cat="${esc(p.category)}" title="刷完了，标记进度（计入闭环统计/建议）">✅ 刷过</button>
        </div>
      </div>`).join("");
    // ✅ 刷过：标记进度（闭环：刷题计入统计与建议）
    document.querySelectorAll(".oj-done").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "⏳ …";
        try {
          const res = await fetch("http://127.0.0.1:8899/api/oj/mark-done", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bm_no: btn.dataset.key, title: btn.dataset.title, category: btn.dataset.cat }),
          });
          const j = await res.json();
          if (j.ok) {
            btn.textContent = `✅ 已刷 ${j.done} 题`;
            window.kanban.notify("💻 刷题", `已记录，累计刷完 ${j.done} 题`);
          } else {
            btn.textContent = "✅ 刷过";
            window.kanban.notify("💻 刷题", String(j.error || "记录失败").slice(0, 60));
          }
        } catch (e) {
          btn.textContent = "✅ 刷过";
          window.kanban.notify("💻 刷题", String(e.message || e).slice(0, 60));
        } finally {
          btn.disabled = false;
        }
      });
    });
    // 看题：懒加载题目内容 → 内联展开（本地缓存）
    document.querySelectorAll(".oj-view").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = btn.closest(".job-item");
        const body = item.querySelector(".oj-body");
        if (body) { body.remove(); return; } // 再点收起
        btn.disabled = true;
        btn.textContent = "⏳ 加载中…";
        try {
          const res = await fetch("http://127.0.0.1:8899/api/oj/detail?url=" + encodeURIComponent(btn.dataset.url));
          const j = await res.json();
          if (!j.ok) { alert("⚠️ " + (j.error || "抓取失败")); return; }
          const samples = (() => { try { return JSON.parse(j.samples || "[]"); } catch { return []; } })();
          const div = document.createElement("div");
          div.className = "oj-body";
          div.style.cssText = "padding:10px;margin:8px 0;background:rgba(109,79,216,.06);border:1px solid rgba(109,79,216,.18);border-radius:8px;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all;";
          let html = `<div style="color:#5d48b8;font-weight:bold;margin-bottom:4px;">📖 ${esc(btn.dataset.title)}${j.cached ? ' <span style="color:#8a87a8;font-weight:normal;">(本地缓存)</span>' : ""}</div>`;
          if (j.meta) html += `<div style="color:#8a87a8;margin-bottom:6px;">${esc(j.meta)}</div>`;
          html += `<div>${esc(j.content || "")}</div>`;
          if (samples.length) {
            html += `<div style="margin-top:8px;font-weight:bold;color:#5d48b8;">示例</div>`;
            for (const s of samples) {
              html += `<div style="margin:4px 0;">【${esc(s.title)}】`;
              if (s.input) html += `<div style="color:#3a8d5a;">输入：${esc(s.input)}</div>`;
              if (s.output) html += `<div style="color:#b07020;">输出：${esc(s.output)}</div>`;
              if (s.note) html += `<div style="color:#8a87a8;">说明：${esc(s.note)}</div>`;
              html += `</div>`;
            }
          }
          html += `<div style="margin-top:8px;color:#8a87a8;font-size:11px;">看题不消耗牛客额度；去牛客在线答题可自测运行。</div>`;
          div.innerHTML = html;
          item.appendChild(div);
        } catch (e) { alert("⚠️ " + e.message); }
        finally { btn.disabled = false; btn.textContent = "📖 看题"; }
      });
    });
  } catch (e) {
    $("oj-status").textContent = "⚠️ " + e.message;
  }
}

// ============ 手写/算法题库（ai-career 本地判题闭环） ============
let challengeCat = "";
let challengeDiff = 0;

const DIFF_LABEL = { 1: ["简单", "#3a8d5a"], 2: ["中等", "#b07020"], 3: ["困难", "#c93a3f"] };
const freqStars = (n) => "🔥".repeat(Math.max(0, Math.min(3, Number(n) || 0)));

async function loadChallenges() {
  try {
    const qs = new URLSearchParams();
    if (challengeCat) qs.set("category", challengeCat);
    if (challengeDiff) qs.set("difficulty", String(challengeDiff));
    const res = await fetch("http://127.0.0.1:8899/api/challenges?" + qs.toString());
    const j = await res.json();
    const statusEl = $("challenge-status");
    const cats = $("challenge-cats");
    const list = $("challenge-list");
    if (!j.challenges?.length) {
      statusEl.textContent = "题库为空——运行 scripts/import-ai-career.mjs 导入（D:\\ai-career 的 91 道题）";
      cats.innerHTML = "";
      list.innerHTML = "";
      return;
    }
    const done = j.done || 0;
    const pct = j.total ? Math.round(done / j.total * 100) : 0;
    statusEl.innerHTML = `📦 共 ${j.total} 道 · 已完成 ${done}（${pct}%）· 本地沙箱判题，无需登录
      <span class="mini-progress" style="margin:6px 0 0;">
        <span class="track"><i style="width:${pct}%"></i></span>
        <b>${done}/${j.total}</b>
      </span>`;
    // 筛选 chips：分类 + 难度
    cats.innerHTML = `<button class="oj-cat-chip" data-cat="" data-diff="0" style="${!challengeCat && !challengeDiff ? activeChip : ""}">全部</button>` +
      `<button class="oj-cat-chip" data-cat="handwrite" data-diff="0" style="${challengeCat === "handwrite" && !challengeDiff ? activeChip : ""}">✍️ 手写</button>` +
      `<button class="oj-cat-chip" data-cat="algorithm" data-diff="0" style="${challengeCat === "algorithm" && !challengeDiff ? activeChip : ""}">🧮 算法</button>` +
      `<button class="oj-cat-chip" data-cat="${esc(challengeCat)}" data-diff="1" style="${challengeDiff === 1 ? activeChip : ""}">简单</button>` +
      `<button class="oj-cat-chip" data-cat="${esc(challengeCat)}" data-diff="2" style="${challengeDiff === 2 ? activeChip : ""}">中等</button>` +
      `<button class="oj-cat-chip" data-cat="${esc(challengeCat)}" data-diff="3" style="${challengeDiff === 3 ? activeChip : ""}">困难</button>`;
    document.querySelectorAll("#challenge-cats .oj-cat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        challengeCat = btn.dataset.cat;
        challengeDiff = Number(btn.dataset.diff || 0);
        loadChallenges();
      });
    });
    // 题目列表（未做的在前，按频率/难度排序）
    const sorted = [...j.challenges].sort((a, b) =>
      (a.done - b.done) || (b.frequency - a.frequency) || (a.difficulty - b.difficulty));
    list.innerHTML = sorted.map((p) => {
      const [dl, dc] = DIFF_LABEL[p.difficulty] || ["难度" + p.difficulty, "#8a87a8"];
      const wrong = p.wrongCount > 0 ? `<span style="color:#c93a3f;">答错 ${p.wrongCount} 次</span>` : "";
      return `
      <div class="job-item" id="ch-${esc(p.id)}">
        <div class="job-head">
          <span class="job-badge" style="background:${p.category === "handwrite" ? "rgba(58,141,90,.12)" : "rgba(109,79,216,.12)"};color:${p.category === "handwrite" ? "#2f7d4e" : "#5d48b8"};">${p.category === "handwrite" ? "✍️手写" : "🧮算法"}</span>
          <span style="color:${dc};font-size:11px;">${dl}</span>
          <span style="font-size:11px;" title="面试出现频率">${freqStars(p.frequency)}</span>
          <span class="job-title">${esc(p.title)}</span>
          ${p.done ? '<span style="color:#3a8d5a;font-size:11px;">✅ 已做</span>' : ""}
          ${wrong}
        </div>
        <div class="job-actions">
          <button class="job-btn ch-practice" data-id="${esc(p.id)}" title="内联编辑器写代码，本地沙箱跑测试">✍️ 做题</button>
          ${p.done ? "" : `<button class="job-btn ch-done" data-id="${esc(p.id)}" title="已掌握（本地直接标记，计入学习进度）">✅ 已会</button>`}
          ${p.done ? "" : `<button class="job-btn ch-wrong" data-id="${esc(p.id)}" title="做错了（记入薄弱点，复习阶段优先补）">❌ 不会</button>`}
        </div>
      </div>`;
    }).join("");
    // ✍️ 做题：内联展开编辑器（骨架预填，本地判题）
    document.querySelectorAll(".ch-practice").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = btn.closest(".job-item");
        const box = item.querySelector(".ch-editor");
        if (box) { box.remove(); btn.textContent = "✍️ 做题"; return; }
        btn.disabled = true;
        btn.textContent = "⏳ 加载…";
        try {
          const res = await fetch("http://127.0.0.1:8899/api/challenges/detail?id=" + encodeURIComponent(btn.dataset.id));
          const j = await res.json();
          if (!j.ok) { alert("⚠️ " + (j.error || "加载失败")); return; }
          const c = j.challenge;
          const div = document.createElement("div");
          div.className = "ch-editor";
          div.style.cssText = "padding:10px;margin:8px 0;background:rgba(109,79,216,.05);border:1px solid rgba(109,79,216,.2);border-radius:8px;font-size:12px;line-height:1.6;";
          div.innerHTML = `
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
              <b style="color:#5d48b8;">${esc(c.title)}</b>
              <span style="color:#8a87a8;">（${c.category === "handwrite" ? "手写" : "算法"} · ${(DIFF_LABEL[c.difficulty] || ["", ""])[0]} · 建议 ${c.timeLimit || 10} 分钟内）</span>
              <span style="flex:1;"></span>
              <button class="job-btn ch-editor-close" style="padding:3px 8px;">✖</button>
            </div>
            <div style="color:#444;white-space:pre-wrap;margin-bottom:8px;max-height:140px;overflow:auto;">${esc(c.description)}</div>
            <textarea spellcheck="false" style="width:100%;min-height:160px;font-family:Consolas,Menlo,monospace;font-size:12px;padding:8px;border:1px solid rgba(109,79,216,.3);border-radius:6px;background:#faf9ff;color:#333;resize:vertical;box-sizing:border-box;">${esc(c.skeleton)}</textarea>
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
              <button class="job-btn ch-editor-run" style="background:linear-gradient(135deg,#8a5adc,#6d4fd8);color:#fff;">▶ 运行判题</button>
              <button class="job-btn ch-editor-mark" data-id="${esc(c.id)}" style="display:none;background:linear-gradient(135deg,#3a8d5a,#2f7d4e);color:#fff;">✅ 全部通过，标记完成</button>
              <span class="ch-editor-state" style="align-self:center;font-size:12px;"></span>
            </div>
            <pre class="ch-editor-result" style="display:none;margin-top:8px;padding:8px;background:#1e1e2e;color:#cdd6f4;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;"></pre>`;
          item.appendChild(div);
          btn.textContent = "✍️ 做题";
          const ta = div.querySelector("textarea");
          const stateEl = div.querySelector(".ch-editor-state");
          const resultEl = div.querySelector(".ch-editor-result");
          const runBtn = div.querySelector(".ch-editor-run");
          const markBtn = div.querySelector(".ch-editor-mark");
          const run = async () => {
            if (!ta.value.trim()) { stateEl.textContent = "⚠️ 先写代码"; return; }
            runBtn.disabled = true;
            runBtn.textContent = "⏳ 判题中…";
            resultEl.style.display = "none";
            markBtn.style.display = "none";
            try {
              const r = await fetch("http://127.0.0.1:8899/api/challenges/run", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: btn.dataset.id, userCode: ta.value }),
              });
              const j = await r.json();
              const pass = j.ok && j.success;
              const lines = [];
              lines.push(pass ? "🎉 全部通过 ✅" : "❌ 有测试未通过");
              lines.push(`⏱ ${j.durationMs} ms · ${(j.tests || []).length} 个测试`);
              for (const t of (j.tests || [])) lines.push(`${t.passed ? "✅" : "❌"} ${t.label}`);
              if (j.error) lines.push("⚠️ " + j.error);
              if ((j.logs || []).length) { lines.push("— console —"); for (const l of j.logs) lines.push(l); }
              resultEl.textContent = lines.join("\n");
              resultEl.style.display = "block";
              if (pass) {
                stateEl.textContent = "✅ 通过！点「标记完成」计入闭环（学习进度 + 题库进度）";
                markBtn.style.display = "inline-block";
              } else {
                stateEl.textContent = "❌ 未通过——可继续改代码重跑，或点列表里的「❌ 不会」记入薄弱点";
              }
            } catch (e) {
              stateEl.textContent = "⚠️ " + e.message;
            } finally {
              runBtn.disabled = false;
              runBtn.textContent = "▶ 运行判题";
            }
          };
          runBtn.addEventListener("click", run);
          ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } });
          div.querySelector(".ch-editor-close").addEventListener("click", () => { div.remove(); btn.textContent = "✍️ 做题"; });
          markBtn.addEventListener("click", async () => {
            try {
              const r = await fetch("http://127.0.0.1:8899/api/challenges/mark-done", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: markBtn.dataset.id }),
              });
              const j = await r.json();
              window.kanban.notify("✍️ 手写题", j.ok ? `「${j.title}」已标记完成，进度 +1` : String(j.error || "标记失败").slice(0, 60));
              div.remove();
              btn.textContent = "✍️ 做题";
              loadChallenges();
            } catch (e) { stateEl.textContent = "⚠️ " + e.message; }
          });
        } catch (e) { alert("⚠️ " + e.message); }
        finally { btn.disabled = false; btn.textContent = "✍️ 做题"; }
      });
    });
    // ✅ 已会 / ❌ 不会：闭环回流
    const bindMark = (sel, api, okText) => {
      document.querySelectorAll(sel).forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            const r = await fetch("http://127.0.0.1:8899/api/challenges/" + api, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: btn.dataset.id }),
            });
            const j = await r.json();
            window.kanban.notify("✍️ 手写题", j.ok ? `「${j.title}」${okText}` : String(j.error || "操作失败").slice(0, 60));
            loadChallenges();
          } catch (e) {
            window.kanban.notify("✍️ 手写题", String(e.message || e).slice(0, 60));
            btn.disabled = false;
          }
        });
      });
    };
    bindMark(".ch-done", "mark-done", "已记录，计入学习进度");
    bindMark(".ch-wrong", "mark-wrong", "已记入薄弱点，复习阶段优先补");
  } catch (e) {
    $("challenge-status").textContent = "⚠️ " + e.message;
  }
}

$("challenge-refresh-btn")?.addEventListener("click", () => {
  challengeCat = "";
  challengeDiff = 0;
  loadChallenges();
});

const activeChip = "background:linear-gradient(135deg,#8a5adc,#6d4fd8);color:#fff;";
function diffColor(d) {
  if (!d) return "#8a87a8";
  if (d.includes("入门")) return "#3a8d5a";
  if (d.includes("简单")) return "#3a8d5a";
  if (d.includes("中等")) return "#b07020";
  return "#c93a3f";
}

$("oj-collect-btn")?.addEventListener("click", async () => {
  const btn = $("oj-collect-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 更新题库中（约 10s）…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/oj/collect", { method: "POST" });
    const j = await res.json();
    $("oj-status").textContent = j.ok ? `✅ 更新完成：共 ${j.total} 道（新增 ${j.added}，更新 ${j.updated}）` : "⚠️ " + (j.error || "更新失败");
    loadOj();
  } catch (e) {
    $("oj-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 更新题库";
  }
});

// 全部下载：SSE 进度流（101 道题干/示例落本地，串行防反爬）
$("oj-download-btn")?.addEventListener("click", async () => {
  const btn = $("oj-download-btn");
  const status = $("oj-status");
  btn.disabled = true;
  btn.textContent = "⬇️ 下载中…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/oj/collect-all-stream");
    if (!res.ok || !res.body) throw new Error("下载流启动失败");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of evt.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.type === "progress") {
              status.textContent = `⬇️ 正在下载 ${j.done}/${j.total}：${esc(j.title || "")}`;
            } else if (j.type === "done") {
              status.textContent = j.allCached
                ? "✅ 全部题目已在本地缓存"
                : `✅ 下载完成：${j.done}/${j.total} 道（失败 ${j.failed}）——离线可看`;
              loadOj();
            } else if (j.type === "error") {
              status.textContent = "⚠️ " + (j.error || "下载失败");
            }
          } catch { /* ignore */ }
        }
      }
    }
  } catch (e) {
    status.textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇️ 全部下载";
  }
});

$("zhenti-collect-btn")?.addEventListener("click", async () => {
  const btn = $("zhenti-collect-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 搜集真题中（约 10s）…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/zhenti/collect", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await res.json();
    $("zhenti-status").textContent = j.message || "完成";
    loadZhenti();
  } catch (e) {
    $("zhenti-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 搜集真题";
  }
});

$("zhenti-details-btn")?.addEventListener("click", async () => {
  const btn = $("zhenti-details-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 抓题型分布中（约 1 分钟）…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/zhenti/collect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ details: 20 }),
    });
    const j = await res.json();
    $("zhenti-status").textContent = `${j.message || "完成"} · 题型 ${(j.details || []).length} 套`;
    loadZhenti();
  } catch (e) {
    $("zhenti-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "📊 抓题型分布";
  }
});

// 保存牛客 Cookie
$("zhenti-cookie-btn")?.addEventListener("click", async () => {
  const cookie = $("zhenti-cookie").value.trim();
  if (!cookie) { alert("请先粘贴 Cookie"); return; }
  try {
    const res = await fetch("http://127.0.0.1:8899/api/zhenti/cookie", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie }),
    });
    const j = await res.json();
    alert(j.ok ? `✅ Cookie 已保存（${j.count} 个字段）——真题项点「📖 抓题目」抓完整题干` : "⚠️ " + (j.error || "保存失败"));
  } catch (e) { alert("⚠️ " + e.message); }
});

// ============ 语音输入（🎤）：本地 whisper 转写 → 回填输入框 ============
// 点击开始录音（16kHz 单声道，浏览器自动重采样）→ 再点停止 → IPC 送主进程转写
let micStream = null, micCtx = null, micSource = null, micProc = null;
let micChunks = [], micRecording = false, micAutoStop = null;

async function stopRecording() {
  micRecording = false;
  clearTimeout(micAutoStop);
  const micBtn = $("chat-mic");
  micBtn.classList.remove("recording");
  micBtn.textContent = "🎤";
  micBtn.title = "语音输入（点击开始录音，再点停止；识别结果回填输入框）";
  try { micSource?.disconnect(); micProc?.disconnect(); } catch { /* ignore */ }
  try { micCtx?.close(); } catch { /* ignore */ }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (!micChunks.length) return;
  // 拼接 PCM → IPC 转写（首次会下载 whisper 模型 ~250MB，可能需 1-2 分钟）
  const total = micChunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const c of micChunks) { pcm.set(c, off); off += c.length; }
  micChunks = [];
  micBtn.textContent = "⏳";
  micBtn.disabled = true;
  try {
    const r = await window.kanban.speechToText(pcm);
    if (r?.ok && r.text) {
      $("chat-input").value = r.text;
      $("chat-input").focus();
    } else {
      window.kanban.notify("语音输入", r?.error || "识别失败，请重试");
    }
  } catch (err) {
    window.kanban.notify("语音输入", "调用失败: " + String(err?.message || err).slice(0, 80));
  } finally {
    micBtn.disabled = false;
    micBtn.textContent = "🎤";
  }
}

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (err) {
    window.kanban.notify("语音输入", "麦克风不可用: " + (err?.name || "请检查系统麦克风权限"));
    return;
  }
  micChunks = [];
  micCtx = new AudioContext({ sampleRate: 16000 }); // 16k（whisper 期望采样率，浏览器自动重采样）
  micSource = micCtx.createMediaStreamSource(micStream);
  micProc = micCtx.createScriptProcessor(4096, 1, 1);
  micProc.onaudioprocess = (e) => {
    if (!micRecording) return;
    micChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  micSource.connect(micProc);
  micProc.connect(micCtx.destination);
  micRecording = true;
  const micBtn = $("chat-mic");
  micBtn.classList.add("recording");
  micBtn.textContent = "⏹";
  micBtn.title = "点击停止录音";
  micAutoStop = setTimeout(() => { if (micRecording) stopRecording(); }, 60000); // 60s 上限自动停
}

$("chat-mic").addEventListener("click", () => { micRecording ? stopRecording() : startRecording(); });

// ============ 专注监督（番茄钟） ============
let focusPollTimer = null;

async function loadFocus() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/focus/status");
    const j = await r.json();
    renderFocus(j);
    // 专注中每秒刷新倒计时；空闲时停止轮询
    if (j.active && !focusPollTimer) {
      focusPollTimer = setInterval(loadFocus, 1000);
    } else if (!j.active && focusPollTimer) {
      clearInterval(focusPollTimer);
      focusPollTimer = null;
    }
  } catch (e) {
    $("focus-status").textContent = "⚠️ " + e.message;
  }
}

function fmtCountdown(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderFocus(j) {
  const status = $("focus-status");
  const cd = $("focus-countdown");
  const stopBtn = $("focus-stop");
  const skipBtn = $("focus-skip-rest");
  const phase = j.phase || (j.active ? "focusing" : "idle");
  const goalText = j.goal ? ` · 🎯 ${j.goal}` : "";
  if (phase === "focusing") {
    status.textContent = `🍅 专注中（${j.mode} 分钟）${goalText} · 已分心 ${j.distracts ?? 0} 次`;
    cd.classList.remove("hidden");
    cd.textContent = "⏳ " + fmtCountdown(j.remainingSeconds ?? 0);
    stopBtn.hidden = false;
    stopBtn.textContent = "⏹ 结束专注";
    skipBtn.hidden = true;
  } else if (phase === "resting") {
    status.textContent = `☕ 休息中${goalText ? `（刚完成：${j.goal}）` : ""} · 休息结束后可开始下一轮`;
    cd.classList.remove("hidden");
    cd.textContent = "⏳ 休息 " + fmtCountdown(j.remainingSeconds ?? 0);
    stopBtn.hidden = false;
    stopBtn.textContent = "⏹ 结束休息";
    skipBtn.hidden = false;
  } else {
    status.textContent = j.lastGoal && j.restDone ? `✅ 上一轮完成（${j.lastGoal || "无目标"}）——休息好了，开始下一轮？` : "未开始专注";
    cd.classList.add("hidden");
    cd.textContent = "";
    stopBtn.hidden = true;
    skipBtn.hidden = true;
  }
  $("focus-stats-row").innerHTML = `
    <div class="stat-chip">⏱️ 今日专注 <b>${j.todayMinutes ?? 0}</b> 分钟</div>
    <div class="stat-chip">✅ 完成 <b>${j.todayCount ?? 0}</b> 次</div>
    <div class="stat-chip">🚫 分心 <b>${j.todayDistracts ?? 0}</b> 次</div>
    <div class="stat-chip">🔥 连续 <b>${j.streak ?? 0}</b> 天</div>`;
  // 近 7 天柱状（分钟标签 + 星期 + 今日高亮）
  const weekBox = $("focus-week");
  if (weekBox && Array.isArray(j.week) && j.week.length) {
    const max = Math.max(...j.week.map((d) => d.minutes), 1);
    const todayStr = new Date().toISOString().slice(0, 10);
    const dayLabel = (d) => {
      const n = new Date(d.date + "T00:00:00").getDay();
      return ["日", "一", "二", "三", "四", "五", "六"][n] || d.date.slice(5);
    };
    weekBox.classList.remove("hidden");
    weekBox.innerHTML = "近 7 天专注： " + j.week.map((d) => {
      const h = Math.max(3, Math.round((d.minutes / max) * 36));
      const isToday = d.date === todayStr;
      return `<span title="${d.date} · ${d.minutes} 分钟" style="display:inline-block;margin:0 3px;text-align:center;">
        <span style="display:block;font-size:9px;color:${d.minutes ? "#8a87a8" : "#c4c1d8"};">${d.minutes || ""}</span>
        <span style="display:block;width:18px;height:${h}px;background:${d.minutes ? "linear-gradient(180deg,#8a5adc,#5a3d9e)" : "rgba(109,79,216,.1)"};border-radius:3px;${isToday ? "outline:1.5px solid #8a5adc;outline-offset:1px;" : ""}"></span>
        <span style="font-size:9px;color:${isToday ? "#8a5adc" : "#8a87a8"};font-weight:${isToday ? "700" : "400"};">${dayLabel(d)}</span></span>`;
    }).join("");
  }
}

async function focusStart(mode) {
  try {
    const goal = $("focus-goal").value.trim();
    const res = await fetch("http://127.0.0.1:8899/api/focus/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, goal }),
    });
    const j = await res.json();
    if (!j.ok) { $("focus-status").textContent = "⚠️ " + (j.error || "开始失败"); return; }
    $("focus-goal").value = "";
    if (j.goal) window.kanban.notify("🍅 专注开始", `本次目标：${j.goal}`);
    loadFocus();
  } catch (e) { $("focus-status").textContent = "⚠️ " + e.message; }
}

async function focusStop() {
  try {
    const res = await fetch("http://127.0.0.1:8899/api/focus/stop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: false }), // 手动结束 = 中断（未完成）；休息中调用 = 结束休息
    });
    const j = await res.json();
    if (j?.ok) {
      if (j.phase === "resting") window.kanban.notify("⏱️ 专注", "休息已结束，可以开始下一轮");
      else window.kanban.notify("⏱️ 专注", `已结束，本次专注 ${j.durationMinutes} 分钟`);
    }
    loadFocus();
  } catch (e) { $("focus-status").textContent = "⚠️ " + e.message; }
}

$("focus-25").addEventListener("click", () => focusStart("25"));
$("focus-45").addEventListener("click", () => focusStart("45"));
$("focus-stop").addEventListener("click", focusStop);
$("focus-skip-rest").addEventListener("click", focusStop); // 跳过休息 = 结束休息

// 🎯 专注目标推荐（闭环联动：到期复习卡/薄弱点/清单未完成 → 点击填入）
async function loadFocusGoalSuggest() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/focus/goal-suggest");
    const j = await r.json();
    if (!j?.ok || !Array.isArray(j.goals) || !j.goals.length) return;
    const input = $("focus-goal");
    if (!input) return;
    const box = document.createElement("div");
    box.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;";
    box.innerHTML = '<span style="font-size:11px;color:#8a87a8;align-self:center;">🎯 推荐：</span>' + j.goals.map((g) => `
      <button class="job-btn" data-topic="${esc(g.topic)}" title="点击填入目标">${esc(g.text)}</button>`).join("");
    box.querySelectorAll("button[data-topic]").forEach((btn) => {
      btn.addEventListener("click", () => { input.value = btn.dataset.topic; input.focus(); });
    });
    input.parentElement.appendChild(box);
  } catch { /* ignore */ }
}
loadFocusGoalSuggest();
setInterval(loadFocusGoalSuggest, 60 * 1000); // 每分钟刷新推荐（清单/复习变化后更新）

// 分心黑名单/白名单编辑（清单 Tab 的「🚫 名单」→ 跳设置 Tab；设置 Tab 内直接编辑）
$("focus-blacklist-toggle")?.addEventListener("click", () => {
  switchTab("settings");
  setTimeout(() => {
    const el = $("focus-blacklist");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    loadFocusBlacklist();
  }, 300);
});

async function loadFocusBlacklist() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/focus/blacklist");
    const j = await r.json();
    $("focus-blacklist").value = (j.blacklist || []).join("\n");
    $("focus-whitelist").value = (j.whitelist || []).join("\n");
  } catch { /* ignore */ }
}

async function saveFocusBlacklist(list, whitelist) {
  try {
    const res = await fetch("http://127.0.0.1:8899/api/focus/blacklist", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blacklist: list, whitelist }),
    });
    const j = await res.json();
    if (j.ok) { window.kanban.notify("🚫 分心名单", "已保存"); loadFocusBlacklist(); }
    else $("focus-status").textContent = "⚠️ " + (j.error || "保存失败");
  } catch (e) { $("focus-status").textContent = "⚠️ " + e.message; }
}

$("focus-blacklist-save").addEventListener("click", () => {
  const list = $("focus-blacklist").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const whitelist = $("focus-whitelist").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  saveFocusBlacklist(list, whitelist);
});

$("focus-blacklist-reset").addEventListener("click", async () => {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/focus/blacklist");
    const j = await r.json();
    const defaults = Array.isArray(j.defaults) ? j.defaults : [];
    $("focus-blacklist").value = defaults.join("\n");
    $("focus-whitelist").value = "";
    saveFocusBlacklist(defaults, []); // 重置：黑名单回默认，白名单清空
  } catch (e) { $("focus-status").textContent = "⚠️ " + e.message; }
});

// ============ 日程（面试邀约识别 + 提醒） ============
function fmtEventTime(ts) {
  if (!ts) return "时间待定";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "时间待定";
  return d.toLocaleString("zh-CN", { hour12: false });
}

async function loadSchedule() {
  const statusEl = $("mail-status");
  const list = $("schedule-list");
  try {
    // 配置（脱敏，只回邮箱与是否已配置）+ 日程列表
    const [cfgRes, schedRes] = await Promise.all([
      fetch("http://127.0.0.1:8899/api/mail/config"),
      fetch("http://127.0.0.1:8899/api/schedule"),
    ]);
    const cfgJ = await cfgRes.json();
    const schedJ = await schedRes.json();
    const events = schedJ.events || [];
    statusEl.textContent = cfgJ.config?.configured
      ? `✅ 邮箱已配置：${cfgJ.config.email} · 未来日程 ${events.length} 条（配置在「⚙️ 设置」）`
      : "未配置邮箱——去「⚙️ 设置」填写邮箱与授权码，桌宠自动识别面试/笔试邀约并提前提醒";
    if (!events.length) {
      list.innerHTML = '<div class="empty-hint">暂无未来的面试/笔试邀约，点「📥 立即检查」从邮箱识别</div>';
      return;
    }
    // 按紧迫度分组：48h 内最急 → 本周 → 更远
    const now = Date.now();
    const H = 3600 * 1000, D = 24 * H;
    const groups = [
      { key: "urgent", label: "⏰ 48 小时内（最急）", items: [] },
      { key: "week", label: "📅 本周", items: [] },
      { key: "later", label: "🗓 更远", items: [] },
    ];
    for (const ev of events) {
      const at = Number(ev.interviewAt) || 0;
      if (at && at - now <= 48 * H) groups[0].items.push(ev);
      else if (at && at - now <= 7 * D) groups[1].items.push(ev);
      else groups[2].items.push(ev);
    }
    const relTime = (at) => {
      if (!at) return "";
      const diff = at - now;
      if (diff <= 48 * H) return ` · <span style="color:#c05050;font-weight:700;">${diff <= H ? "即将开始" : Math.max(1, Math.round(diff / H)) + " 小时后"}</span>`;
      if (diff <= 7 * D) return ` · <span style="color:#b07020;font-weight:600;">${Math.max(1, Math.round(diff / D))} 天后</span>`;
      return ` · ${Math.round(diff / D)} 天后`;
    };
    list.innerHTML = groups.filter((g) => g.items.length).map((g) => `
      <div class="study-state-group">
        <div class="study-state-head ${g.key === "urgent" ? "lv-adv" : ""}">${g.label} <span class="sg-count">${g.items.length}</span></div>
        ${g.items.map((ev) => `
          <div class="job-item" style="margin-bottom:6px;">
            <div class="job-head">
              <b style="font-size:12px;">${esc(ev.company)}${ev.role ? " · " + esc(ev.role) : ""}</b>
              ${ev.form ? `<span class="job-badge">${esc(ev.form)}</span>` : ""}
            </div>
            <div class="job-meta">🕐 ${esc(fmtEventTime(ev.interviewAt))}${relTime(Number(ev.interviewAt))}${ev.location ? " · 📍 " + esc(ev.location) : ""}</div>
            <div class="job-actions">
              ${ev.link ? `<a class="job-link" href="${esc(safeUrl(ev.link))}" target="_blank" rel="noopener">🔗 会议/链接</a>` : ""}
            </div>
          </div>`).join("")}
      </div>`).join("");
  } catch (e) {
    statusEl.textContent = "⚠️ " + e.message;
    list.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

// 邮箱配置/测试在「⚙️ 设置」（set-mail-*）；校招 Tab 提供「立即检查」快捷入口
$("mail-check-btn")?.addEventListener("click", async () => {
  const btn = $("mail-check-btn");
  const statusEl = $("mail-status");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "⏳ 检查中…";
  statusEl.textContent = "正在拉取未读邮件并 AI 识别邀约…";
  try {
    const res = await fetch("http://127.0.0.1:8899/api/mail/check", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const j = await res.json();
    if (j.ok) statusEl.textContent = `✅ 检查 ${j.emails} 封，新增 ${j.added} 条日程`;
    else statusEl.textContent = "⚠️ " + (j.error || "检查失败");
  } catch (e) {
    statusEl.textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "📥 立即检查";
    loadSchedule();
  }
});

// ============ 对话历史恢复（面板刷新后可见，会话可续） ============
async function loadChatHistory() {
  try {
    const r = await window.kanban.chatHistory();
    if (r?.ok && Array.isArray(r.history) && r.history.length) {
      const log = $("chat-log");
      log.innerHTML = ""; // 清空占位，按历史重建
      for (const m of r.history) {
        addChatMsg(m.role === "user" ? "user" : "bot", m.content);
      }
      // 同步上下文：后续对话延续历史（role 还原为 agent 侧 user/assistant 格式）
      chatHistory = r.history.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      }));
    }
  } catch { /* widget 未启动/无历史时忽略 */ }
}

// ============ 初始化 ============
loadCrawlData();
checkServiceVersion(); // 检测后台服务是否旧版（防"改完不生效"）
loadChatHistory(); // 恢复最近对话（刷新不丢）
loadMascotModels(); // 桌宠形象列表
loadLoopBar(); // 全局闭环状态条（顶栏下，所有 Tab 可见）
setInterval(loadLoopBar, 60 * 1000); // 状态条自动刷新
loadStudyPlan();
loadJobs(); // 校招推荐列表
loadLoop(); // 闭环状态（方向/学习/岗位/面试多向驱动）
loadPlatforms(); // 平台账号（BOSS 等）
loadDocs(); // 官方文档清单
loadDocsProject(); // 项目 package.json 路径（版本对比）
loadRss(); // 今日技术资讯
loadProfileStatus(); // 个人主页存档状态
loadKbStats(); // 知识库统计
loadZhenti(); // 笔试真题
loadOj(); // 专项练习 TOP101
loadChallenges(); // 手写/算法题库（本地判题闭环）
// 轮询爬取进度
setInterval(loadCrawlData, 5000);
// 轮询审批请求（agent 请求敏感操作时弹出确认条）
setInterval(checkApprovals, 2000);
// 轮询提问（agent 的 ask_user / plan_mode 等待点选）
setInterval(checkAsks, 2000);
// 轮询任务清单（agent todo 进度）
setInterval(loadTodo, 3000);
