// 真白面板逻辑：模拟面试 / 学习清单 / 对话 / 爬取产出
// 通过 preload 的 window.kanban 访问主进程 IPC（与桌宠共享）

// ============ Tab 切换 ============
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (btn) btn.classList.add("active");
  const panel = document.getElementById("tab-" + name);
  if (panel) panel.classList.add("active");
  if (name === "study") loadStudyPlan();
  if (name === "crawl") loadCrawlData();
  if (name === "review") loadReview();
  if (name === "docs") loadDocs();
  if (name === "kb") loadKbStats();
  if (name === "profile") loadProfileStatus();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
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
const ivSetup = $("interview-setup");
const ivSessionEl = $("interview-session");

$("iv-start").addEventListener("click", async () => {
  const position = $("iv-position").value.trim() || "前端实习生";
  const role = $("iv-role").value;
  const focus = $("iv-focus").value.trim();
  const resume = $("iv-resume").value.trim();
  $("iv-start").disabled = true;
  $("iv-start").textContent = "面试官准备中...";
  try {
    const r = await window.kanban.invStart({ position, role, focus, resume });
    if (r.error) { alert("启动失败: " + r.error); return; }
    ivSetup.classList.add("hidden");
    ivSessionEl.classList.remove("hidden");
    $("iv-log").innerHTML = "";
    $("iv-review").classList.add("hidden");
    $("iv-scores").innerHTML = "";
    showQuestion(r);
  } finally {
    $("iv-start").disabled = false;
    $("iv-start").textContent = "🎤 开始模拟面试";
  }
});

function showQuestion(r) {
  $("iv-status").textContent = `面试中 · 第 ${r.round} 轮`;
  $("iv-question").textContent = r.question || "请继续";
  $("iv-meta").innerHTML = `
    <div>🎯 维度：${esc(r.dimension || "-")}</div>
    <div>📌 依据：${esc(r.basis || "-")}</div>
    <div>✅ 合格标准：${esc(r.criteria || "-")}</div>
    <div>🚧 边界：${esc(r.boundary || "-")}</div>`;
  $("iv-answer").value = "";
  $("iv-answer").focus();
  addIvLog(`轮${r.round} 问题：${(r.question || "").slice(0, 60)}`);
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
  addIvLog(`我的回答：${answer.slice(0, 60)}`);
  try {
    const r = await window.kanban.invAnswer(answer);
    if (r.error) { alert(r.error); return; }
    // 评分展示（数值可能被 LLM 输出污染，统一转义）
    if (r.scores) {
      const num = (v) => esc(String(Number(v) || 0));
      $("iv-scores").innerHTML = `
        <div class="score-chip">技术 <b>${num(r.scores.tech)}</b></div>
        <div class="score-chip">表达 <b>${num(r.scores.expr)}</b></div>
        <div class="score-chip">深度 <b>${num(r.scores.depth)}</b></div>
        <div class="score-chip">边界 <b>${num(r.scores.edge)}</b></div>
        <div class="score-chip">复盘 <b>${num(r.scores.reflect)}</b></div>
        <div class="score-chip">总分 <b>${num(r.total)}</b></div>`;
    }
    if (r.comment) $("iv-scores").insertAdjacentHTML("beforeend", `<div class="iv-comment">💬 ${esc(r.comment)}</div>`);
    if (r.finished) {
      $("iv-status").textContent = "面试结束，正在生成复盘...";
      $("iv-answer-area").style.display = "none";
      addIvLog("✅ 面试结束");
      const end = await window.kanban.invEnd();
      if (end?.ok && end.report) {
        $("iv-review").classList.remove("hidden");
        $("iv-review").textContent = end.report;
        addIvLog(end.hint || "");
      }
      return;
    }
    showQuestion(r);
  } finally {
    $("iv-send").disabled = false;
    $("iv-send").textContent = "提交回答";
  }
}

$("iv-end").addEventListener("click", async () => {
  const end = await window.kanban.invEnd();
  if (end?.ok && end.report) {
    $("iv-review").classList.remove("hidden");
    $("iv-review").textContent = end.report;
    $("iv-status").textContent = "面试已结束";
    addIvLog(end.hint || "");
  }
});

