// 真白面板 · 学习/复习/面试域（纵向拆分）
/* exported loadIvResumeAuto, loadIvWeakChips */
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
    const profileRes = await fetch(API_BASE + "/api/jobs/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume }),
    });
    const profileJ = await profileRes.json();
    // 2) 简历项目 → 学习清单
    const res = await fetch(API_BASE + "/api/resume-plan", {
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
      el.style.color = ivRoundSeconds > 180 ? "#c05050" : ivRoundSeconds > 90 ? "#9a5b00" : "";
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

// 闭环：面试简历自动联动设置中心已上传的简历（iv-resume 留空时预填，不用重复粘贴）
async function loadIvResumeAuto() {
  try {
    const r = await fetch(API_BASE + "/api/jobs/profile");
    const j = await r.json();
    const statusEl = $("resume-status");
    if (j.rawSaved && j.rawText) {
      if (!$("iv-resume").value.trim()) $("iv-resume").value = j.rawText;
      statusEl.textContent = $("iv-resume").value.trim()
        ? "✅ 已自动使用设置里上传的简历（可修改；清空则面试官仍会用设置里的简历）"
        : "✅ 设置里有简历，面试官会自动使用";
    } else {
      statusEl.textContent = "📭 设置里还没上传简历——可在此粘贴，或去「⚙️ 设置」上传（上传后全链路复用：岗位匹配/面试拷打/投递招呼语）";
    }
  } catch { /* ignore */ }
}

// 启动面试会话（iv-start 按钮 + 复习检验共用）：成功即切到面试中形态
// 残留会话自愈：上一场面试没正常结束（关面板/杀进程等）→ 会话留在服务端内存，
// start 返回"已有一场面试进行中"→ 自动 end 收尾旧会话（生成复盘）再重新开始，用户无感
async function startIvSession(cfg) {
  $("iv-start").disabled = true;
  $("iv-start").textContent = "⏳ 面试官准备中...";
  try {
    let r = await window.kanban.invStart(cfg);
    if (r.error && /进行中/.test(r.error)) {
      $("iv-status").textContent = "检测到上一场未结束的面试，正在收尾并重新开始…";
      const end = await window.kanban.invEnd();
      if (end?.ok) r = await window.kanban.invStart(cfg); // 旧会话已清，重试
    }
    if (r.error) { alert("启动失败: " + r.error); return; }
    showInterviewUi(r);
  } finally {
    $("iv-start").disabled = false;
    $("iv-start").textContent = "🎤 开始模拟面试";
  }
}

// ============ 进行中会话"继续上一场"（C8 恢复闭环 + 关面板不丢进度） ============
// 进入面试 Tab 时检测服务端进行中会话 → 显示"🔄 继续上一场"按钮（无缝续，不用收尾重开）
async function loadIvResume() {
  const btn = $("iv-resume");
  if (!btn) return;
  try {
    const r = await window.kanban.invStatus();
    if (r?.ok && r.active) {
      btn.classList.remove("hidden");
      btn.textContent = `🔄 继续上一场面试（第 ${r.round} 轮${r.roundsCount ? ` · 已完成 ${r.roundsCount} 轮` : ""}）`;
      btn.onclick = () => resumeIvSession(r);
    } else {
      btn.classList.add("hidden");
      btn.onclick = null;
    }
  } catch { btn.classList.add("hidden"); }
}

// 恢复面试中形态：用服务端会话状态直接渲染（与服务端内存会话对齐，无需重新 start）
// 注意顺序：showInterviewUi 内部会重置 ivScoreSum/ivScoreCount → 必须先渲染再恢复累计分
function resumeIvSession(status) {
  showInterviewUi({
    question: status.question, basis: status.basis, dimension: status.dimension,
    criteria: status.criteria, boundary: status.boundary,
    round: status.round, roundType: status.roundType, depth: status.depth,
    weakQueue: status.weakQueue || [], totalRounds: status.totalRounds,
  });
  // 已评分轮次 → 恢复全场均分累计（服务端镜像持续累计，逐轮增量写）
  ivScoreCount = Number(status.roundsCount) || 0;
  if (status.scoreSum) {
    ivScoreSum = { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0 };
    for (const k of Object.keys(ivScoreSum)) ivScoreSum[k] = Number(status.scoreSum[k]) || 0;
  }
  addIvLog(`↩️ 已恢复上一场面试（第 ${status.round} 轮${status.roundsCount ? `，此前已完成 ${status.roundsCount} 轮` : ""}）——录音/计时不跨进程保留，作答照常`);
}

// 面试中形态切换 + 首问渲染（startIvSession 与残留会话重试共用）
function showInterviewUi(r) {
  ivSetup.classList.add("hidden");
  ivSessionEl.classList.remove("hidden");
  $("iv-log").innerHTML = "";
  $("iv-review").classList.add("hidden");
  $("iv-review").textContent = "";
  $("iv-report-overlay")?.classList.add("hidden"); // 新面试开始 → 关闭复盘弹窗
  $("iv-summary").classList.add("hidden");
  $("iv-scores").innerHTML = "";
  $("iv-answer-area").style.display = "";
  ivTotalRounds = Number(r.totalRounds) || 9;
  ivScoreSum = { tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0 };
  ivScoreCount = 0;
  clearIvRecordings(); // 新面试开始 → 清理上一场录音（本场录音从 0 开始）
  showQuestion(r);
}

const IV_MAX_CHAIN = 6; // 同一追问点最大深挖次数（与服务端 MAX_DEPTH=6 一致，修复：原 3 vs 6 不一致）

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
  // 优先考察计划（开场轮展示一次）：自动聚合薄弱点/题库错题/复习错题/今日复习/清单
  let weakPlan = "";
  if (ivRound === 1 && Array.isArray(r.weakQueue) && r.weakQueue.length) {
    weakPlan = `<div class="iv-weak-plan">🎯 本次优先考察（自动聚合你的练习数据）：${r.weakQueue.slice(0, 8).map((w) => `${esc(w.topic)}${w.reason ? `<span style="opacity:.75">（${esc(w.reason)}）</span>` : ""}`).join("、")}</div>`;
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
      // 修复 P1-5：finished 分支必须有 catch——否则 invEnd 抛错时状态文案永久错误，
      // 且 isGeneratingReview 已在服务端复位，用户可重试（对齐 :396-425 iv-end 按钮的写法）
      try {
        const end = await window.kanban.invEnd();
        if (end?.ok && end.report) {
          renderIvSummary();
          showIvReport(end.report); // 毛玻璃弹窗展示复盘报告
          $("iv-status").textContent = "✅ 面试结束，复盘已生成";
          addIvLog(end.hint || "");
          // 薄弱点覆盖统计（录音保留：复盘时可回听）
          if (end.weakTotal > 0) {
            addIvLog(`🎯 本场薄弱点覆盖：${end.weakCovered ?? 0}/${end.weakTotal}${end.weakCoveredTopics?.length ? "（" + end.weakCoveredTopics.join("、") + "）" : ""}`);
          }
        } else {
          $("iv-status").textContent = "⚠️ " + (end?.error || "结束失败，请重试");
          window.kanban.notify("模拟面试", end?.error || "结束失败，请重试");
        }
      } catch (err) {
        $("iv-status").textContent = "⚠️ 复盘生成异常: " + String(err?.message || err).slice(0, 80);
        window.kanban.notify("模拟面试", "复盘生成异常: " + String(err?.message || err).slice(0, 80));
      }
      return;
    }
    showQuestion(r);
  } finally {
    $("iv-send").disabled = false;
    $("iv-send").textContent = "提交回答";
  }
}

