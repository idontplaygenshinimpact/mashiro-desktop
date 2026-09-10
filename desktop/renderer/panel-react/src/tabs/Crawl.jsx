// React 版爬取 Tab（前端三态并行展示工单任务 2 · S2②：表单/工具栏 + 进度 + 产出列表 + 今日推荐 + 运行监控）
// 同一 IPC 桥（window.kanban.getData/getStats/runDiscover/openOutput/openFile——业务层零改动）。
// ⚛️ React 特性：useMemo 产出分组派生 + 轮询用 useEffect 依赖收敛（原生是 5s _gatedInterval 重刷整块 innerHTML，
//   React 版只在数据变化时更新对应子树）；进度条按状态派生（running/done/idle）。
import { useEffect, useMemo, useState } from "react";

const card = { background: "#241f3a", border: "1px solid #4a4568", borderRadius: 10, padding: 12 };
const muted = { fontSize: 11, color: "#a8a3c8" };
const btn = { background: "#2a2540", color: "#e8e6f5", border: "1px solid #4a4568", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 };
const btnPrimary = { background: "#8fc7ff", color: "#171322", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700 };
const chip = { background: "#2a2540", border: "1px solid #4a4568", borderRadius: 4, padding: "1px 6px", fontSize: 10, color: "#8fc7ff", whiteSpace: "nowrap" };
const item = { display: "flex", alignItems: "center", gap: 8, background: "#1f1a31", border: "1px solid #4a4568", borderRadius: 8, padding: "7px 10px", marginTop: 6, fontSize: 12 };

export function CrawlPanel() {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    try {
      const r = await window.kanban.getData();
      if (r?.ok) setData(r);
      else setErr("读取产出失败——后端未就绪");
    } catch (e) {
      setErr("读取产出异常：" + String(e?.message || e).slice(0, 80));
    }
    try {
      const s = await window.kanban.getStats();
      if (s?.ok) setStats(s.stats || null);
    } catch { /* 统计失败不影响主视图 */ }
  }

  // 挂载拉一次 + 爬取进行中时 5s 轮询（与原生 _gatedInterval(loadCrawlData, 5000) 同频；
  // 依赖 progress.status——空闲时不轮询，避免无谓 IPC）
  const status = data?.progress?.status || "idle";
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [status]);

  async function startCrawl() {
    setBusy(true);
    setErr("");
    try {
      const r = await window.kanban.runDiscover();
      if (r?.ok === false) setErr("启动爬取失败：" + String(r.error || "").slice(0, 60));
      await load();
    } catch (e) {
      setErr("启动爬取异常：" + String(e?.message || e).slice(0, 80));
    } finally {
      setBusy(false);
    }
  }

  const prog = data?.progress || {};
  const pct = prog.status === "running"
    ? (prog.total ? Math.min(100, Math.round((prog.current / prog.total) * 100)) : 8)
    : prog.status === "done" ? 100 : 0;
  const progressText = prog.status === "running" ? `🔍 ${prog.message || "爬取中..."}`
    : prog.status === "done" ? `✅ ${prog.message || "完成"}` : "暂无任务";

  // ⚛️ React 特性：产出/推荐都是派生值（数据不变不重算）
  const files = useMemo(() => (data?.files || []).slice(0, 12), [data]);
  const reco = useMemo(() => {
    const p = data?.plan || {};
    return [
      ...(p.bishi || []).map((f) => ({ ...f, tag: "笔试" })),
      ...(p.mianshi || []).map((f) => ({ ...f, tag: "面经" })),
    ];
  }, [data]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "#e8e6f5" }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>🔍 爬取 · React 版</b>
          <span style={{ display: "flex", gap: 6 }}>
            <button style={btnPrimary} onClick={startCrawl} disabled={busy}>{busy ? "启动中…" : "🔍 开始爬取"}</button>
            <button style={btn} onClick={() => window.kanban.openOutput()}>📁 打开输出目录</button>
            <button style={btn} onClick={load}>🔄 刷新</button>
          </span>
        </div>
        <div style={muted}>{progressText}</div>
        {/* 进度条（running/done/idle 三态派生） */}
        {pct > 0 && (
          <div style={{ height: 6, background: "#1f1a31", borderRadius: 3, overflow: "hidden", marginTop: 6 }}>
            <i style={{ display: "block", height: "100%", width: `${pct}%`, background: prog.status === "done" ? "#3a8a5a" : "#8fc7ff", borderRadius: 3 }} />
          </div>
        )}
        {err && <div style={{ ...muted, color: "#e8c04a", marginTop: 6 }}>⚠️ {err}</div>}
        {/* 使用统计（与原生 stats-row 同口径） */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          <span style={chip}>💬 对话 {stats?.chats || 0}</span>
          <span style={chip}>📝 复盘 {stats?.reviewsDone || 0}</span>
          <span style={chip}>🎤 面试 {stats?.interviewsDone || 0}</span>
          <span style={chip}>📚 复习 {data?.review?.total || 0}</span>
        </div>
      </div>

      <div style={card}>
        <b style={{ fontSize: 12 }}>📌 今日推荐</b>
        {reco.length === 0 ? (
          <div style={{ ...muted, marginTop: 6 }}>暂无推荐（先跑一次爬取）</div>
        ) : (
          reco.map((f, i) => (
            <div
              key={`${f.path || f.file || i}`}
              style={{ ...item, cursor: f.path ? "pointer" : "default" }}
              title={f.path ? "点击用系统默认程序打开" : ""}
              onClick={() => f.path && window.kanban.openFile(f.path)}
            >
              <span style={{ ...chip, color: f.tag === "笔试" ? "#4a6fe0" : "#e8c04a" }}>{f.tag}</span>
              <span style={{ flex: 1 }}>{f.title || f.file || ""}</span>
            </div>
          ))
        )}
      </div>

      <div style={card}>
        <b style={{ fontSize: 12 }}>📄 最近产出（{data?.files?.length || 0}）</b>
        {files.length === 0 ? (
          <div style={{ ...muted, marginTop: 6 }}>暂无产出</div>
        ) : (
          files.map((f, i) => (
            <div key={`${f.dir || ""}-${f.title || i}`} style={item}>
              <span style={chip}>{f.company || "?"}</span>
              <span style={{ flex: 1 }}>{f.title || ""}</span>
              <span style={{ ...muted, fontSize: 10 }}>{f.dir || ""}</span>
            </div>
          ))
        )}
      </div>

      <div style={muted}>⚛️ React 特性：产出/推荐用 useMemo 派生 + 轮询依赖收敛（空闲不轮询，仅爬取中 5s 拉取）</div>
    </div>
  );
}
