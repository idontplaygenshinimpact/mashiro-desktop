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
  if (extension === ".pdf") {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => (it.str || "")).filter(Boolean).join(" "));
    }
    const text = pages.join("\n").trim();
    if (!text) throw new Error("PDF 没有可提取文本，可能是图片型 PDF，请复制文本粘贴");
    return { text, msg: `已解析 PDF 简历（${pdf.numPages} 页）` };
  }
  if (extension === ".doc") throw new Error("暂不支持旧版 .doc，请另存为 .docx");
  if (extension === ".docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const buffer = await file.arrayBuffer();
    const result = await mammoth.default.extractRawText({ arrayBuffer: buffer });
    const text = result.value.trim();
    if (!text) throw new Error("Word 文件中没有可分析文本");
    return { text, msg: "已解析 Word 简历" };
  }
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
    <div>🎯 维度：${r.dimension || "-"}</div>
    <div>📌 依据：${r.basis || "-"}</div>
    <div>✅ 合格标准：${r.criteria || "-"}</div>
    <div>🚧 边界：${r.boundary || "-"}</div>`;
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
    // 评分展示
    if (r.scores) {
      $("iv-scores").innerHTML = `
        <div class="score-chip">技术 <b>${r.scores.tech}</b></div>
        <div class="score-chip">表达 <b>${r.scores.expr}</b></div>
        <div class="score-chip">深度 <b>${r.scores.depth}</b></div>
        <div class="score-chip">边界 <b>${r.scores.edge}</b></div>
        <div class="score-chip">复盘 <b>${r.scores.reflect}</b></div>
        <div class="score-chip">总分 <b>${r.total}</b></div>`;
    }
    if (r.comment) $("iv-scores").insertAdjacentHTML("beforeend", `<div class="iv-comment">💬 ${r.comment}</div>`);
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
}

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
  if (!items.length) {
    list.innerHTML = '<div style="color:#7c7c7c;font-size:12px">未生成，点「✨ 从产出生成清单」</div>';
    return;
  }
  // 按层级分组：必会 → 进阶 → 拓展（未标 level 的归必会）
  const groups = [
    { level: "必会", label: "🔴 必会 · 高频核心", cls: "lv-must", items: [] },
    { level: "进阶", label: "🟡 进阶 · 原理深挖", cls: "lv-adv", items: [] },
    { level: "拓展", label: "🟢 拓展 · 加分新方向", cls: "lv-ext", items: [] },
  ];
  for (const it of items) {
    const g = groups.find((x) => x.level === (it.level || "必会")) || groups[0];
    g.items.push(it);
  }
  const renderItem = (it) => `
    <div class="study-item ${it.done ? "done" : ""}" data-id="${it.id}">
      <input type="checkbox" ${it.done ? "checked" : ""} />
      <div style="flex:1">
        <div class="s-topic">${esc(it.topic)} ${it.fromInterview ? '<span class="s-src">面试</span>' : ""}</div>
        <div class="s-why">${esc(it.why || "")}</div>
      </div>
      <button class="s-learn" data-id="${it.id}">${it.hasFile ? "📖 学习" : "💡 讲解"}</button>
      <span class="s-badge ${it.reviewed ? "reviewed" : ""}">${it.reviewed ? "已复盘" : "待学"}</span>
    </div>`;
  list.innerHTML = groups
    .filter((g) => g.items.length)
    .map((g) => `
      <div class="study-group">
        <div class="sg-head ${g.cls}">${g.label} <span class="sg-count">${g.items.length}</span></div>
        ${g.items.map(renderItem).join("")}
      </div>`).join("");
  list.querySelectorAll(".study-item").forEach((el) => {
    const cb = el.querySelector("input");
    cb.addEventListener("change", async (e) => {
      // 归并模式：勾选用于归并选择（不改变完成状态）
      if (clusterMode) {
        el.classList.toggle("cluster-selected", e.target.checked);
        updateClusterBtn();
        return;
      }
      const r = await window.kanban.studyCheck(el.dataset.id, e.target.checked);
      // 本地更新状态（不整表重渲染，避免闪烁）
      el.classList.toggle("done", e.target.checked);
      // 真白情感反馈（庆祝/安慰）+ 语音
      if (r?.emotion) {
        window.kanban.notify("🎀 真白", r.emotion);
        if (voiceOn) window.kanban.speak(r.emotion);
      }
    });
    el.querySelector(".s-learn").addEventListener("click", () => showStudyDetail(el.dataset.id));
  });
}

// ============ 多条目归并（主题簇） ============
let clusterMode = false;
const clusterBtn = () => $("study-cluster-btn");

function updateClusterBtn() {
  const n = document.querySelectorAll(".study-item.cluster-selected").length;
  clusterBtn().textContent = n >= 2 ? `🔗 归并(${n})` : "🔗 归并";
}

clusterBtn().addEventListener("click", async () => {
  if (!clusterMode) {
    // 进入多选模式
    clusterMode = true;
    clusterBtn().textContent = "✅ 确认归并";
    clusterBtn().classList.add("cluster-active");
    // 提示 + 清空之前选择
    document.querySelectorAll(".study-item.cluster-selected").forEach((el) => el.classList.remove("cluster-selected"));
    document.querySelectorAll(".study-item input").forEach((cb) => { cb.checked = false; });
    window.kanban.notify("🔗 归并模式", "勾选 2+ 个相关条目（如 MySQL底层/B+树/回表）后点「确认归并」");
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
      sdBody().scrollTop = 0;
      return;
    }
    // 流式获取（SSE）：逐段渲染，无文件条目也能边生成边看
    const topic = await streamStudyDetail(id, (content) => {
      sdBody().innerHTML = renderMd(content) + '<div class="sd-streaming">⏳ 生成中...</div>';
      sdBody().scrollTop = sdBody().scrollHeight; // 生成中跟随最新内容
    });
    $("sd-modal-title").textContent = "📖 " + topic;
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
    // 标题
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { html += `<h4>${inlineMd(h[2])}</h4>`; continue; }
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
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code class='sd-inline-code'>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

$("study-gen").addEventListener("click", async () => {
  $("study-gen").disabled = true;
  $("study-gen").textContent = "生成中...";
  await window.kanban.studyGenerate();
  loadStudyPlan();
  $("study-gen").disabled = false;
  $("study-gen").textContent = "✨ 从产出生成清单";
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

// ============ 语音开关 ============
let voiceOn = true;
$("voice-btn").addEventListener("click", () => {
  voiceOn = !voiceOn;
  window.kanban.setVoiceEnabled(voiceOn);
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
        <div class="job-actions">
          ${job.applyUrl ? `<a class="job-link" href="${esc(job.applyUrl)}" target="_blank" rel="noopener">🔗 去投递</a>` : ""}
          <button class="job-btn" data-id="${job.id}" data-status="ready">📮 已投递</button>
          <button class="job-btn" data-id="${job.id}" data-status="ready_bishi">✍️ 待笔试</button>
          <button class="job-btn" data-id="${job.id}" data-status="done">✅ 完成</button>
        </div>
      </div>`).join("");
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
              <a class="job-link" href="${esc(s.official)}" target="_blank" rel="noopener">🔗 官方文档</a>
              ${s.versionPage && s.versionPage !== s.official ? `<a class="job-link" href="${esc(s.versionPage)}" target="_blank" rel="noopener">📄 版本页</a>` : ""}
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

// ============ 初始化 ============
loadCrawlData();
loadStudyPlan();
loadJobs(); // 校招推荐列表
loadDocs(); // 官方文档清单
loadProfileStatus(); // 个人主页存档状态
loadKbStats(); // 知识库统计
// 轮询爬取进度
setInterval(loadCrawlData, 5000);
// 轮询审批请求（agent 请求敏感操作时弹出确认条）
setInterval(checkApprovals, 2000);
