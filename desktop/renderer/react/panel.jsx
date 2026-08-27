// React 版模拟面试面板（渲染层可替换性验证的核心交互）
// 全部交互经 window.kanban IPC 桥（同一 preload，74 方法）→ 业务层 lib/interview.mjs 零改动
import { useEffect, useState } from "react";
import { renderMarkdown } from "./markdown.js";
import { ScoreBars, ScoreRadar } from "./score.jsx";

const ROLES = ["技术深挖型", "温和引导型", "压力追问型"];

function pick(r, keys) {
  if (!r) return null;
  const out = {};
  for (const k of keys) out[k] = r[k];
  return out;
}

export function InterviewPanel() {
  const [phase, setPhase] = useState("setup"); // setup | active | finished
  const [busy, setBusy] = useState(false);
  // 配置
  const [config, setConfig] = useState({ position: "前端实习生", role: "技术深挖型", focus: "" });
  // 会话
  const [session, setSession] = useState(null); // {round, roundType, question, dimension, basis, criteria, boundary, depth, totalRounds}
  const [scores, setScores] = useState({ tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0, rounds: 0 });
  const [log, setLog] = useState([]);
  // 复盘
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState([]);
  const [resumable, setResumable] = useState(null);

  useEffect(() => {
    window.kanban.interviewHistory().then((h) => setHistory((h?.history || []).slice().reverse())).catch(() => {});
    window.kanban.invStatus().then((r) => { if (r?.ok && r.active) setResumable(r); }).catch(() => {});
  }, []);

  const addLog = (text) => setLog((l) => [...l, { ts: Date.now(), text }]);

  function enterActive(r) {
    setPhase("active");
    setSession(pick(r, ["round", "roundType", "question", "dimension", "basis", "criteria", "boundary", "depth", "totalRounds"]));
    setScores({ tech: 0, expr: 0, depth: 0, edge: 0, reflect: 0, total: 0, rounds: 0 });
    setLog([{ ts: Date.now(), text: `面试开始：${r.roundType || ""} · 第 1 轮` }]);
  }

  async function start() {
    setBusy(true);
    try {
      const r = await window.kanban.invStart(config);
      if (r?.error) { alert("启动失败：" + r.error); return; }
      enterActive(r);
      setResumable(null);
    } catch (e) { alert("启动异常：" + String(e?.message || e)); }
    finally { setBusy(false); }
  }

  async function resume() {
    if (!resumable) return;
    setBusy(true);
    try {
      const r = resumable;
      setPhase("active");
      setSession(pick(r, ["round", "roundType", "question", "dimension", "basis", "criteria", "boundary", "depth", "totalRounds"]));
      setScores({
        tech: Number(r.scoreSum?.tech) || 0, expr: Number(r.scoreSum?.expr) || 0, depth: Number(r.scoreSum?.depth) || 0,
        edge: Number(r.scoreSum?.edge) || 0, reflect: Number(r.scoreSum?.reflect) || 0,
        total: Number(r.scoreSum?.total) || 0, rounds: Number(r.roundsCount) || 0,
      });
      setLog([{ ts: Date.now(), text: `已恢复上一场（第 ${Number(r.round) || 1} 轮）` }]);
      setResumable(null);
    } finally { setBusy(false); }
  }

  async function submit(answer) {
    if (!answer?.trim() || busy) return;
    setBusy(true);
    try {
      const r = await window.kanban.invAnswer(answer);
      if (r?.error) { alert("提交失败：" + r.error); return; }
      if (r.total != null) {
        setScores((s) => ({
          tech: s.tech + (Number(r.scores?.tech) || 0), expr: s.expr + (Number(r.scores?.expr) || 0),
          depth: s.depth + (Number(r.scores?.depth) || 0), edge: s.edge + (Number(r.scores?.edge) || 0),
          reflect: s.reflect + (Number(r.scores?.reflect) || 0), total: s.total + (Number(r.total) || 0),
          rounds: s.rounds + 1,
        }));
      }
      addLog(`第 ${r.round} 轮【${r.roundType || "问答"}】完成` + (r.finished ? "（面试结束）" : ""));
      if (r.finished) {
        const end = await window.kanban.invEnd();
        if (end?.ok && end.report) {
          setReport(end.report);
          setPhase("finished");
          addLog(end.hint || "");
          window.kanban.interviewHistory().then((h) => setHistory((h?.history || []).slice().reverse())).catch(() => {});
        } else {
          alert(end?.error || "结束失败");
        }
      } else {
        setSession(pick(r, ["round", "roundType", "question", "dimension", "basis", "criteria", "boundary", "depth", "totalRounds"]));
      }
    } catch (e) { alert("提交异常：" + String(e?.message || e)); }
    finally { setBusy(false); }
  }

  async function openHistory(rec) {
    const md = rec?.report || "";
    if (md) { setReport(md); setPhase("finished"); }
  }

  if (phase === "finished") {
    return (
      <ReportView report={report} history={history} onBack={() => setPhase("setup")} onOpen={openHistory} onNew={() => { setReport(null); setPhase("setup"); }} />
    );
  }
  if (phase === "active" && session) {
    return (
      <SessionView session={session} scores={scores} busy={busy} onSubmit={submit} onExit={async () => {
        try { await window.kanban.invEnd(); } catch { /* ignore */ }
        setPhase("setup");
      }} />
    );
  }
  return (
    <SetupView config={config} setConfig={setConfig} busy={busy} onStart={start}
      resumable={resumable} onResume={resume}
      history={history} onOpen={openHistory} />
  );
}

// ---------- 视图组件 ----------

