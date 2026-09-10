// React 版校招 Tab（前端三态并行展示工单任务 2 · S3：岗位列表 + 筛选 + 投递状态）
// 同一数据源与路由（与原 panel-jobs.js 的 loadJobs 同接口）：
//   GET  /api/jobs/recommended（默认，技术岗 + 匹配排序）· GET /api/jobs?status=xxx
//   POST /api/jobs/favorite { id, favorite } · POST /api/jobs/status { id, status }
// ⚛️ React 特性：useDeferredValue 过滤输入 + useMemo 派生筛选/统计（原生是 innerHTML 拼串 + 全量重渲染）
// 范围说明：JD 反推考点/按岗面试等 agent 流程仍走原生渲染层（点按钮切回原生打开），
//   S3 只做"岗位列表 + 筛选 + 投递状态"这条主链路，避免两套实现分叉。
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

const DIRECTION_LABEL = { frontend: "前端", agent: "AI Agent", fullstack: "全栈", backend: "后端", algorithm: "算法" };
const STATUS_LABEL = { ready: "📮 已投递", ready_bishi: "✍️ 待笔试", favor: "⭐ 收藏", none: "未处理" };
const STATUS_FILTERS = [["", "全部"], ["ready", "📮 已投递"], ["ready_bishi", "✍️ 待笔试"], ["none", "未处理"]];

