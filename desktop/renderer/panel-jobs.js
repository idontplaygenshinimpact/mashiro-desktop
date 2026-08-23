// 真白面板 · 求职/设置域（纵向拆分）
/* exported loadLoop, loadLoopBar, loadDocsProject, startJobsSchedTimer, stopJobsSchedTimer, loadSettings */
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

// 日程周期刷新（jobs Tab 停留时每分钟拉一次——邀约识别/岗位笔试随时可能新增）
let jobsSchedTimer = null;
function startJobsSchedTimer() {
  if (jobsSchedTimer) return;
  jobsSchedTimer = setInterval(() => { try { loadSchedule(); } catch { /* ignore */ } }, 60000);
}
function stopJobsSchedTimer() {
  if (jobsSchedTimer) { clearInterval(jobsSchedTimer); jobsSchedTimer = null; }
}

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
      $("set-patrol-budget").value = String(r.dailyTokenBudget ?? 100000);
      $("set-patrol-avoid-peak").checked = !!r.avoidPeak;
      const used = r.usedToday || 0;
      const budget = r.dailyTokenBudget ?? 100000;
      const budgetTxt = budget > 0 ? ` · 今日 token ${used}/${budget}${used >= budget ? "（已用尽）" : ""}` : " · token 不限";
      $("set-patrol-status").textContent = r.enabled
        ? `每 ${r.intervalMin} 分钟${r.nextRun ? " · 下次 " + new Date(r.nextRun).toLocaleString("zh-CN", { hour12: false }) : ""}${r.avoidPeak ? "（避开 DS 高峰）" : ""}${budgetTxt}`
        : (r.note || "已关闭") + budgetTxt;
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
    $("set-mail-enabled").checked = !!j.config?.enabled;
    $("set-mail-status").textContent = j.config?.configured ? `✅ 已配置 ${j.config.email}${j.config.enabled === false ? "（自动检查已关）" : ""}` : "未配置";
  } catch { /* ignore */ }
  // 本地知识库（RAG）开关
  try {
    const r = await window.kanban.ragConfig();
    if (r?.ok) {
      $("set-rag-enabled").checked = !!r.enabled;
      $("set-rag-status").textContent = r.enabled
        ? `✅ 已开启 · ${r.assets} 条资产（纯关键词检索，0 内存）`
        : `已关闭（0 内存占用）${r.assets > 0 ? ` · 库内仍有 ${r.assets} 条历史数据，开启后自动重建` : ""}`;
    }
  } catch { /* ignore */ }
  // 通知提醒开关（复习到期 / 定时学习）
  try {
    const r = await fetch("http://127.0.0.1:8899/api/settings/reminders");
    const j = await r.json();
    if (j?.ok) {
      $("set-notify-review").checked = !!j.reviewReminder;
      $("set-notify-study").checked = !!j.studyReminder;
      $("set-notify-status").textContent = j.reviewReminder || j.studyReminder ? "✅ 已生效" : "已全部关闭";
    }
  } catch { /* ignore */ }
  // 简历项目源码（面试官拷打素材）
  try {
    const r = await fetch("http://127.0.0.1:8899/api/settings/personal-projects");
    const j = await r.json();
    if (j?.ok) {
      const lines = (j.projects || []).map((p) => `${p.name}=${p.dir}`).join("\n");
      $("set-personal-projects").value = lines;
      $("set-personal-projects-status").textContent = j.projects?.length
        ? `✅ ${j.projects.length} 个项目已接入（面试官会基于真实代码拷打）`
        : "未配置——填项目名=源码目录后保存";
    }
  } catch { /* ignore */ }
  // 桌宠
  loadSettingsMascot();
  // 方向画像（讲解/面试/考点提炼角度）
  loadCareerProfile();
  // 知识树（掌握度骨架）
  loadKnowledgeTree();
  loadTreeTemplates();
  // LLM API Key
  loadLlmKeyStatus();
  // 项目路径
  try {
    const r = await fetch("http://127.0.0.1:8899/api/learning/project");
    const j = await r.json();
    if (j?.ok && j.path) $("set-docs-project").value = j.path;
  } catch { /* ignore */ }
  // 插件管理 + 插件市场（阶段 3）
  loadPluginsAdmin();
  loadPluginMarket();
  // 数据备份（自动/手动备份 + 列表 + 恢复）
  loadBackups();
}