function addIvLog(text) {
  const log = $("iv-log");
  const div = document.createElement("div");
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ============ 复习（FSRS 间隔重复） ============
let reviewQueue = [];
let reviewIdx = 0;

async function loadReview() {
  const r = await window.kanban.reviewDue();
  if (!r?.ok) return;
  const stats = r.stats || {};
  $("review-stats").innerHTML = `
    <div class="stat-chip">总卡片 <b>${stats.total || 0}</b></div>
    <div class="stat-chip">今日到期 <b>${stats.due || 0}</b></div>
    <div class="stat-chip">学习中 <b>${stats.learning || 0}</b></div>
    <div class="stat-chip">已掌握 <b>${stats.mastered || 0}</b></div>`;
  reviewQueue = r.due || [];
  reviewIdx = 0;
  if (reviewQueue.length) {
    $("review-empty").classList.add("hidden");
    showReviewCard();
  } else {
    $("review-card").classList.add("hidden");
    $("review-empty").classList.remove("hidden");
  }
  loadMastery(); // 掌握度区块（弱项优先，默认收起）
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
  $("rc-topic").textContent = "🔁 " + card.topic;
  $("rc-question").textContent = card.question || card.topic;
  $("rc-answer").textContent = card.answer || "";
  $("rc-answer").classList.add("hidden");
  $("rc-show").classList.remove("hidden");
  $("rc-buttons").classList.add("hidden");
  // 来源 + 复习次数标签（追加在题目上方）
  const src = card.source || "";
  const times = card.history?.length || 0;
  const srcTag = document.getElementById("rc-src");
  if (srcTag) {
    srcTag.textContent = `${src ? "来源：" + src + " · " : ""}已复习 ${times} 次`;
    srcTag.style.display = "block";
  }
}

$("rc-show").addEventListener("click", () => {
  $("rc-answer").classList.remove("hidden");
  $("rc-show").classList.add("hidden");
  $("rc-buttons").classList.remove("hidden");
});

document.querySelectorAll(".rc-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const card = reviewQueue[reviewIdx];
    const r = await window.kanban.reviewSubmit(card.id, parseInt(btn.dataset.rating, 10));
    // 真白情感反馈
    if (r?.emotion) {
      window.kanban.notify("🎀 真白", r.emotion);
      if (voiceOn) window.kanban.speak(r.emotion);
    }
    reviewIdx++;
    if (reviewIdx < reviewQueue.length) showReviewCard();
    else loadReview(); // 复习完一轮刷新
  });
});
async function loadStudyPlan() {
  const r = await window.kanban.studyPlan();
  if (!r?.ok) return;
  const items = r.plan?.items || [];
  const list = $("study-list");
  const doneToggle = $("study-done-toggle");
  const doneList = $("study-done-list");
  if (!items.length) {
    list.innerHTML = '<div style="color:#7c7c7c;font-size:12px">未生成，点「✨ 从产出生成清单」</div>';
    doneToggle.style.display = "none";
    doneList.style.display = "none";
    return;
  }
  // 已完成条目从主清单隐藏（避免无限膨胀），折叠在「📜 已完成」里可查看/恢复
  const doneItems = items.filter((it) => it.done);
  const visible = items.filter((it) => !it.done);
  const doneCount = doneItems.length;
  doneToggle.style.display = doneCount ? "" : "none";
  if (doneCount) doneToggle.textContent = `📜 已完成条目（${doneCount}，点击${doneList.style.display === "none" ? "展开" : "收起"}）`;
  if (doneList.style.display !== "none") {
    doneList.innerHTML = renderPlanItems(doneItems, true);
    bindPlanItems(doneList, true);
  }
  if (!visible.length) {
    list.innerHTML = '<div style="color:#3a8d5a;font-size:12px">🎉 全部学完！点「✨ 从产出生成清单」补充新知识点</div>';
    doneToggle.style.display = doneCount ? "" : "none";
    return;
  }
  list.innerHTML = renderPlanItems(visible, false);
  bindPlanItems(list, false);
}