function SetupView({ config, setConfig, busy, onStart, resumable, onResume, history, onOpen }) {
  const set = (k) => (e) => setConfig((c) => ({ ...c, [k]: e.target.value }));
  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18, maxWidth: 640, margin: "0 auto" }}>
      <div>
        <h2 style={{ margin: 0 }}>🎤 模拟面试 <span style={{ fontSize: 12, color: "#8fc7ff" }}>React 版</span></h2>
        <div style={{ fontSize: 12, color: "#a8a3c8", marginTop: 4 }}>
          与原生面板共用同一 IPC 桥与业务层——仅换渲染层（渲染层/业务层解耦验证）
        </div>
      </div>

      {resumable && (
        <div style={{ background: "#241f3a", border: "1px solid #8fc7ff66", borderRadius: 8, padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13 }}>🔄 检测到未完成的面试（第 {Number(resumable.round) || 1} 轮）</span>
          <button onClick={onResume} disabled={busy} style={btnPrimary}>继续上一场</button>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={lbl}>目标岗位</label>
        <input value={config.position} onChange={set("position")} style={input} />
        <label style={lbl}>面试官风格</label>
        <select value={config.role} onChange={set("role")} style={input}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <label style={lbl}>重点方向（可选）</label>
        <input value={config.focus} onChange={set("focus")} placeholder="如：React / 事件循环 / 项目拷打" style={input} />
      </div>

      <button onClick={onStart} disabled={busy} style={{ ...btnPrimary, padding: "12px 0", fontSize: 15 }}>
        {busy ? "启动中…" : "🚀 开始面试"}
      </button>

      {history.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 13, color: "#a8a3c8", marginBottom: 8 }}>历史复盘（{history.length}）</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
            {history.slice(0, 20).map((h, i) => (
              <div key={i} onClick={() => onOpen(h)} style={{ background: "#241f3a", borderRadius: 6, padding: "8px 12px", cursor: "pointer", fontSize: 13, display: "flex", justifyContent: "space-between" }}>
                <span>{h.position || "面试"} · {h.rounds || 0} 轮</span>
                <span style={{ color: "#a8a3c8" }}>{h.date ? String(h.date).slice(0, 16) : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionView({ session, scores, busy, onSubmit, onExit }) {
  const [answer, setAnswer] = useState("");
  const avgRounds = Math.max(1, scores.rounds);
  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, maxWidth: 720, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>
          第 {session.round} 轮 <span style={{ fontSize: 12, color: "#8fc7ff" }}>· {session.roundType || "问答"} · 共 {session.totalRounds || "?"} 轮</span>
        </div>
        <button onClick={onExit} style={{ background: "none", border: "1px solid #4a4568", color: "#a8a3c8", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>结束并返回</button>
      </div>

      <div style={{ background: "#241f3a", borderRadius: 10, padding: 16 }}>
        <div style={{ fontSize: 12, color: "#e8c04a", marginBottom: 8 }}>考察维度：{session.dimension || "-"}{session.depth > 0 ? `（追问深度 ${session.depth} 级）` : ""}</div>
        <div style={{ fontSize: 15, lineHeight: 1.6 }}>{session.question || "（加载中…）"}</div>
        {session.basis && <div style={{ fontSize: 12, color: "#a8a3c8", marginTop: 10, whiteSpace: "pre-wrap" }}>📌 追问依据：{session.basis}</div>}
        {session.criteria && <div style={{ fontSize: 12, color: "#a8a3c8", marginTop: 6, whiteSpace: "pre-wrap" }}>✅ 合格标准：{session.criteria}</div>}
        {session.boundary && <div style={{ fontSize: 12, color: "#a8a3c8", marginTop: 6 }}>⛔ 边界：{session.boundary}</div>}
      </div>

      <div style={{ display: "flex", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "#a8a3c8", marginBottom: 6 }}>你的回答</div>
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={7}
            placeholder="组织你的回答（思路 → 代码/例子 → 边界）…" style={{ ...input, resize: "vertical", lineHeight: 1.5 }} />
          <button onClick={() => { onSubmit(answer); setAnswer(""); }} disabled={busy || !answer.trim()}
            style={{ ...btnPrimary, width: "100%", marginTop: 10, padding: "10px 0" }}>
            {busy ? "评分中…" : "📤 提交回答"}
          </button>
        </div>
        <div style={{ width: 240, flexShrink: 0, background: "#1f1a31", borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, color: "#a8a3c8", marginBottom: 8 }}>累计评分（{scores.rounds} 轮）</div>
          <ScoreBars scores={scores} />
          <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
            <ScoreRadar scores={scores} rounds={avgRounds} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportView({ report, history, onBack, onOpen, onNew }) {
  return (
    <div style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>📋 面试复盘</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onNew} style={btnSecondary}>新面试</button>
          <button onClick={onBack} style={btnSecondary}>历史列表</button>
        </div>
      </div>
      {report ? (
        <div style={{ background: "#241f3a", borderRadius: 10, padding: "16px 20px", lineHeight: 1.7, fontSize: 14 }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, color: "#a8a3c8", marginBottom: 6 }}>历史复盘</div>
          {history.map((h, i) => (
            <div key={i} onClick={() => onOpen(h)} style={{ background: "#241f3a", borderRadius: 6, padding: "10px 14px", cursor: "pointer", fontSize: 13 }}>
              {h.position || "面试"} · {h.rounds || 0} 轮 · {h.date ? String(h.date).slice(0, 16) : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- 样式 ----------
const btnPrimary = { background: "#8fc7ff", color: "#171322", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 14 };
const btnSecondary = { background: "#2a2540", color: "#e8e6f5", border: "1px solid #4a4568", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 13 };
const input = { background: "#241f3a", color: "#e8e6f5", border: "1px solid #3a3558", borderRadius: 6, padding: "8px 10px", fontSize: 13, outline: "none" };
const lbl = { fontSize: 12, color: "#a8a3c8" };
