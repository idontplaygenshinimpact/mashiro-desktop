// React 版求职驾驶舱（前端三态并行展示工单任务 2 · S1 数据展示型 Tab）
// 同一数据源 /api/dashboard（与原 panel-jobs.js 的 loadDashboard 同接口）——三态等价性由此保证。
// ⚛️ React 特性：useMemo 缓存近 7 天活动峰值（无关状态变化不重算）+ 组件化 <StatChip>/<ProgressRow>
//   （原生版是 innerHTML 拼串，每次刷新全量重建 DOM；React 版按状态差量更新）。
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

const S = {
  // 批次 2：深色内联已收敛为 panel.css 的 .rf-* 语义类（见 panel.css 样式词汇段）
  card: {},
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 },
  title: { fontSize: 13, fontWeight: 700 },
  muted: {},
  chipRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {},
  num: { color: "#8fc7ff", fontSize: 14, fontWeight: 700 },
  btn: {},
  row: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginTop: 6 },
  rowLabel: { width: 110 },
  track: { flex: 1 },
  rep: {},
  err: { fontSize: 12, color: "#e8c04a" },
};

/** 本周总览 chip（组件化：原生是模板串） */
function StatChip({ label, value }) {
  return (
    <div className="rf-stat">
      {label} <b className="rf-num">{value}</b>
    </div>
  );
}

/** 累计进度条（派生百分比在渲染期算——total 缺失时 0%，不除零） */
function ProgressRow({ label, done = 0, total = 0, color = "#8fc7ff" }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="rf-row">
      <span className="rf-muted">{label}</span>
      <span className="rf-track rf-grow">
        <i style={{ display: "block", height: "100%", width: `${pct}%`, background: color, borderRadius: 3 }} />
      </span>
      <b style={{ fontSize: 11 }}>
        {done}/{total}
      </b>
    </div>
  );
}

const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

export function DashboardPanel() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [at, setAt] = useState("");

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const j = await api("/api/dashboard");
      if (j?.ok) { setData(j); setAt(new Date().toLocaleTimeString("zh-CN")); }
      else setErr("后端未就绪——widget 启动后可刷新重试");
    } catch (e) {
      setErr("加载失败：" + String(e?.message || e).slice(0, 80));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, []);

  const week = data?.week || {};
  const series = data?.weekSeries || [];
  const report = data?.report || {};
  const progress = data?.progress || {};
  // ⚛️ React 特性：峰值只在 weekSeries 变化时重算（原生每次刷新都重算一遍并重建整块 DOM）
  const maxAct = useMemo(
    () => Math.max(1, ...series.map((d) => (d.study || 0) + (d.review || 0) + (d.challenge || 0))),
    [series]
  );
  const todayStr = new Date().toISOString().slice(0, 10);

  const reportLines = [];
  if (report.highlights?.length) reportLines.push(`✅ 本周亮点：${report.highlights.join("、")}`);
  if (report.gaps?.length) reportLines.push(`⚠️ 待补：${report.gaps.join("；")}`);

  return (
    <div className="rf-stack">
      <div className="rf-card">
        <div className="rf-head">
          <span className="rf-title">📊 求职驾驶舱 · React 版</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {at && <span className="rf-muted">{at} 更新</span>}
            <button className="rf-btn" onClick={load} disabled={busy}>{busy ? "刷新中…" : "🔄 刷新"}</button>
          </span>
        </div>
        <div className="rf-toolbar">
          <StatChip label="📚 学习完成" value={week.studyDone ?? 0} />
          <StatChip label="🔁 复习" value={`${week.reviewDone ?? 0} 张`} />
          <StatChip label="✍️ 刷题" value={`${week.challengeDone ?? 0} 道`} />
          <StatChip label="⏱️ 专注" value={`${Math.round(((week.focusMinutes ?? 0) / 60) * 10) / 10} 小时`} />
          <StatChip label="💼 投递" value={`${week.applyCount ?? 0} 家`} />
          <StatChip label="🎤 面试" value={`${week.interviewCount ?? 0} 场`} />
        </div>
        {err && <div style={{ ...S.err, marginTop: 8 }}>⚠️ {err}</div>}
      </div>

      <div className="rf-card">
        <div className="rf-title">📈 近 7 天活动</div>
        <div className="rf-muted">绿=学习 · 紫=复习 · 蓝=刷题 · 底部条=专注时长</div>
        {series.length === 0 ? (
          <div style={{ ...S.muted, marginTop: 8 }}>📭 暂无活动数据</div>
        ) : (
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end", marginTop: 8 }}>
            {series.map((d) => {
              const isToday = d.date === todayStr;
              const bar = (v, color) => (
                <span
                  title={`${color.name} ${v}`}
                  style={{ width: 6, height: Math.max(2, Math.round(((v || 0) / maxAct) * 26)), background: v ? color.on : color.off, borderRadius: 2 }}
                />
              );
              const study = { on: "#3a8a5a", off: "rgba(58,138,90,.25)", name: "学习" };
              const review = { on: "#8a5adc", off: "rgba(138,90,220,.25)", name: "复习" };
              const challenge = { on: "#4a6fe0", off: "rgba(74,111,224,.25)", name: "刷题" };
              return (
                <div key={d.date} style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ display: "flex", gap: 2, justifyContent: "center", alignItems: "flex-end", height: 30 }}>
                    {bar(d.study, study)}
                    {bar(d.review, review)}
                    {bar(d.challenge, challenge)}
                  </div>
                  <div
                    title={`专注 ${d.focus || 0} 分钟`}
                    style={{ height: 4, marginTop: 2, borderRadius: 2, background: d.focus ? "#8a5adc" : "rgba(138,90,220,.2)" }}
                  />
                  <div className={isToday ? "rf-day rf-day-today" : "rf-day"}>
                    {DAY_NAMES[new Date(d.date + "T00:00:00").getDay()] || d.date.slice(5)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rf-card">
        <div className="rf-title">📝 本周复盘与下周建议</div>
        <pre className="rf-report">
          {reportLines.join("\n")}
          {reportLines.length ? "\n\n" : ""}
          {(report.suggestions || []).join("\n") || (reportLines.length ? "" : "📭 暂无建议")}
        </pre>
      </div>

      <div className="rf-card">
        <div className="rf-title">📌 累计进度（闭环总览）</div>
        <ProgressRow label="📚 学习清单" done={progress.plan?.done} total={progress.plan?.total} />
        <ProgressRow label="✍️ 手写/算法题库" done={progress.challenges?.done} total={progress.challenges?.total} color="#4a6fe0" />
        <ProgressRow label="🔁 复习卡掌握" done={progress.review?.mastered} total={progress.review?.total} color="#3a8a5a" />
        <div style={{ ...S.chipRow, marginTop: 8 }}>
          <StatChip label="🎯 方向" value={progress.direction || "未设置"} />
          <StatChip label="🔧 薄弱点" value={progress.weak ?? 0} />
          <StatChip label="🔁 复习到期" value={progress.review?.due ?? 0} />
          <StatChip label="💼 未投" value={progress.jobs?.open ?? 0} />
          <StatChip label="📮 已投" value={progress.jobs?.applied ?? 0} />
        </div>
      </div>

      <div className="rf-muted">⚛️ React 特性：useMemo 缓存 7 天峰值 + 组件化 StatChip/ProgressRow（状态驱动差量更新）</div>
    </div>
  );
}