// ============ 💾 数据备份（数据安全：自动/手动备份 + 列表 + 恢复，重启生效） ============
async function loadBackups() {
  const box = $("backup-list");
  if (!box) return;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/backups");
    const j = await r.json();
    const list = (j?.ok && Array.isArray(j.backups)) ? j.backups : [];
    const last = list[0];
    const statusEl = $("set-maintain-status");
    if (statusEl) {
      statusEl.textContent = last
        ? `✅ 最近备份：${new Date(last.createdAt).toLocaleString("zh-CN", { hour12: false })}（${last.reason === "auto" ? "自动" : last.reason === "pre-restore" ? "恢复前快照" : "手动"} · ${last.files.length} 项）`
        : "未备份——建议点「💾 立即备份」（之后每天自动备份一次）";
    }
    box.innerHTML = list.slice(0, 8).map((b) => `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid rgba(138,90,220,.15);border-radius:8px;padding:6px 8px;background:rgba(20,18,36,.4);font-size:11px;">
        <span style="color:#8a87a8;">${b.reason === "auto" ? "🤖 自动" : b.reason === "pre-restore" ? "🛟 恢复前快照" : "👆 手动"}</span>
        <span>${esc(new Date(b.createdAt).toLocaleString("zh-CN", { hour12: false }))}</span>
        <span style="color:#8a87a8;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((b.files || []).join("、"))}</span>
        <button class="secondary" style="margin-left:auto;padding:3px 10px;font-size:10px;" data-restore="${esc(b.name)}">↩️ 恢复</button>
      </div>`).join("") || '<div style="color:#8a87a8;font-size:11px;">暂无备份</div>';
    box.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const name = btn.dataset.restore;
        if (!confirm("恢复会把数据替换为该备份的版本（替换前自动备份当前状态作安全网），重启桌宠后生效。确认恢复？")) return;
        try {
          const rr = await fetch("http://127.0.0.1:8899/api/backups/restore", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          const jj = await rr.json();
          window.kanban?.notify?.("💾 数据恢复", jj?.ok ? "已标记恢复——重启桌宠后自动生效" : String(jj?.error || "恢复失败"));
        } catch (e) {
          window.kanban?.notify?.("💾 数据恢复", "恢复失败：" + String(e.message));
        }
        loadBackups();
      });
    });
  } catch { /* 旧版后台服务无备份接口 */ }
}

// 立即备份按钮（面板加载时绑定一次）
document.getElementById("set-backup-now")?.addEventListener("click", async () => {
  const btn = $("set-backup-now");
  const statusEl = $("set-maintain-status");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "⏳ 备份中…";
  if (statusEl) statusEl.textContent = "备份中（WAL checkpoint + 复制存档）…";
  try {
    const r = await fetch("http://127.0.0.1:8899/api/backup", { method: "POST" });
    const j = await r.json();
    if (statusEl) statusEl.textContent = j?.ok ? `✅ ${j.note}（${j.name}）` : `⚠️ ${j?.error || "备份失败"}`;
    window.kanban?.notify?.("💾 数据备份", j?.ok ? "备份完成" : String(j?.error || "备份失败"));
  } catch (e) {
    if (statusEl) statusEl.textContent = "⚠️ 备份失败：" + String(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "💾 立即备份";
    loadBackups();
  }
});

// ============ 🧩 插件管理（阶段 3：已装插件列表/启停/健康） ============
let __installedPluginIds = new Set();
async function loadPluginsAdmin() {
  const box = $("plugin-admin-list");
  if (!box) return;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/plugins");
    const j = await r.json();
    if (!j?.ok || !Array.isArray(j.plugins)) {
      box.innerHTML = '<div style="color:#8a87a8;font-size:12px;">后台服务未返回插件列表（旧版服务，重启桌宠后可用）</div>';
      return;
    }
    __installedPluginIds = new Set(j.plugins.map((p) => p.id));
    box.innerHTML = j.plugins.map((p) => {
      const load = p.load || {};
      const status = load.ok
        ? '<span style="color:#5fd85f;">✅ 已加载</span>'
        : `<span style="color:#e07a5f;">⚠️ ${esc(load.error || "加载失败")}</span>`;
      const health = load.health?.ok === false
        ? `<div style="margin-top:2px;"><span style="color:#e0a95f;font-size:11px;">健康检查异常：${esc(load.health.detail || "")}</span></div>`
        : (load.health?.detail ? `<div style="margin-top:2px;font-size:11px;color:#8a87a8;">健康：${esc(load.health.detail)}</div>` : "");
      const tabs = (p.panel?.tabs || []).map((t) => t.label).join("、");
      return `<div style="border:1px solid rgba(138,90,220,.18);border-radius:10px;padding:8px 10px;background:rgba(20,18,36,.5);">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-weight:600;font-size:12px;">${esc(p.name)}</span>
          <span style="font-size:10px;color:#8a87a8;">v${esc(p.version || "?")} · ${esc(p.id)}</span>
          ${status}
          <label style="margin-left:auto;display:flex;gap:5px;align-items:center;font-size:11px;color:#4a3a9d;cursor:pointer;" title="停用/启用后重启桌宠生效">
            <input type="checkbox" data-plg-toggle="${esc(p.id)}" ${p.disabled ? "" : "checked"} style="width:14px;height:14px;accent-color:#6d4fd8;"> 启用
          </label>
        </div>
        ${p.description ? `<div style="font-size:11px;color:#8a87a8;margin-top:4px;">${esc(p.description)}</div>` : ""}
        <div style="font-size:11px;color:#8a87a8;margin-top:4px;">${tabs ? `面板 tab：${esc(tabs)}` : "无面板声明"}${p.schedules?.length ? ` · 定时任务 ${p.schedules.length} 个` : ""}</div>
        ${health}
      </div>`;
    }).join("");
    box.querySelectorAll("[data-plg-toggle]").forEach((cb) => {
      cb.addEventListener("change", async () => {
        const id = cb.dataset.plgToggle;
        const enabled = cb.checked;
        try {
          const r = await fetch("http://127.0.0.1:8899/api/plugins/toggle", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, enabled }),
          });
          await r.json();
          window.kanban?.notify?.("🧩 插件管理", `${enabled ? "已启用" : "已停用"}「${id}」——重启桌宠后生效`);
        } catch { /* ignore */ }
        loadPluginsAdmin();
      });
    });
  } catch (e) {
    box.innerHTML = `<div style="color:#e07a5f;font-size:12px;">加载失败：${esc(e.message)}</div>`;
  }
}