// 复盘报告弹窗（复用毛玻璃 sd-modal；renderMd 全转义 + href 净化，LLM 输出安全）
function showIvReport(report) {
  const overlay = $("iv-report-overlay");
  $("iv-report-body").innerHTML = renderMd(report);
  overlay.classList.remove("hidden");
}
$("iv-report-close").addEventListener("click", () => $("iv-report-overlay").classList.add("hidden"));
$("iv-report-overlay").addEventListener("click", (e) => {
  if (e.target === $("iv-report-overlay")) $("iv-report-overlay").classList.add("hidden"); // 点遮罩关闭
});

// ============ 历史复盘回看（C6 闭环：复盘不只弹窗一次，模拟面试区随时可回看） ============
// 复用 /api/interview/history（preload interviewHistory）+ showIvReport（毛玻璃弹窗完整渲染 Markdown）
function fmtIvDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return ""; }
}

async function loadIvHistory() {
  const countEl = $("iv-history-count");
  const body = $("iv-history-body");
  try {
    const h = await window.kanban.interviewHistory();
    const list = (h?.history || []).slice().reverse(); // 新的在前
    if (countEl) countEl.textContent = String(list.length);
    if (!body) return;
    if (!list.length) {
      body.innerHTML = '<div style="color:#7c7c7c;font-size:12px">暂无面试记录——开始一场模拟面试后，复盘报告会保存在这里，随时可回看</div>';
      return;
    }
    body.innerHTML = list.map((it, i) => `
      <div class="iv-hist-item">
        <div class="iv-hist-head">${esc(it.position || "模拟面试")} · ${esc(it.role || "")} · ${it.rounds || 0} 轮
          <span class="iv-hist-score">均分 ${it.avg ?? it.avgScore ?? "-"}</span>
          ${it.report ? `<button class="iv-hist-open" data-i="${i}">查看复盘</button>` : ""}
        </div>
        <div style="font-size:11px;color:#6a6790">${fmtIvDate(it.date)}</div>
      </div>`).join("");
    body.querySelectorAll(".iv-hist-open").forEach((btn) => {
      btn.addEventListener("click", () => {
        const it = list[Number(btn.dataset.i)];
        if (it?.report) showIvReport(it.report); // 复用毛玻璃复盘弹窗（完整 Markdown 渲染，含目录）
      });
    });
  } catch { body.innerHTML = '<div style="color:#7c7c7c;font-size:12px">历史加载失败（服务未就绪）</div>'; }
}
$("iv-history-toggle").addEventListener("click", () => {
  const hidden = $("iv-history-body").classList.toggle("hidden");
  $("iv-history-toggle").textContent = `📜 历史复盘（${$("iv-history-count")?.textContent || "-"} 场）${hidden ? "▸" : "▾"}`;
  if (!hidden) loadIvHistory(); // 展开时刷新
});

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
    ${dims.map(([_k, l, v]) => scoreBarHtml(l, v)).join("")}
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
  // 反馈：复盘报告由 LLM 生成（最长 2 分钟超时），无反馈会看起来像卡死
  const endBtn = $("iv-end");
  const statusEl = $("iv-status");
  endBtn.disabled = true;
  endBtn.textContent = "⏳ 生成复盘报告…";
  if (statusEl) statusEl.textContent = "面试已结束，正在生成复盘报告（约 1-2 分钟，请耐心等待，勿重复点击）…";
  try {
    const end = await window.kanban.invEnd();
    if (end?.ok && end.report) {
      renderIvSummary();
      showIvReport(end.report); // 毛玻璃弹窗展示复盘报告
      $("iv-status").textContent = "面试已结束";
      addIvLog(end.hint || "");
      if (end.weakTotal > 0) {
        addIvLog(`🎯 本场薄弱点覆盖：${end.weakCovered ?? 0}/${end.weakTotal}${end.weakCoveredTopics?.length ? "（" + end.weakCoveredTopics.join("、") + "）" : ""}`);
      }
    } else {
      if (statusEl) statusEl.textContent = "⚠️ " + (end?.error || "结束失败，请重试");
      window.kanban.notify("模拟面试", end?.error || "结束失败，请重试");
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "⚠️ 结束异常: " + String(err?.message || err).slice(0, 80);
    window.kanban.notify("模拟面试", "结束异常: " + String(err?.message || err).slice(0, 80));
  } finally {
    endBtn.disabled = false;
    endBtn.textContent = "结束面试";
  }
});

