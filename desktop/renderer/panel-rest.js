// 真白面板 · 个人/题库/专注/初始化域（纵向拆分）
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
    const autoTxt = j?.auto?.applied?.length ? ` · 🔄 已联动：${j.auto.applied.join("、")}` : "";
    profileStatus.textContent = j.ok
      ? `✅ 已存档：技能 ${(j.skills || []).length} 个 · 方向 ${(j.directions || []).join(",") || "未识别"}${autoTxt}`
      : "⚠️ " + (j.error || "保存失败");
    loadProfileStatus();
    if (j.ok && j.auto?.applied?.length) { loadCareerProfile(); loadKnowledgeTree(); loadTreeTemplates(); }
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
      // 区分"未启用"与"空库"
      if (j.enabled === false) {
        statusEl.textContent = "📭 本地知识库未启用——在「⚙️ 设置」开启后自动重建索引（纯关键词检索，秒级）";
      } else {
        statusEl.textContent = "⏳ 知识库为空——后端启动后会自动构建，或点「🔄 重建索引」";
      }
      return;
    }
    const kinds = (j.byKind || []).map((k) => `${KIND_LABEL[k.kind] || k.kind} ${k.n}`).join(" · ");
    statusEl.textContent = `📦 ${j.total} 条（${kinds}）${j.lastBuild ? " · 构建于 " + new Date(j.lastBuild).toLocaleString("zh-CN") : ""}${j.enabled === false ? " · 未启用（设置可开）" : " · 关键词检索"}`;
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
    if (j.disabled) { list.innerHTML = `<div class="empty-hint">📭 知识库未启用——到「⚙️ 设置」开启后即可搜索（纯关键词检索，秒级构建）</div>`; return; }
    if (!j.hits?.length) { list.innerHTML = '<div class="empty-hint">没有命中——换个说法，或点「🔄 重建索引」</div>'; return; }
    list.innerHTML = `<div style="font-size:11px;color:#8a87a8;margin:2px 0 6px;">命中 ${j.hits.length} 条（关键词检索）</div>` +
      j.hits.map((h) => `
      <div class="job-item">
        <div class="job-head">
          <span class="job-badge">${KIND_LABEL[h.kind] || h.kind}</span>
          <b style="font-size:12px;">${esc(h.title)}</b>
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

// ============ 语音输入（🎤）：本地 ASR 转写 → 回填输入框 ============
// 点击开始录音（16kHz 单声道，浏览器自动重采样）→ 再点停止 → IPC 送主进程转写
let micStream = null, micCtx = null, micSource = null, micProc = null;
let micChunks = [], micRecording = false, micAutoStop = null, micStarting = false;

async function stopRecording() {
  micRecording = false;
  clearTimeout(micAutoStop);
  console.log("[panel] 语音停止，已采集 chunk 数:", micChunks.length);
  const micBtn = $("chat-mic");
  micBtn.classList.remove("recording");
  micBtn.textContent = "🎤";
  micBtn.title = "语音输入（点击开始录音，再点停止；识别结果回填输入框）";
  const recordSr = micCtx?.sampleRate || 16000; // 先取采样率，ctx 马上要 close
  try { micSource?.disconnect(); micProc?.disconnect(); } catch { /* ignore */ }
  try { micCtx?.close(); } catch { /* ignore */ }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (!micChunks.length) {
    // 静默失败曾是"语音没反应"的元凶之一（采集回调未触发/音频上下文挂起）
    window.kanban.notify("语音输入", "没有采集到声音——请确认麦克风未被占用，点 🎤 后再说话（说完再点一次停止）");
    return;
  }
  // 拼接 PCM
  const total = micChunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const c of micChunks) { pcm.set(c, off); off += c.length; }
  micChunks = [];
  micBtn.textContent = "⏳";
  micBtn.disabled = true;
  try {
    // ① VAD：裁掉头尾静音——静音/环境噪声直接进 ASR 会被脑补成汉字（识别错误的常见来源）
    console.log(`[panel] VAD 输入: ${pcm.length} 采样（${(pcm.length / 16000).toFixed(2)}s@16k 估算）`);
    // 能量诊断：确认音频是"真静音"还是"低于阈值"（ScriptProcessor 在新 Chromium 可能采到全 0）
    let maxAmp = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i];
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > maxAmp) maxAmp = a;
      if (a > 1e-6) nonZero++;
    }
    console.log(`[panel] 音频能量: rms=${Math.sqrt(sumSq / pcm.length).toFixed(7)} maxAmp=${maxAmp.toFixed(6)} 非零采样=${nonZero}/${pcm.length}（${(nonZero / pcm.length * 100).toFixed(1)}%）`);
    const voiced = window.trimSilenceToVoice ? window.trimSilenceToVoice(pcm, 16000) : pcm;
    console.log(`[panel] VAD 结果: ${voiced ? voiced.length + " 采样" : "null（判定全程静音）"}`);
    const voiceStatus = $("chat-voice-status");
    if (!voiced || voiced.length < 16000 * 0.5) {
      const msg = voiced ? "语音太短（不足半秒），请再说一次" : "没有检测到语音，请靠近麦克风再说一次";
      console.log("[panel] VAD 拦截:", msg);
      if (voiceStatus) { voiceStatus.textContent = "⚠️ " + msg; voiceStatus.style.display = ""; }
      window.kanban.notify("语音输入", msg);
      return;
    }
    if (voiceStatus) voiceStatus.style.display = "none";
    // ② 采样率兜底：AudioContext({sampleRate:16000}) 个别平台会静默退回默认值
    //    （实际是 48k）→ 用 OfflineAudioContext 标准重采样，保证喂给 ASR 的是真 16k
    let input = voiced;
    if (recordSr !== 16000) input = await resampleTo16k(voiced, recordSr);
    console.log(`[panel] 发送识别: ${input.length} 采样（recordSr=${recordSr}）`);
    const r = await window.kanban.speechToText(input);
    console.log("[panel] 识别返回:", JSON.stringify(r));
    if (r?.ok && r.text) {
      $("chat-input").value = r.text;
      $("chat-input").focus();
    } else {
      const msg = r?.error || "识别失败，请重试";
      if (voiceStatus) { voiceStatus.textContent = "⚠️ " + msg; voiceStatus.style.display = ""; }
      window.kanban.notify("语音输入", msg);
    }
  } catch (err) {
    console.error("[panel] 语音流程异常:", err?.message || err);
    window.kanban.notify("语音输入", "调用失败: " + String(err?.message || err).slice(0, 80));
  } finally {
    micBtn.disabled = false;
    micBtn.textContent = "🎤";
  }
}

/** OfflineAudioContext 标准重采样（48k→16k，浏览器高质量 sinc；失败则原样返回兜底） */
async function resampleTo16k(pcm, fromRate) {
  try {
    const len = Math.ceil(pcm.length * 16000 / fromRate);
    const oc = new OfflineAudioContext(1, len, 16000);
    const buf = oc.createBuffer(1, pcm.length, fromRate);
    buf.copyToChannel(pcm, 0);
    const src = oc.createBufferSource();
    src.buffer = buf;
    src.connect(oc.destination);
    src.start();
    const rendered = await oc.startRendering();
    return rendered.getChannelData(0);
  } catch (e) {
    console.warn("[voice-input] 重采样失败，原样送识别:", e?.message || e);
    return pcm;
  }
}

async function startRecording() {
  // 防抖互斥：启动中/录音中再次点击直接忽略（getUserMedia 是异步的，
  // 无此标志快速连点会重复拉起麦克风 → 多路音频叠加、按钮状态错乱）
  if (micRecording || micStarting) return;
  micStarting = true;
  const micBtn = $("chat-mic");
  micBtn.disabled = true; // 启动期间禁用，防止连点
  micBtn.textContent = "⏳";
  console.log("[panel] 语音开始录音…");
  try {
    try {
      // 禁用音频处理链 + 显式选择物理麦克风（默认设备可能无声——实测 MCHOSE 默认=全零）
      const micId = await pickMicDevice();
      const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (micId) audioConstraints.deviceId = { exact: micId };
      console.log("[panel] 使用麦克风:", micId ? micId.slice(0, 24) : "系统默认");
      micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      console.log("[panel] 麦克风不可用:", err?.name || err?.message || err);
      window.kanban.notify("语音输入", "麦克风不可用: " + (err?.name || "请检查系统麦克风权限"));
      return;
    }
    micChunks = [];
    micCtx = new AudioContext({ sampleRate: 16000 }); // 16k（ASR 期望采样率，浏览器自动重采样；个别平台会退回 48k，停止时兜底重采样）
    // 关键：AudioContext 可能处于 suspended（自动播放策略）→ 采集回调（onaudioprocess）不触发
    // → 录不到任何数据且无报错。必须显式 resume（用户点击 🎤 是有效手势，通常可恢复）
    try {
      if (micCtx.state === "suspended") await micCtx.resume();
      if (micCtx.state !== "running") {
        window.kanban.notify("语音输入", "音频上下文未就绪（" + micCtx.state + "），请重试");
        return;
      }
    } catch (e) {
      window.kanban.notify("语音输入", "音频启动失败: " + String(e?.message || e).slice(0, 60));
      return;
    }
  micSource = micCtx.createMediaStreamSource(micStream);
  // AudioWorklet 采集（ScriptProcessor 废弃，在 Electron 43 下 inputBuffer 全零——实测 0/106496 非零采样）
  try {
    await micCtx.audioWorklet.addModule("pcm-worklet.js");
    micProc = new AudioWorkletNode(micCtx, "pcm-capture");
    micProc.port.onmessage = (e) => {
      if (!micRecording) return;
      micChunks.push(e.data); // Float32Array（worklet 已拷贝）
    };
    micSource.connect(micProc);
  } catch (e) {
    console.error("[panel] AudioWorklet 不可用:", e?.message || e);
    window.kanban.notify("语音输入", "音频采集初始化失败: " + String(e?.message || e).slice(0, 60));
    return;
  }
  micRecording = true;
  const micBtn = $("chat-mic");
  micBtn.classList.add("recording");
  micBtn.textContent = "⏹";
  micBtn.title = "点击停止录音";
  // 采集自检：开始 2s 后仍无数据 → 提示麦克风无输入（采集启动有延迟，300ms 会误报）
  setTimeout(() => {
    if (micRecording && !micChunks.length) {
      window.kanban.notify("语音输入", "⚠️ 麦克风没有声音输入——可能被其他应用占用（浏览器/会议软件），请检查后重试");
    }
  }, 2000);
  micAutoStop = setTimeout(() => { if (micRecording) stopRecording(); }, 60000); // 60s 上限自动停
  } finally {
    // 启动结束：恢复按钮（成功 → ⏹ 录音态；失败 → 🎤）；清除互斥标志
    micStarting = false;
    micBtn.disabled = false;
    if (!micRecording) {
      micBtn.textContent = "🎤";
      // 启动失败 → 释放麦克风流与音频上下文（防占用导致下次拉不起）
      if (micStream) { try { micStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } micStream = null; }
      try { micCtx?.close(); } catch { /* ignore */ }
    }
  }
}

$("chat-mic").addEventListener("click", () => {
  console.log("[panel] 🎤 按钮点击，当前录音中:", micRecording);
  micRecording ? stopRecording() : startRecording();
});

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
    const goalInput = $("focus-goal");
    const goal = goalInput?.value.trim() || ""; // 输入框缺失时不崩（HTML 改动后一般存在）
    const res = await fetch("http://127.0.0.1:8899/api/focus/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, goal }),
    });
    const j = await res.json();
    if (!j.ok) { $("focus-status").textContent = "⚠️ " + (j.error || "开始失败"); return; }
    if (goalInput) goalInput.value = "";
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
    // 按紧迫度分组：48h 内最急 → 本周 → 更远 → 时间待定（邀约未给明确时间）
    const now = Date.now();
    const H = 3600 * 1000, D = 24 * H;
    const groups = [
      { key: "urgent", label: "⏰ 48 小时内（最急）", items: [] },
      { key: "week", label: "📅 本周", items: [] },
      { key: "later", label: "🗓 更远", items: [] },
      { key: "tbd", label: "⏳ 时间待定（邀约未给明确时间）", items: [] },
    ];
    for (const ev of events) {
      const at = Number(ev.interviewAt) || 0;
      if (!at) groups[3].items.push(ev);
      else if (at - now <= 48 * H) groups[0].items.push(ev);
      else if (at - now <= 7 * D) groups[1].items.push(ev);
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