function renderPlanItems(items, isDone) {
  const lvCls = { "必会": "lv-must", "进阶": "lv-adv", "拓展": "lv-ext" };
  const renderItem = (it) => `
    <div class="study-item ${it.done ? "done" : ""}" data-id="${it.id}">
      <input type="checkbox" ${it.done ? "checked" : ""} />
      <div style="flex:1">
        <div class="s-topic">${esc(it.topic)} ${it.level ? `<span class="s-lv ${lvCls[it.level] || "lv-must"}">${esc(it.level)}</span>` : ""} ${it.fromInterview ? '<span class="s-src">面试</span>' : ""}</div>
        <div class="s-why">${esc(it.why || "")}</div>
      </div>
      <button class="s-learn" data-id="${it.id}">${it.hasFile ? "📖 学习" : "💡 讲解"}</button>
      <span class="s-badge ${it.reviewed ? "reviewed" : ""}">${it.reviewed ? "已复盘" : "待学"}</span>
    </div>`;
  if (isDone) {
    // 已完成折叠区：保持原层级分组（必会 → 进阶 → 拓展）
    const groups = [
      { level: "必会", label: "🔴 必会 · 高频核心", cls: "lv-must", items: [] },
      { level: "进阶", label: "🟡 进阶 · 原理深挖", cls: "lv-adv", items: [] },
      { level: "拓展", label: "🟢 拓展 · 加分新方向", cls: "lv-ext", items: [] },
    ];
    for (const it of items) {
      const g = groups.find((x) => x.level === (it.level || "必会")) || groups[0];
      g.items.push(it);
    }
    return groups
      .filter((g) => g.items.length)
      .map((g) => `
      <div class="study-group">
        <div class="sg-head ${g.cls}">${g.label} <span class="sg-count">${g.items.length}</span></div>
        ${g.items.map(renderItem).join("")}
      </div>`).join("");
  }
  // 主清单：按主题簇 grp 分组（未分类置最后）；组内保留 level 徽章
  const byGrp = new Map();
  for (const it of items) {
    const g = String(it.grp || "").trim() || "未分类";
    if (!byGrp.has(g)) byGrp.set(g, []);
    byGrp.get(g).push(it);
  }
  if (byGrp.size > 1 && byGrp.has("未分类")) {
    const uncat = byGrp.get("未分类");
    byGrp.delete("未分类");
    byGrp.set("未分类", uncat); // 未分类组放最后
  }
  return [...byGrp].map(([g, its]) => `
      <div class="study-group" data-grp="${esc(g)}">
        <div class="study-group-head" data-grp="${esc(g)}">📁 ${esc(g)}（${its.length}）</div>
        <div class="study-group-body">${its.map(renderItem).join("")}</div>
      </div>`).join("");
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
      // 真白情感反馈（庆祝/安慰）+ 语音
      if (r?.emotion) {
        window.kanban.notify("🎀 真白", r.emotion);
        if (voiceOn) window.kanban.speak(r.emotion);
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

// ============ 多条目归并（主题簇） ============
let clusterMode = false;
// 主题簇组折叠状态（内存变量：仅影响主清单 visible 区渲染，默认展开）
const groupCollapsed = new Set();
const clusterBtn = () => $("study-cluster-btn");

function updateClusterBtn() {
  const n = document.querySelectorAll(".study-item.cluster-selected").length;
  // 归并模式下保持「确认」语义；非归并模式显示普通归并入口
  clusterBtn().textContent = clusterMode
    ? (n >= 2 ? `✅ 确认归并(${n})` : "✅ 确认归并")
    : (n >= 2 ? `🔗 归并(${n})` : "🔗 归并");
}

clusterBtn().addEventListener("click", async () => {
  if (!clusterMode) {
    // 进入多选模式
    clusterMode = true;
    clusterBtn().textContent = "✅ 确认归并";
    clusterBtn().classList.add("cluster-active");
    // 清空之前选择：只清 cluster-selected 视觉类，不动 checkbox 勾选态
    // （已完成条目的勾选显示是完成态，退出模式时由 loadStudyPlan() 重渲染统一恢复）
    document.querySelectorAll(".study-item.cluster-selected").forEach((el) => el.classList.remove("cluster-selected"));
    // 自动展开已完成折叠区，让已完成条目也能参与归并选择
    $("study-done-list").style.display = "";
    loadStudyPlan();
    window.kanban.notify("🔗 归并模式", "勾选=归并选择，不会标记完成；已完成条目已展开，也可选入归并");
    return;
  }
  // 确认归并
  const ids = [...document.querySelectorAll(".study-item.cluster-selected")].map((el) => el.dataset.id);
  if (ids.length < 2) { window.kanban.notify("🔗 归并", "至少选 2 个条目"); return; }
  // 退出多选模式
  clusterMode = false;
  clusterBtn().textContent = "🔗 归并";
  clusterBtn().classList.remove("cluster-active");
  document.querySelectorAll(".study-item.cluster-selected").forEach((el) => el.classList.remove("cluster-selected"));
  // 重渲染：恢复主清单与已完成区的 checkbox 正确显示（已完成条目重新显示为勾选态）
  loadStudyPlan();
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
  div.innerHTML = `<div class="who">${role === "user" ? "你" : "真白"}</div><div class="body">${esc(text)}</div>`;
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
    if (r.voice && voiceOn) window.kanban.speak(r.voice);
    thinking.querySelector(".body").className = "body";
    thinking.querySelector(".body").textContent = r.reply || "（无回复）";
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
  // 自动巡检配置（开关/频率/状态）
  loadPatrolConfig();
  // 面试历史
  try {
    const h = await window.kanban.interviewHistory();
    const list = (h?.history || []).slice(-5).reverse();
    $("interview-history").innerHTML = list.length
      ? list.map((it) => `
        <div class="iv-hist-item">
          <div class="iv-hist-head">${esc(it.position || "模拟面试")} · ${esc(it.role || "")} · ${it.rounds || 0} 轮
            <span class="iv-hist-score">均分 ${it.avg ?? it.avgScore ?? "-"}</span></div>
          ${it.report ? `<div class="iv-hist-report">${esc(it.report).slice(0, 150)}${it.report.length > 150 ? "..." : ""}</div>` : ""}
        </div>`).join("")
      : '<div style="color:#7c7c7c;font-size:12px">暂无面试记录，去「🎤 模拟面试」来一场吧</div>';
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

// ============ 校招（简历驱动匹配 + 投递管理） ============
const STATUS_LABEL = { new: "🆕 未处理", ready: "📮 已投递", ready_bishi: "✍️ 待笔试", done: "✅ 已拿offer/结束" };
const DIRECTION_LABEL = { frontend: "前端", agent: "AI Agent", fullstack: "全栈", backend: "后端", other: "其他" };

async function loadJobs() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/jobs/recommended");
    const j = await r.json();
    const list = document.getElementById("jobs-list");
    if (!j.recommended?.length) {
      list.innerHTML = '<div class="empty-hint">暂无岗位——点上方「🔍 搜集校招」抓取，或先设置简历/方向</div>';
      return;
    }
    list.innerHTML = j.recommended.map((job) => `
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
          <span>${STATUS_LABEL[job.status] || job.status}</span>
        </div>
        ${job.summary ? `<div class="job-summary">${esc(job.summary)}</div>` : ""}
        ${job.jdText ? `<div class="job-jd" id="jd-${job.id}" hidden><pre>${esc(job.jdText)}</pre></div>` : ""}
        <div class="job-actions">
          ${job.applyUrl ? `<a class="job-link" href="${esc(safeUrl(job.applyUrl))}" target="_blank" rel="noopener">🔗 去投递</a>` : ""}
          ${job.jdText ? `<button class="job-btn jd-toggle" data-id="${job.id}">📋 JD</button>` : ""}
          <button class="job-btn" data-id="${job.id}" data-status="ready">📮 已投递</button>
          <button class="job-btn" data-id="${job.id}" data-status="ready_bishi">✍️ 待笔试</button>
          <button class="job-btn" data-id="${job.id}" data-status="done">✅ 完成</button>
        </div>
      </div>`).join("");
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
    document.querySelectorAll(".job-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
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
        ${cat.sites.map((s) => `
          <div class="job-item">
            <div class="job-head">
              <b>${esc(s.name)}</b>
              <span class="job-badge" style="background:rgba(120,180,120,.15);color:#3a8d5a;">${s.check?.ok ? "✅ v" + esc(s.check.version || "?") + (s.check.date ? " · " + esc(s.check.date) : "") : s.check ? "⚠️ 未提取到" : "未检测"}</span>
            </div>
            <div class="job-meta">${esc(s.desc)}</div>
            <div class="job-actions">
              <a class="job-link" href="${esc(safeUrl(s.official))}" target="_blank" rel="noopener">🔗 官方文档</a>
              ${s.versionPage && s.versionPage !== s.official ? `<a class="job-link" href="${esc(safeUrl(s.versionPage))}" target="_blank" rel="noopener">📄 版本页</a>` : ""}
            </div>
          </div>`).join("")}
      </div>`).join("");
  } catch (e) {
    document.getElementById("docs-list").innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

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

// ============ 个人主页（简历存档中心：上传/粘贴/保存/拷打清单） ============
const profileStatus = $("profile-status");
const profileResume = $("profile-resume");

// 加载已存档简历状态（画像 + 原文）
async function loadProfileStatus() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/jobs/profile");
    const j = await r.json();
    const savedBox = $("profile-saved");
    if (!j.profile) {
      savedBox.innerHTML = '<div class="empty-hint">📭 还没有存档简历——上传或粘贴后点「💾 保存简历」</div>';
      profileStatus.textContent = "";
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
  } catch (e) {
    profileStatus.textContent = "⚠️ 加载失败：" + e.message;
  }
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
    list.innerHTML = j.hits.map((h) => `
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
    const md = esc(String(j.answer || "")).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
    box.innerHTML = `
      <div class="jobs-advice-box">
        <h4>💬 回答</h4>
        <div style="font-size:12px;line-height:1.7;color:#2d2a45;">${md}</div>
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
        </div>
      </div>`).join("");
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

// ============ 初始化 ============
loadCrawlData();
loadStudyPlan();
loadJobs(); // 校招推荐列表
loadDocs(); // 官方文档清单
loadProfileStatus(); // 个人主页存档状态
loadKbStats(); // 知识库统计
loadZhenti(); // 笔试真题
loadOj(); // 专项练习 TOP101
// 轮询爬取进度
setInterval(loadCrawlData, 5000);
// 轮询审批请求（agent 请求敏感操作时弹出确认条）
setInterval(checkApprovals, 2000);