// 回听播放单例：防连点叠加播放（此前每次点击 new Audio().play() → 点 N 次 N 个播放器同时响）
let ivReplayAudio = null; // 当前播放中的 Audio（单例）
let ivReplayBtn = null;   // 当前播放中的按钮

function stopIvReplay() {
  if (ivReplayAudio) {
    try { ivReplayAudio.pause(); ivReplayAudio.src = ""; } catch { /* ignore */ }
    ivReplayAudio = null;
  }
  if (ivReplayBtn) {
    const b = ivReplayBtn;
    ivReplayBtn = null;
    try { b.textContent = `▶️ 回听 ${fmtIvTime(Number(b.dataset.secs) || 0)}`; } catch { /* ignore */ }
    b.classList.remove("playing");
  }
}

function addIvLog(text, opts = {}) {
  const log = $("iv-log");
  const div = document.createElement("div");
  div.textContent = text;
  // 录音回听：本轮有录音 → 附 ▶️ 回听按钮（单例播放：再点同一按钮=停止，点其他=切播）
  if (opts.play && ivRecordings[ivRound]) {
    const rec = ivRecordings[ivRound];
    const btn = document.createElement("button");
    btn.className = "iv-replay";
    btn.textContent = `▶️ 回听 ${fmtIvTime(rec.secs)}`;
    btn.dataset.secs = String(rec.secs);
    btn.title = "回听自己刚才的回答录音（再点停止）";
    btn.addEventListener("click", () => {
      try {
        if (ivReplayAudio && ivReplayBtn === btn) { stopIvReplay(); return; } // 再点当前播放中 → 停止
        if (ivReplayAudio) stopIvReplay(); // 切播：先停旧的（防叠加）
        const a = new Audio(rec.url);
        ivReplayAudio = a;
        ivReplayBtn = btn;
        btn.textContent = "⏹ 停止回听";
        btn.classList.add("playing");
        a.onended = () => stopIvReplay();
        a.onerror = () => { stopIvReplay(); window.kanban.notify("面试录音", "播放失败：浏览器不支持该录音格式"); };
        a.play().catch(() => { stopIvReplay(); window.kanban.notify("面试录音", "播放失败，请重试"); });
      } catch (err) {
        stopIvReplay();
        window.kanban.notify("面试录音", "播放异常: " + String(err?.message || err).slice(0, 60));
      }
    });
    div.appendChild(btn);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function fmtIvTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ============ 面试录音（🎙️ 说答案 → ASR 转写回填 + 录音留存本场回听） ============
// 一路双采：MediaRecorder → webm（回听）；ScriptProcessor → 16k PCM（转写，worker 内本地 ASR）
let ivMicStream = null, ivMicRec = null, ivMicCtx = null, ivMicSource = null, ivMicProc = null;
let ivMicChunks = [], ivMicPcm = [], ivMicRecording = false, ivMicAutoStop = null, ivMicStarting = false;
let ivMicTimer = null, ivMicSecs = 0, ivMicRecordSr = 16000;
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
  // 防抖互斥：启动中/录音中重复点击忽略（getUserMedia 异步期间快速连点会重复拉起麦克风）
  if (ivMicRecording || ivMicStarting) return;
  ivMicStarting = true;
  try {
    try {
      // 禁用音频处理链 + 显式选择物理麦克风（默认设备可能无声——实测全零根因）
      const micId = await pickMicDevice();
      const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (micId) audioConstraints.deviceId = { exact: micId };
      ivMicStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
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
  // PCM 采集（16k 单声道，ASR 期望采样率）——AudioWorklet（ScriptProcessor 废弃，Electron 43 下全零）
  try {
    ivMicCtx = new AudioContext({ sampleRate: 16000 });
    // AudioContext 可能 suspended（自动播放策略）→ 采集回调不触发（与 🎤 同坑）
    if (ivMicCtx.state === "suspended") await ivMicCtx.resume();
    ivMicSource = ivMicCtx.createMediaStreamSource(ivMicStream);
    await ivMicCtx.audioWorklet.addModule("pcm-worklet.js");
    ivMicProc = new AudioWorkletNode(ivMicCtx, "pcm-capture");
    ivMicProc.port.onmessage = (e) => {
      if (ivMicRecording) ivMicPcm.push(e.data);
    };
    ivMicSource.connect(ivMicProc);
  } catch { /* ignore（MediaRecorder 录音不受影响，仅转写可能空） */ }
  ivMicRecording = true;
  setIvMicState("rec");
  ivMicTimer = setInterval(() => {
    ivMicSecs++;
    const btn = $("iv-mic");
    if (btn) btn.textContent = "⏹ " + fmtIvTime(ivMicSecs);
  }, 1000);
  ivMicAutoStop = setTimeout(() => { if (ivMicRecording) stopIvMic(); }, 120000); // 2 分钟上限
  } finally {
    // 启动结束：清互斥；失败时释放麦克风流与音频上下文（防占用）
    ivMicStarting = false;
    if (!ivMicRecording) {
      if (ivMicStream) { try { ivMicStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } ivMicStream = null; }
      try { ivMicCtx?.close(); } catch { /* ignore */ }
      setIvMicState("idle");
    }
  }
}

async function stopIvMic() {
  ivMicRecording = false;
  clearTimeout(ivMicAutoStop);
  if (ivMicTimer) { clearInterval(ivMicTimer); ivMicTimer = null; }
  ivMicRecordSr = ivMicCtx?.sampleRate || 16000; // 先取采样率，ctx 马上 close
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
    // VAD 裁头尾静音（防噪声被脑补成汉字；长段思考停顿也能裁掉）
    const voiced = window.trimSilenceToVoice ? window.trimSilenceToVoice(pcm, ivMicRecordSr) : pcm;
    if (!voiced || voiced.length < ivMicRecordSr * 0.5) {
      window.kanban.notify("面试录音", "未检测到语音，录音已保存可回听");
      return;
    }
    // 采样率兜底（AudioContext 个别平台退回 48k）
    let input = voiced;
    if (ivMicRecordSr !== 16000 && typeof resampleTo16k === "function") {
      input = await resampleTo16k(voiced, ivMicRecordSr);
      if (!input) {
        window.kanban.notify("面试录音", "采样率异常，请重试");
        return;
      }
    }
    const r = await window.kanban.speechToText(input);
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
  stopIvReplay(); // 新面试开始 → 停止旧回听（防残留播放）
  for (const k of Object.keys(ivRecordings)) {
    try { URL.revokeObjectURL(ivRecordings[k].url); } catch { /* ignore */ }
    delete ivRecordings[k];
  }
  if (ivMicRecording) stopIvMic();
}

// 🎯 面试优先考察 chips（面试设置页）：多源自动聚合（薄弱点/题库错题/复习错题/今日复习/
// 到期卡/清单未完成）——点击填入重点方向（手动选配；不选则面试自动全量优先考察）
async function loadIvWeakChips() {
  const row = $("iv-weak-row"), chips = $("iv-weak-chips");
  if (!row || !chips) return;
  try {
    const r = await fetch(API_BASE + "/api/iv-focus-sources");
    const j = await r.json();
    const items = (j.items || []).slice(0, 12);
    if (!items.length) { row.classList.add("hidden"); chips.innerHTML = ""; return; }
    row.classList.remove("hidden");
    chips.innerHTML = items.map((w) => `
      <button class="job-chip iv-weak-chip" data-topic="${esc(w.topic)}" title="${esc(w.reason || "待考察")}——点击加入本次面试重点">
        ${esc(w.topic)} <i>${esc(w.reason || "")}</i></button>`).join("");
    chips.querySelectorAll(".iv-weak-chip").forEach((b) => {
      b.addEventListener("click", () => {
        const f = $("iv-focus");
        const t = b.dataset.topic;
        const parts = f.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
        if (!parts.includes(t)) parts.push(t);
        f.value = parts.join("、");
        b.classList.add("picked");
        window.kanban.notify("🎯 优先考察", `已加入重点方向：${t}（也可不选——面试自动聚合全部练习数据）`);
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
    $("review-card").classList.remove("hidden"); // 主流程漏移除（此前只有错题本路径移除 → 复习 Tab 有卡时卡片区空白）
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
  box.innerHTML = `今日 ${queue.length} 张：${chip("🆕 首次", first, "#2563eb")} ${chip("🔁 第2次", r2, "#7c3aed")} ${chip("🔁 3次+", r3p, "#5d48b8")} <span style="font-size:10px;color:#6a6790;">· 预计 ${Math.max(1, Math.round(queue.length / 2))} 分钟</span>`;
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
      <span style="font-size:11px;color:#6a6790;">近 7 天复习量：</span>
      ${trend.map((d) => {
        const h = Math.max(3, Math.round((d.count / max) * 30));
        const isToday = d.date === todayStr;
        return `<span title="${d.date} · 复习 ${d.count} 张" style="display:inline-block;margin:0 3px;text-align:center;">
          <span style="display:block;font-size:9px;color:${d.count ? "#6a6790" : "#c4c1d8"};">${d.count || ""}</span>
          <span style="display:block;width:16px;height:${h}px;background:${d.count ? "linear-gradient(180deg,#8a5adc,#5a3d9e)" : "rgba(109,79,216,.1)"};border-radius:3px;${isToday ? "outline:1.5px solid #8a5adc;outline-offset:1px;" : ""}"></span>
          <span style="font-size:9px;color:${isToday ? "#8a5adc" : "#6a6790"};font-weight:${isToday ? "700" : "400"};">${dayLabel(d)}</span>
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
  const color = score < 50 ? "#c0392b" : score < 70 ? "#8f6f00" : "#2f7a4a";
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
  // 默答引导：说明这题是"先心里作答→显示答案核对→选择题+评级"三步（此前标题无引导，用户困惑简答/选择的定位）
  $("rc-question").innerHTML = `<div style="font-size:11px;color:#6a6790;margin-bottom:4px;">📝 先默答这题（心里组织答案），再点「显示答案」核对，最后做选择题并评级</div>` + esc(card.question || card.topic);
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
        <span style="font-size:11px;color:#6a6790;">首次复习，学完记住它</span>`;
    } else {
      const color = memPct >= 80 ? "linear-gradient(90deg,#3a8a5a,#2f7d4e)" : memPct >= 60 ? "linear-gradient(90deg,#8a5adc,#6d4fd8)" : "linear-gradient(90deg,#d98a3d,#c07020)";
      memEl.innerHTML = `<span class="rc-stage-badge">${esc(stage.label)}</span>
        <span class="rc-mem-track"><i style="width:${memPct}%;background:${color}"></i></span>
        <b class="rc-mem-pct" style="color:${memPct >= 80 ? "#2e9e5b" : memPct >= 60 ? "#5d48b8" : "#9a5b00"};">${memPct}%</b>
        <span style="font-size:10px;color:#6a6790;">记忆强度</span>`;
    }
  }
}

// 评分反馈：显示 FSRS 下次复习时间 + 间隔（记忆方法反馈）
function showReviewFeedback(rating, nextDue, nextCard) {
  const fb = $("rc-feedback");
  if (!fb) return;
  const label = ["😵 忘了", "😕 困难", "🙂 记得", "😄 简单"][rating] || "";
  const color = rating >= 2 ? "#2f7a4a" : "#c05050";
  const schedDays = nextCard?.fsrs?.scheduled_days;
  fb.innerHTML = `<span style="color:${color};font-weight:600;">${label}</span> · 间隔 <b>${schedDays || 1}</b> 天 · 下次复习：<b>${nextDue ? relDue(nextDue) : "—"}</b>`;
  fb.classList.remove("hidden");
}
// 学习计划即时反馈（P1-9：复习进事件流 → 计划引擎返回对比基线提示，追加在 FSRS 反馈下方）
function appendReviewTip(tip) {
  const fb = $("rc-feedback");
  if (!fb || !tip) return;
  const div = document.createElement("div");
  div.className = "rc-tip";
  div.style.cssText = "margin-top:4px;font-size:11px;color:#6d4fd8;";
  div.textContent = "🎯 " + String(tip);
  fb.appendChild(div);
}

$("rc-show").addEventListener("click", async () => {
  const card = reviewQueue[reviewIdx];
  let answerText = card.answer || "";
  let answerNote = "";
  if (!answerText && card?.topic) {
    // 空答案回退：纯读该主题的讲解存档（study_notes）——不触发 LLM 生成（复习场景要快）
    try {
      const r = await fetch(`${API_BASE}/api/study/note?topic=${encodeURIComponent(card.topic)}`).then((x) => x.json());
      if (r?.ok && r.found && r.content) {
        answerText = r.content;
        answerNote = "（来自讲解存档）";
      }
    } catch { /* 旧版后台无此接口 → 按无答案处理 */ }
  }
  const box = $("rc-answer");
  box.textContent = answerText
    ? (answerNote ? answerNote + "\n" : "") + answerText
    : "本题暂无参考答案——先按自己的理解评级；答错会自动进复习与讲解。";
  box.classList.remove("hidden");
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
    // 学习计划即时反馈（对比基线）
    if (r?.tip) appendReviewTip(r.tip);
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

// 跳过这张：不评分，放回队列尾部（稍后回来复习）；全部跳过 → 空队列提示
$("rc-skip")?.addEventListener("click", () => {
  const card = reviewQueue[reviewIdx];
  if (!card) return;
  reviewQueue.splice(reviewIdx, 1);
  reviewQueue.push(card);
  if (reviewIdx >= reviewQueue.length) reviewIdx = 0;
  showReviewCard();
  window.kanban.notify("🔁 复习", "已跳过「" + String(card.topic || "").slice(0, 12) + "」，放回队列稍后复习");
});

// ============ 复习自测：选择题快速回忆（题库化：懒生成 6 题 → 每次随机抽 3 + 选项洗牌；答错自动换批） ============
let quizState = null; // { questions, chosen: {qi: oi} }

async function loadCardQuiz(cardId) {
  const box = $("rc-quiz");
  if (!box) return;
  // 同一张卡已加载过（切 Tab 回来）：保留已选状态，不重渲染（此前每次重载 → 选择丢失）
  if (quizState?.questions?.length && quizState.questions[0]?.cardId === cardId) {
    renderQuiz(quizState.questions); // 按已选状态重渲染（picked 恢复）
    return;
  }
  quizState = null;
  box.classList.remove("hidden");
  box.innerHTML = '<div class="quiz-loading">🧠 复习自测加载中…</div>';
  try {
    let r = await fetch(`${API_BASE}/api/review/quiz?id=${encodeURIComponent(cardId)}`).then((x) => x.json());
    if (!r.questions?.length) {
      // 题库空 → 懒生成（首次约 10-20s；失败/无 LLM 降级为纯文本卡，不阻塞复习）
      box.innerHTML = '<div class="quiz-loading">🧠 生成自测题中（首次约 10-20s，可先点「显示答案」）…</div>';
      const g = await fetch(API_BASE + "/api/review/quiz/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardId }),
      }).then((x) => x.json()).catch(() => ({ ok: false }));
      if (g.ok && g.total > 0) {
        r = await fetch(`${API_BASE}/api/review/quiz?id=${encodeURIComponent(cardId)}`).then((x) => x.json());
        // 知识库素材标记：新生成时透传（面板提示"含知识库真题"；缓存命中无此字段）
        if (g.kbUsed) quizState = { ...(quizState || {}), kbUsed: true };
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
  const prevChosen = quizState?.chosen || {};
  quizState = { questions, chosen: prevChosen, kbUsed: quizState?.kbUsed || false };
  const box = $("rc-quiz");
  // 累计自测正确率（/api/review/quiz/stats 消费 quiz_attempts；异步填充）
  try {
    // 通过 DOM 拿当前卡 id（rc- 区域）——简化：先不加这里，避免复杂
  } catch { /* ignore */ }
  // kbUsed 提示（新生成时含知识库素材）
  const kbNote = quizState.kbUsed ? '<div class="quiz-kb" style="font-size:11px;color:#6a6790;margin:2px 0 6px;">📚 本题库引用了本地知识库真题素材</div>' : "";
  box.innerHTML = `<div class="quiz-head">🧠 复习自测 · 快速回忆（答完再评分）</div>${kbNote}` +
    questions.map((q, qi) => `
    <div class="quiz-q" data-qi="${qi}">
      <div class="quiz-question">${qi + 1}. ${esc(q.question)}</div>
      <div class="quiz-options">
        ${q.options.map((o, oi) => `<button class="quiz-opt${prevChosen[qi] === oi ? " picked" : ""}" data-qi="${qi}" data-oi="${oi}">${String.fromCharCode(65 + oi)}. ${esc(o)}</button>`).join("")}
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
  const answers = quizState.questions.map((q, qi) => ({ questionId: q.id, chosen: quizState.chosen[qi] ?? -1, map: q.map }));
  try {
    const r = await fetch(API_BASE + "/api/review/quiz/submit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: card.id, answers }),
    }).then((x) => x.json());
    const byQ = {};
    for (const res of r.results || []) byQ[res.questionId] = res;
    // 逐题对错 + 解析（答错时明确给出正确答案）
    quizState.questions.forEach((q, qi) => {
      const res = byQ[q.id];
      const fb = $("rc-quiz").querySelector(`.quiz-fb[data-fb="${qi}"]`);
      if (!fb || !res) return;
      fb.classList.remove("hidden");
      const rightText = q.options[res.rightIndex] ? `${String.fromCharCode(65 + res.rightIndex)}. ${q.options[res.rightIndex]}` : "";
      fb.innerHTML = res.correct
        ? `<span class="quiz-right">✅ 正确</span><div class="quiz-explain">${esc(res.explain || "")}</div>`
        : `<span class="quiz-wrong">❌ 选错了 · 正确答案：<b>${esc(rightText)}</b></span><div class="quiz-explain">${esc(res.explain || "")}</div>`;
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
    // 存量题库解析过短（旧版"解析 ≤35 字"限制生成）→ 自动换一批（新解析 40-80 字讲清依据）
    const explains = (r.results || []).map((x) => String(x.explain || "").length);
    if (explains.length && Math.max(...explains) < 25) {
      quizSwapBatch(card.id);
      if (summary) summary.innerHTML = (summary.innerHTML || "") + `<div style="font-size:11px;color:#6a6790;margin-top:4px;">📝 本题解析较简略（旧题库），已自动换一批更详细的</div>`;
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
    fetch(API_BASE + "/api/review/quiz/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cardId }),
    }).catch(() => { /* 换批失败不影响复习 */ });
  } catch { /* ignore */ }
}

// ============ 复习即学：答错 → 让真白讲一遍（SSE 流式，结合知识库） ============
$("rc-explain")?.addEventListener("click", () => {
  const btn = $("rc-explain");
  openReviewExplain(btn.dataset.cardId, btn.dataset.topic);
});

// 复习讲解代际：关闭弹窗/重新打开时递增，过期流回调丢弃（与学习讲解 sdGen 同模式——
// 曾存在同类竞态：关闭讲解后旧流继续写 rex-body，20-60s 内再开另一张卡讲解会被旧流覆盖）
let rexGen = 0;
async function openReviewExplain(cardId, topic) {
  const gen = ++rexGen;
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
    const res = await fetch(`${API_BASE}/api/review/explain-stream?id=${encodeURIComponent(cardId || "")}`);
    if (!res.ok || !res.body) throw new Error("讲解流启动失败");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (gen !== rexGen) { reader.cancel().catch(() => {}); return; } // 已切换/关闭：丢弃过期流并断开
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
              if (gen !== rexGen) return;
              full += j.delta;
              body.textContent = full;
              body.scrollTop = body.scrollHeight;
            } else if (j.type === "done") {
              if (gen !== rexGen) return;
              status.textContent = "✅ 已生成（讲解已存入复习卡答案，下次复习可对照）";
              planBtn.classList.remove("hidden");
            } else if (j.type === "error") {
              if (gen !== rexGen) return;
              status.textContent = "⚠️ " + (j.error || "生成失败");
              if (!full) body.textContent = "讲解生成失败：" + (j.error || "未知错误");
            }
          } catch { /* ignore */ }
        }
      }
    }
  } catch (e) {
    if (gen !== rexGen) return;
    status.textContent = "⚠️ 失败";
    body.textContent = "讲解生成失败：" + String(e.message || e).slice(0, 120);
  }
}

$("rex-close")?.addEventListener("click", () => {
  rexGen++; // 关闭 → 过期流丢弃
  $("review-explain-overlay")?.classList.add("hidden");
});
$("review-explain-overlay")?.addEventListener("click", (e) => {
  if (e.target === $("review-explain-overlay")) { rexGen++; $("review-explain-overlay").classList.add("hidden"); }
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
    const r = await fetch(API_BASE + "/api/review/wrong");
    const j = await r.json();
    const wrong = j.wrong || [];
    countEl.textContent = wrong.length;
    if (!wrong.length) {
      listEl.innerHTML = '<div style="font-size:11px;color:#6a6790;">暂无错题（答错 ≥2 次才进错题本）</div>';
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
  bindPlanItems(list, false); // 主列表绑定：学习/讲解按钮 + 勾选 + 组头折叠（此前缺失 → 点学习没反应）
  if (!filtered.length && (q || lv || st)) {
    list.innerHTML = `<div style="color:#6a6790;font-size:12px">没有匹配「${esc(q || lv || st)}」的条目</div>`;
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
        <div class="s-topic">${esc(it.topic)} ${it.level ? `<span class="s-lv ${lvCls[it.level] || "lv-must"}">${esc(it.level)}</span>` : ""} ${srcBadge}${it.reviewDue ? '<span class="s-src" style="background:rgba(220,150,60,.2);color:#9a5b00;">🔁 复习到期</span>' : ""}</div>
        <div class="s-why">${esc(it.why || "")}</div>
      </div>
      <button class="s-learn" data-id="${it.id}">${it.hasFile ? "📖 学习" : "💡 讲解"}</button>
      <span class="s-badge ${it.reviewed ? "reviewed" : ""}">${it.reviewed ? "已复盘" : "待学"}</span>
    </div>`;
}

function bindPlanItems(root, _isDone) {
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
  sdBody().innerHTML = '<div style="color:#6a6790;font-size:13px;padding:12px">📚 正在归并多个讲解为主题簇综合讲解（去重合并 + 扩展关联考点）...</div>';
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
let sdGen = 0;             // 讲解请求代际：切换条目/关闭弹层时递增，过期流式回调直接丢弃
                           //（竞态修复：快速点击不同讲解时旧流仍持续到达，曾把 A 内容渲染进 B 弹窗）
const sdOverlay = () => $("study-detail-overlay");
const sdBody = () => $("sd-modal-body");

async function showStudyDetail(id) {
  const gen = ++sdGen;
  sdCurrentId = id;
  // 显示弹层 + 加载态
  sdOverlay().classList.remove("hidden");
  sdBody().innerHTML = '<div style="color:#6a6790;font-size:13px;padding:12px">📖 加载讲解中...</div>';
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
    const result = await streamStudyDetail(id, (content) => {
      if (gen !== sdGen) return; // 已切到别的条目/已关闭：丢弃过期流内容
      sdBody().innerHTML = renderMd(content) + '<div class="sd-streaming">⏳ 生成中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight; // 生成中跟随最新内容
    });
    if (gen !== sdGen) return; // 生成期间被切换：结果属于旧条目，不渲染
    const topic = typeof result === "string" ? result : (result?.topic || "讲解");
    // 同知识点复用提示（如「版本号数组排序」复用了「版本号比较」的讲解）
    if (result?.similarFrom?.topic && result.similarFrom.topic !== topic) {
      const tip = document.createElement("div");
      tip.style.cssText = "color:#1f5c33;font-size:12px;padding:6px 8px;background:rgba(58,141,90,.08);border-radius:6px;margin:0 0 6px;";
      tip.textContent = `📎 本条目与「${result.similarFrom.topic}」为同一知识点，已复用其讲解（内容一致，避免重复生成）`;
      sdBody().insertBefore(tip, sdBody().firstChild);
    }
    // 同知识点更早存档提示：当前展示的讲解不是最早那版 → 给"查看最早版"入口
    // （用户反馈：最初生成的讲解（如简单 split 方案）通常质量最好）
    if (result?.earlierArchive?.topic) {
      const box = document.createElement("div");
      box.style.cssText = "color:#6a6790;font-size:12px;padding:6px 8px;background:rgba(138,90,220,.06);border:1px solid rgba(138,90,220,.15);border-radius:6px;margin:0 0 6px;display:flex;gap:8px;align-items:center;";
      box.innerHTML = `<span>📎 同知识点「${esc(result.earlierArchive.topic)}」有更早生成的讲解</span>`;
      const btn = document.createElement("button");
      btn.className = "job-btn";
      btn.style.cssText = "padding:2px 10px;font-size:11px;";
      btn.textContent = "查看最早版";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "⏳ 加载…";
        try {
          const r = await fetch(`${API_BASE}/api/study-detail-stream?id=${encodeURIComponent(result.earlierArchive.id)}`);
          const j = await r.json();
          if (!j.ok || !j.content) throw new Error(j.error || "加载失败");
          // 用最早版替换当前弹窗内容（缓存按当前条目 id 记录，重新打开仍展示最早版）
          studyDetailCache[id] = { content: j.content, topic: j.topic };
          sdBody().innerHTML = renderMd(j.content);
          $("sd-modal-title").textContent = "📖 " + (j.topic || topic) + "（最早版）";
          buildToc();
          sdBody().scrollTop = 0;
        } catch (e) {
          window.kanban.notify("📖 讲解", "加载最早版失败: " + String(e.message || e).slice(0, 60));
        } finally {
          btn.disabled = false;
          btn.textContent = "查看最早版";
        }
      });
      box.appendChild(btn);
      sdBody().insertBefore(box, sdBody().firstChild);
    }
    $("sd-modal-title").textContent = "📖 " + topic;
    buildToc(); // 锚点目录（流式生成完成）
    // 生成完成：回到顶部（从头阅读，不留在末尾）
    sdBody().scrollTop = 0;
  } catch (e) {
    if (gen !== sdGen) return;
    sdBody().innerHTML = `<div style="color:#c05050;font-size:13px;padding:12px">⚠️ ${esc(e.message)}</div>`;
  }
}

// 追问补充：基于已有讲解继续深入（流式显示 + 更新缓存）
let sdAsking = false;
async function askStudyDetail() {
  const question = $("sd-ask-input").value.trim();
  if (!question || !sdCurrentId || sdAsking) return;
  const id = sdCurrentId;     // 捕获：切换条目后旧追问不得污染新条目缓存（曾用全局 sdCurrentId 写错条目）
  const gen = sdGen;          // 捕获代际：切换/关闭后过期流回调直接丢弃
  sdAsking = true;
  const btn = $("sd-ask-btn");
  btn.disabled = true;
  btn.textContent = "补充中...";
  $("sd-ask-input").value = "";
  try {
    // 初始内容（未生成时先生成）
    if (!studyDetailCache[id]?.content) {
      const topic = await streamStudyDetail(id, (c) => {
        if (gen !== sdGen) return;
        sdBody().innerHTML = renderMd(c) + '<div class="sd-streaming">⏳ 生成中...</div>';
        sdBody().scrollTop = sdBody().scrollHeight;
      });
      if (gen !== sdGen) return;
      $("sd-modal-title").textContent = "📖 " + topic;
    }
    const base = studyDetailCache[id]?.content || "";
    // 追加分隔 + 追问标题
    sdBody().innerHTML = renderMd(base) + `<div class="sd-ask-q">💬 追问：${esc(question)}</div><div class="sd-streaming">⏳ 补充中...</div>`;
    sdBody().scrollTop = sdBody().scrollHeight;
    // 流式补充（可命中语义缓存：历史追问过相似问题 → 直接返回已有回答，零 LLM 请求）
    let extra = "";
    let cacheHit = false;
    const onEvent = (j) => {
      if (j?.type === "cache" && j.hit) {
        cacheHit = true;
        const tip = document.createElement("div");
        tip.style.cssText = "color:#1f5c33;font-size:12px;padding:6px 8px;background:rgba(58,141,90,.08);border-radius:6px;margin:4px 0;";
        tip.textContent = `🔁 命中历史追问（相似度 ${Math.round((j.similarity || 0) * 100)}%）：与「${j.cachedQuestion || ""}」的回答相同，未消耗新生成`;
        sdBody().appendChild(tip);
      }
    };
    await window.kanban.studyDetailAppend(id, question, (delta) => {
      if (gen !== sdGen) return; // 已切换/关闭：丢弃过期追问流
      extra += delta;
      sdBody().innerHTML = renderMd(base) + `<div class="sd-ask-q">💬 追问：${esc(question)}</div>` + renderMd(extra) + '<div class="sd-streaming">⏳ 补充中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight;
    }, onEvent);
    if (gen !== sdGen) return; // 生成期间被切换：不写缓存不渲染
    // 完成：更新缓存（下次打开能看到补充内容）
    const topic = studyDetailCache[id]?.topic || "讲解";
    if (cacheHit) {
      // 命中缓存：不重复追加追问章节（回答已在存档中），只保留提示
      $("sd-modal-title").textContent = "📖 " + topic + "（命中历史回答）";
    } else {
      studyDetailCache[id] = { content: base + `\n\n## 💬 追问：${question}\n\n` + extra, topic };
      sdBody().innerHTML = renderMd(studyDetailCache[id].content);
    }
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

// 重新生成：删除本地讲解存档 → 清缓存 → 重新流式生成
// 用户诉求：生成内容错误/不满意时要有处理手段（此前只能干看着错误内容）
$("sd-regenerate-btn").addEventListener("click", async () => {
  const id = sdCurrentId;
  if (!id) return;
  const topic = studyDetailCache[id]?.topic || "该条目";
  if (!confirm(`删除「${topic}」的本地讲解存档并重新生成？\n原讲解与全部追问记录删除后不可恢复。`)) return;
  const btn = $("sd-regenerate-btn");
  btn.disabled = true;
  btn.textContent = "⏳ 重置中…";
  try {
    const r = await fetch(API_BASE + "/api/study-note/reset", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "重置失败");
    delete studyDetailCache[id];
    sdGen++; // 中断可能还在跑的旧流（若有）
    sdForceRegen = true; // 强制生成本条自己的讲解（原逻辑重置后仍复用相似错档，重新生成不生效）
    try {
      await showStudyDetail(id); // 重新流式生成
    } finally {
      sdForceRegen = false;
    }
    window.kanban.notify("📖 讲解", j.deleted ? "已删除旧存档，重新生成中…" : "无存档，直接重新生成…");
  } catch (e) {
    window.kanban.notify("📖 讲解", "重新生成失败: " + String(e.message || e).slice(0, 60));
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 重新生成";
  }
});

// 整理全文：把原始讲解 + 多轮追问整合成结构统一的完整讲解（流式显示 + 写回文件）
let sdConsolidating = false;
async function consolidateStudyDetail() {
  if (!sdCurrentId || sdConsolidating) return;
  const id = sdCurrentId;
  const gen = sdGen; // 捕获代际：切换/关闭后过期流丢弃
  sdConsolidating = true;
  const btn = $("sd-consolidate-btn");
  btn.disabled = true;
  btn.textContent = "整理中...";
  try {
    // 初始内容（未生成时先生成）
    if (!studyDetailCache[id]?.content) {
      const topic = await streamStudyDetail(id, (c) => {
        if (gen !== sdGen) return;
        sdBody().innerHTML = renderMd(c) + '<div class="sd-streaming">⏳ 生成中...</div>';
        sdBody().scrollTop = sdBody().scrollHeight;
      });
      if (gen !== sdGen) return;
      $("sd-modal-title").textContent = "📖 " + topic;
    }
    sdBody().innerHTML = '<div style="color:#6a6790;font-size:13px;padding:12px">📚 正在整合全文（去重合并、统一结构）...</div>';
    // 流式整合
    let merged = "";
    await window.kanban.studyConsolidate(id, (delta) => {
      if (gen !== sdGen) return;
      merged += delta;
      sdBody().innerHTML = renderMd(merged) + '<div class="sd-streaming">⏳ 整合中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight;
    });
    if (gen !== sdGen) return;
    // 完成：更新缓存（下次打开看到整理版）
    const topic = studyDetailCache[id]?.topic || "讲解";
    studyDetailCache[id] = { content: merged, topic };
    $("sd-modal-title").textContent = "📖 " + topic + "（已整理）";
    sdBody().innerHTML = renderMd(merged);
    buildToc(); // 锚点目录（整理版）
    sdBody().scrollTop = 0; // 从头阅读整理版
  } catch (e) {
    if (gen !== sdGen) return;
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
// 返回 { topic, similarFrom }（similarFrom：同知识点复用来源，无则 null）
// sdForceRegen：重新生成入口置 true → 请求带 noSimilar=1，强制生成自己的讲解（不复用相似错档）
let sdForceRegen = false;
async function streamStudyDetail(id, onUpdate) {
  let content = "";
  let topic = "讲解";
  const result = await window.kanban.studyDetailStream(id, (delta) => {
    if (!delta) return;
    content += delta;
    onUpdate(content);
  }, { noSimilar: sdForceRegen });
  // JSON 模式（有文件）：result 带 topic/content
  if (result?.fromFile) {
    content = result.content || content;
    topic = result.topic || topic;
  }
  if (!content) throw new Error("没有获取到内容");
  studyDetailCache[id] = { content, topic };
  return { topic, similarFrom: result?.similarFrom || null };
}

$("sd-modal-close").addEventListener("click", () => { sdGen++; sdOverlay().classList.add("hidden"); }); // 关闭 → 过期流丢弃
sdOverlay().addEventListener("click", (e) => {
  if (e.target === sdOverlay()) { sdGen++; sdOverlay().classList.add("hidden"); } // 点遮罩关闭
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
  const btn = $("study-gen");
  btn.disabled = true;
  btn.textContent = "生成中...";
  try {
    const r = await window.kanban.studyGenerate();
    loadStudyPlan();
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
  } catch (e) {
    // 修复 P0：生成失败必须复位按钮 + 提示（原实现无 catch → 抛错后永久卡"生成中..."）
    window.kanban.notify("✨ 生成清单", "生成失败：" + String(e?.message || e).slice(0, 80));
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ 从产出生成清单";
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
      ${r.existing?.length ? `<div style="color:#9a5b00">已在清单：${esc(r.existing.join("、"))}</div>` : ""}
      ${r.skipped?.length ? `<div style="color:#6a6790">跳过非知识点：${esc(r.skipped.map((s) => s.topic).join("、"))}</div>` : ""}
      <div style="color:#6a6790;font-size:11px;margin-top:4px">${esc(r.hint || "")}</div>`;
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