export function JobsPanel() {
  const [jobs, setJobs] = useState([]);
  const [status, setStatus] = useState("");
  const [onlyFav, setOnlyFav] = useState(false);
  const [q, setQ] = useState("");
  const deferredQ = useDeferredValue(q); // ⚛️ 输入即时，过滤延后
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [openJd, setOpenJd] = useState({}); // id → 展开 JD

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const j = status
        ? await api(`/api/jobs?status=${encodeURIComponent(status)}`)
        : await api("/api/jobs/recommended");
      setJobs(j?.recommended || j?.jobs || []);
    } catch (e) {
      setErr("岗位读取失败：" + String(e?.message || e).slice(0, 80));
      setJobs([]);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { load(); }, [status]);

  /** 收藏/取消（同一路由；乐观更新 + 失败回滚并提示） */
  async function toggleFav(job) {
    const next = !job.favorite;
    setJobs((list) => list.map((x) => (x.id === job.id ? { ...x, favorite: next } : x)));
    try {
      await api("/api/jobs/favorite", { method: "POST", body: { id: job.id, favorite: next } });
    } catch (e) {
      setJobs((list) => list.map((x) => (x.id === job.id ? { ...x, favorite: !next } : x)));
      window.kanban?.notify?.("⭐ 收藏失败", String(e?.message || e).slice(0, 60));
    }
  }

  /** 投递状态流转（同一路由） */
  async function setJobStatus(job, next) {
    try {
      await api("/api/jobs/status", { method: "POST", body: { id: job.id, status: next } });
      setJobs((list) => list.map((x) => (x.id === job.id ? { ...x, status: next, appliedAt: next === "ready" ? Date.now() : x.appliedAt } : x)));
    } catch (e) {
      setErr("状态更新失败：" + String(e?.message || e).slice(0, 60));
    }
  }

  /** agent 流程（JD 反推考点/按岗面试）复用原生：切回原生渲染层，不重复实现 */
  function openInNative(id, kind) {
    window.switchRenderer?.("jobs", "native");
    const fn = kind === "study" ? window.jobLoopStudy : window.jobLoopInterview;
    if (typeof fn === "function") fn(id);
    else window.kanban?.notify?.("🎨 渲染层", "已切回原生渲染层，请在原生界面继续该操作");
  }

  // ⚛️ 派生：搜索（题目/公司）+ 收藏过滤 + 统计
  const { visible, stats } = useMemo(() => {
    const query = deferredQ.trim().toLowerCase();
    const list = jobs.filter((j) => {
      if (onlyFav && !j.favorite) return false;
      if (!query) return true;
      return `${j.company || ""} ${j.title || ""} ${j.summary || ""}`.toLowerCase().includes(query);
    });
    return {
      visible: list,
      stats: { total: jobs.length, fav: jobs.filter((j) => j.favorite).length, applied: jobs.filter((j) => j.status === "ready").length },
    };
  }, [jobs, deferredQ, onlyFav]);

  return (
    <div className="rf-stack">
      <div className="rf-card">
        <div className="rf-head">
          <b className="rf-title">🏢 校招岗位 · React 版</b>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="rf-muted">{stats.total} 个岗位 · 收藏 {stats.fav} · 已投 {stats.applied}</span>
            <button type="button" className="rf-btn" onClick={load} disabled={busy}>{busy ? "刷新中…" : "🔄 刷新"}</button>
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="rf-input rf-grow"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索公司 / 岗位 / 摘要…"
            aria-label="搜索岗位"
          />
          <select className="rf-input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="按投递状态筛选">
            {STATUS_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <label className="rf-muted" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={onlyFav} onChange={(e) => setOnlyFav(e.target.checked)} aria-label="只看收藏岗位" /> 只看收藏
          </label>
          <button type="button" className="rf-btn" onClick={() => window.switchRenderer?.("jobs", "native")} title="搜集校招等抓取操作在原生渲染层">🔍 搜集校招（原生）</button>
        </div>
        {err && <div className="rf-muted rf-chip-warn" style={{ marginTop: 6 }}>⚠️ {err}</div>}
      </div>

      <div className="rf-card">
        {visible.length === 0 ? (
          <div className="rf-muted">{jobs.length === 0 ? "暂无岗位——点「🔍 搜集校招」（原生）抓取，或先在设置里填简历/方向" : "没有匹配的岗位，试试清空搜索或换筛选"}</div>
        ) : (
          visible.map((job) => (
            <div key={job.id} className="rf-row rf-row-start">
              <span className="rf-grow">
                <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <b className="rf-title">{job.company}</b>
                  <span>{job.title}</span>
                  <span className="rf-chip">{DIRECTION_LABEL[job.direction] || job.direction || "未标方向"}</span>
                  <span className="rf-chip rf-chip-info">匹配 {job.match || "—"}</span>
                  {job.favorite && <span className="rf-chip rf-chip-warn">⭐ 收藏</span>}
                  <span className="rf-chip rf-chip-plain">{STATUS_LABEL[job.status] || job.status || "未处理"}</span>
                </span>
                {(job.jobType || job.deadline || job.bishiDate) && (
                  <span className="rf-muted" style={{ display: "block", marginTop: 3 }}>
                    {job.jobType && <span>{job.jobType} </span>}
                    {job.deadline && <span>⏰ 截止 {job.deadline} </span>}
                    {job.bishiDate && <span>📝 笔试 {job.bishiDate}</span>}
                  </span>
                )}
                {job.summary && <span className="rf-muted" style={{ display: "block", marginTop: 3 }}>{job.summary}</span>}
                {job.jdText && openJd[job.id] && (
                  <pre className="rf-report rf-sub" style={{ marginTop: 6 }}>{job.jdText}</pre>
                )}
              </span>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="rf-btn"
                  onClick={() => toggleFav(job)}
                  title={job.favorite ? "取消收藏" : "收藏该岗位"}
                  aria-label={job.favorite ? `取消收藏 ${job.company}` : `收藏 ${job.company}`}
                >{job.favorite ? "⭐" : "☆"}</button>
                {job.jdText && (
                  <button
                    type="button"
                    className="rf-btn"
                    onClick={() => setOpenJd((m) => ({ ...m, [job.id]: !m[job.id] }))}
                    aria-expanded={Boolean(openJd[job.id])}
                  >📋 JD</button>
                )}
                {job.applyUrl && <a className="rf-btn" href={job.applyUrl} target="_blank" rel="noopener noreferrer">🔗 去投递</a>}
                <button type="button" className="rf-btn" onClick={() => openInNative(job.id, "study")} title="从 JD 反推考点加入学习清单（原生流程）">📚 学考点</button>
                <button type="button" className="rf-btn" onClick={() => openInNative(job.id, "interview")} title="按该岗位 JD 开一场模拟面试（原生流程）">🎤 按岗面试</button>
                <button type="button" className="rf-btn rf-btn-primary" onClick={() => setJobStatus(job, "ready")} disabled={job.status === "ready"}>📮 已投递</button>
                <button type="button" className="rf-btn" onClick={() => setJobStatus(job, "ready_bishi")} disabled={job.status === "ready_bishi"}>✍️ 待笔试</button>
              </span>
            </div>
          ))
        )}
      </div>

      <div className="rf-muted">⚛️ React 特性：useDeferredValue 搜索 + useMemo 派生筛选/统计；抓取与 agent 流程复用原生渲染层（不做两套）</div>
    </div>
  );
}