// ============ 🛒 插件市场（阶段 3：一键安装） ============
async function loadPluginMarket() {
  const box = $("plugin-market-list");
  if (!box) return;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/plugins/market");
    const j = await r.json();
    const list = (j?.ok && Array.isArray(j.plugins)) ? j.plugins : [];
    if (!list.length) {
      box.innerHTML = '<div style="color:#8a87a8;font-size:12px;">市场暂无可安装插件（data/plugin-market.json）</div>';
      return;
    }
    box.innerHTML = list.map((p) => {
      const installed = __installedPluginIds.has(p.id);
      return `<div style="border:1px solid rgba(138,90,220,.18);border-radius:10px;padding:8px 10px;background:rgba(20,18,36,.5);">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-weight:600;font-size:12px;">${esc(p.name)}</span>
          <span style="font-size:10px;color:#8a87a8;">v${esc(p.version || "?")}</span>
          <button class="secondary" style="margin-left:auto;padding:5px 12px;font-size:11px;" data-plg-install="${esc(p.id)}" ${installed ? "disabled" : ""}>${installed ? "✅ 已安装" : "📥 安装"}</button>
        </div>
        <div style="font-size:11px;color:#8a87a8;margin-top:4px;">${esc(p.description || "")}</div>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-plg-install]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.plgInstall;
        btn.disabled = true;
        btn.textContent = "⏳ 安装中…";
        try {
          const r = await fetch("http://127.0.0.1:8899/api/plugins/install", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          const j = await r.json();
          if (j?.ok) {
            btn.textContent = "✅ 已安装";
            window.kanban?.notify?.("🧩 插件市场", `${j.name || id} 已安装——重启桌宠后生效`);
            loadPluginsAdmin();
          } else {
            btn.textContent = "⚠️ 失败";
            window.kanban?.notify?.("🧩 插件市场", String(j?.error || "安装失败"));
            setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = "📥 安装"; } }, 3000);
          }
        } catch {
          btn.textContent = "⚠️ 失败";
          setTimeout(() => { if (btn.isConnected) { btn.disabled = false; btn.textContent = "📥 安装"; } }, 3000);
        }
      });
    });
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

// 知识树方向模板（前端/后端/算法一键切换）
async function loadTreeTemplates() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/knowledge/templates");
    const j = await r.json();
    if (!j?.ok) return;
    const box = $("set-tree-templates");
    if (!box) return;
    box.innerHTML = "";
    for (const t of j.templates) {
      const a = document.createElement("a");
      a.href = "javascript:void(0)";
      a.style.cssText = "margin-right:8px;text-decoration:none;font-weight:600;color:" + (t.current ? "#6d4fd8" : "#8a87a8") + ";cursor:pointer;";
      a.textContent = t.name + (t.current ? "（当前）" : "");
      if (!t.current) {
        a.onclick = async () => {
          const rr = await fetch("http://127.0.0.1:8899/api/knowledge/load-template", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: t.name }),
          });
          const jj = await rr.json();
          $("set-tree-status").textContent = jj.ok ? (jj.message || "✅ 已切换") : "⚠️ " + (jj.error || "切换失败");
          if (jj.ok) { loadKnowledgeTree(); loadTreeTemplates(); }
        };
      }
      box.appendChild(a);
    }
  } catch { /* ignore */ }
}

// ============ 🔑 LLM API Key（设置中心配置，无需改 .env） ============
async function loadLlmKeyStatus() {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/settings/llm");
    const j = await r.json();
    if (!j?.ok) return;
    $("set-llm-key-status").textContent = j.hasKey
      ? `✅ 已配置（${j.masked}）· ${j.baseUrl} / ${j.model}`
      : "未配置（当前用 .env / 环境变量）· " + j.baseUrl + " / " + j.model;
    // 回填当前生效地址/模型（自定义才回填，默认值只展示不占输入框）
    if (j.baseUrlCustom) $("set-llm-base").value = j.baseUrl;
    if (j.modelCustom) $("set-llm-model").value = j.model;
  } catch { /* ignore */ }
}
$("set-llm-key-save")?.addEventListener("click", async () => {
  const btn = $("set-llm-key-save");
  btn.disabled = true;
  try {
    const apiKey = $("set-llm-key").value.trim();
    const r = await fetch("http://127.0.0.1:8899/api/settings/llm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const j = await r.json();
    $("set-llm-key-status").textContent = j.ok ? j.message : "⚠️ " + (j.error || "保存失败");
    if (j.ok) $("set-llm-key").value = "";
  } catch (e) {
    $("set-llm-key-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
  }
});
// Base URL + 模型名保存（配了地址 = 单端点直连该服务，不再 fallback 官方）
$("set-llm-base-save")?.addEventListener("click", async () => {
  const btn = $("set-llm-base-save");
  btn.disabled = true;
  try {
    const r = await fetch("http://127.0.0.1:8899/api/settings/llm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: $("set-llm-base").value.trim(), model: $("set-llm-model").value.trim() }),
    });
    const j = await r.json();
    $("set-llm-base-status").textContent = j.ok ? j.message : "⚠️ " + (j.error || "保存失败");
    if (j.ok) loadLlmKeyStatus();
  } catch (e) {
    $("set-llm-base-status").textContent = "⚠️ " + e.message;
  } finally {
    btn.disabled = false;
  }
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
    const autoTxt = j?.auto?.applied?.length ? ` · 🔄 已联动：${j.auto.applied.join("、")}` : "";
    $("set-direction-status").textContent = j.ok
      ? `✅ 已保存${autoTxt}${j.advice ? "，建议：" + String(j.advice).slice(0, 60) + "…" : ""}`
      : "⚠️ " + (j.error || "保存失败");
    if (j.ok) { loadCareerProfile(); loadKnowledgeTree(); loadTreeTemplates(); }
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
$("set-patrol-budget")?.addEventListener("change", async () => {
  const v = parseInt($("set-patrol-budget").value, 10);
  const r = await window.kanban.patrolConfig({ dailyTokenBudget: Number.isFinite(v) && v >= 0 ? v : 0 });
  if (r?.ok) {
    const used = r.usedToday || 0;
    const b = r.dailyTokenBudget ?? 0;
    $("set-patrol-status").textContent = b > 0
      ? `✅ 每日 token 上限 ${b}（今日已用 ${used}）${used >= b ? " · 已用尽" : ""}`
      : "✅ token 不限（0）";
  } else {
    $("set-patrol-status").textContent = "⚠️ " + (r?.error || "保存失败");
  }
});
// 避开 DS 峰时开关（峰谷计价：峰时 09:00-12:00 + 14:00-18:00 价格 2 倍，谷时半价）
$("set-patrol-avoid-peak")?.addEventListener("change", async () => {
  const on = $("set-patrol-avoid-peak").checked;
  const r = await window.kanban.patrolConfig({ avoidPeak: on });
  if (r?.ok) {
    $("set-patrol-status").textContent = on ? "✅ 已开启：峰时（09:00-12:00 / 14:00-18:00）自动推迟巡检，谷时半价" : "已关闭（峰时也会巡检，价格 2 倍）";
  } else {
    $("set-patrol-avoid-peak").checked = !on;
    $("set-patrol-status").textContent = "⚠️ " + (r?.error || "保存失败");
  }
});

// 本地知识库（RAG）开关
$("set-rag-enabled")?.addEventListener("change", async () => {
  const on = $("set-rag-enabled").checked;
  const r = await window.kanban.ragConfig({ enabled: on });
  if (r?.ok) {
    $("set-rag-status").textContent = on
      ? "✅ 已开启，索引自动重建（秒级，纯关键词检索）"
      : "已关闭（0 内存占用）";
  } else {
    $("set-rag-enabled").checked = !on;
    $("set-rag-status").textContent = "⚠️ " + (r?.error || "保存失败");
  }
});

// 通知提醒开关（复习到期 / 定时学习）
async function saveReminderSwitch(key, on) {
  try {
    const r = await fetch("http://127.0.0.1:8899/api/settings/reminders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: on }),
    });
    const j = await r.json();
    $("set-notify-status").textContent = j.ok ? "✅ 已保存" : "⚠️ " + (j.error || "保存失败");
    if (!j.ok) {
      if (key === "reviewReminder") $("set-notify-review").checked = !on;
      else $("set-notify-study").checked = !on;
    }
  } catch (e) {
    $("set-notify-status").textContent = "⚠️ " + e.message;
    if (key === "reviewReminder") $("set-notify-review").checked = !on;
    else $("set-notify-study").checked = !on;
  }
}
$("set-notify-review")?.addEventListener("change", (e) => saveReminderSwitch("reviewReminder", e.target.checked));
$("set-notify-study")?.addEventListener("change", (e) => saveReminderSwitch("studyReminder", e.target.checked));

// 简历项目源码（面试官拷打素材）：保存 → 生成档案进知识库
$("set-personal-projects-save")?.addEventListener("click", async () => {
  const btn = $("set-personal-projects-save");
  btn.disabled = true;
  try {
    // 解析 "项目名=目录" 每行
    const projects = $("set-personal-projects").value.split("\n")
      .map((s) => s.trim()).filter(Boolean)
      .map((s) => {
        const eq = s.indexOf("=");
        return eq > 0 ? { name: s.slice(0, eq).trim(), dir: s.slice(eq + 1).trim() } : null;
      }).filter(Boolean);
    if (!projects.length) {
      $("set-personal-projects-status").textContent = "⚠️ 请至少填一行 项目名=目录";
      return;
    }
    const r = await fetch("http://127.0.0.1:8899/api/settings/personal-projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projects }),
    });
    const j = await r.json();
    if (j.ok) {
      $("set-personal-projects-status").textContent = `${j.message}（${j.indexed?.ok || 0} 成功${j.indexed?.fail ? ` / ${j.indexed.fail} 失败` : ""}）`;
    } else {
      $("set-personal-projects-status").textContent = "⚠️ " + (j.error || "保存失败");
    }
  } catch (e) { $("set-personal-projects-status").textContent = "⚠️ " + e.message; }
  finally { btn.disabled = false; }
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

// 邮箱保存/测试（共用 mail API）；enabled=自动检查开关（每 30 分钟拉取）
$("set-mail-save")?.addEventListener("click", async () => {
  const email = $("set-mail-email").value.trim();
  const authCode = $("set-mail-authcode").value.trim();
  if (!email || !authCode) { $("set-mail-status").textContent = "⚠️ 请填写邮箱和授权码；要改开关可直接点上面复选框"; return; }
  try {
    const r = await fetch("http://127.0.0.1:8899/api/mail/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, authCode, enabled: $("set-mail-enabled").checked }),
    });
    const j = await r.json();
    $("set-mail-status").textContent = j.ok ? `✅ 已保存：${email}${$("set-mail-enabled").checked ? "" : "（自动检查已关）"}` : "⚠️ " + (j.error || "保存失败");
    if (j.ok) $("set-mail-authcode").value = "";
  } catch (e) { $("set-mail-status").textContent = "⚠️ " + e.message; }
});
$("set-mail-enabled")?.addEventListener("change", async () => {
  // 只切开关（保留已有凭据）：setConfig 未提交 email/authCode 时保留
  try {
    const r = await fetch("http://127.0.0.1:8899/api/mail/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: $("set-mail-enabled").checked }),
    });
    const j = await r.json();
    $("set-mail-status").textContent = j.ok ? `✅ 自动检查已${$("set-mail-enabled").checked ? "开启" : "关闭"}` : "⚠️ " + (j.error || "保存失败");
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

