// React 版对话 Tab（前端三态并行展示工单任务 2 · S4：会话列表 + 消息流 + 流式发送 + 工具事件展示）
// 同一 IPC 桥（window.kanban.chatSessions/chatMessages/chatStream/chatSessionDelete——业务层零改动）。
// ⚛️ React 特性：useReducer 消息状态机（append/chunk/event/reset——流式 delta 高频更新集中一处）
//   + useMemo 事件归并展示（原生是 innerHTML 追加 + 全量滚动重排）。
// 范围说明（S4 最重，按可交付粒度切）：审批/工具确认这类需要阻塞式交互的流程仍走原生渲染层；
// React 版把工具事件以只读时间线呈现，并提供"切回原生处理审批"的入口——不做两套审批语义。
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

/** 消息状态机：流式 delta 高频到达，集中在一处 reducer（可追踪/可测试） */
function chatReducer(state, action) {
  switch (action.type) {
    case "reset": return { messages: action.messages || [], events: [] };
    case "user": return { ...state, messages: [...state.messages, { role: "user", content: action.content }] };
    case "chunk": {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        return { ...state, messages: [...state.messages.slice(0, -1), { ...last, content: last.content + action.text }] };
      }
      return { ...state, messages: [...state.messages, { role: "assistant", content: action.text, streaming: true }] };
    }
    case "done": {
      const last = state.messages[state.messages.length - 1];
      return last?.streaming ? { ...state, messages: [...state.messages.slice(0, -1), { ...last, streaming: false }] } : state;
    }
    case "event": return { ...state, events: [...state.events, action.event] };
    default: return state;
  }
}

export function ChatPanel() {
  const [st, dispatch] = useReducer(chatReducer, { messages: [], events: [] });
  const [sessions, setSessions] = useState([]);
  const [sid, setSid] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const listRef = useRef(null);

  async function loadSessions() {
    try {
      const r = await window.kanban.chatSessions();
      setSessions(r?.sessions || []);
      if (!sid && r?.sessions?.length) setSid(r.sessions[0].id || r.sessions[0].sessionId || "");
    } catch (e) { setErr("会话列表读取失败：" + String(e?.message || e).slice(0, 60)); }
  }
  useEffect(() => { loadSessions(); }, []);

  // 载入所选会话的消息
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!sid) { dispatch({ type: "reset", messages: [] }); return; }
      try {
        const r = await window.kanban.chatMessages(sid);
        if (alive) dispatch({ type: "reset", messages: r?.messages || [] });
      } catch (e) { if (alive) setErr("消息读取失败：" + String(e?.message || e).slice(0, 60)); }
    })();
    return () => { alive = false; };
  }, [sid]);

  // 新内容到达时滚到底（流式跟随）
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [st.messages, st.events]);

  async function send() {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    setErr("");
    dispatch({ type: "user", content: msg });
    setText("");
    try {
      // 流式：chunk 累积正文，其余事件进时间线（工具调用/状态/耗时等）
      await window.kanban.chatStream(msg, st.messages, (ev) => {
        if (!ev) return;
        if (ev.type === "chunk" || ev.type === "delta") dispatch({ type: "chunk", text: String(ev.text || ev.content || "") });
        else dispatch({ type: "event", event: { type: String(ev.type || "event"), text: String(ev.text || ev.message || ev.tool || "").slice(0, 200) } });
      }, sid || undefined);
      dispatch({ type: "done" });
      await loadSessions();
    } catch (e) {
      setErr("发送失败：" + String(e?.message || e).slice(0, 80));
      dispatch({ type: "done" });
    } finally {
      setBusy(false);
    }
  }

  async function delSession() {
    if (!sid) return;
    try { await window.kanban.chatSessionDelete(sid); setSid(""); await loadSessions(); }
    catch (e) { setErr("删除失败：" + String(e?.message || e).slice(0, 60)); }
  }

  // ⚛️ 派生：事件按类型归并计数（时间线摘要）
  const eventSummary = useMemo(() => {
    const m = new Map();
    for (const e of st.events) m.set(e.type, (m.get(e.type) || 0) + 1);
    return [...m.entries()].map(([k, n]) => `${k}×${n}`).join(" · ");
  }, [st.events]);

  return (
    <div className="rf-stack">
      <div className="rf-card">
        <div className="rf-head">
          <b className="rf-title">💬 对话 · React 版</b>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select className="rf-input" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="选择会话">
              <option value="">新会话</option>
              {sessions.map((s) => <option key={s.id || s.sessionId} value={s.id || s.sessionId}>{s.title || s.id || s.sessionId}</option>)}
            </select>
            <button type="button" className="rf-btn" onClick={delSession} disabled={!sid} title="删除当前会话">🗑 删除</button>
            <button type="button" className="rf-btn" onClick={() => window.switchRenderer?.("chat", "native")} title="审批/工具确认等阻塞式交互在原生渲染层处理">⚖️ 审批（原生）</button>
          </span>
        </div>
        {err && <div className="rf-muted rf-chip-warn">⚠️ {err}</div>}
        {eventSummary && <div className="rf-muted">工具事件：{eventSummary}</div>}
      </div>

      <div className="rf-card">
        <div ref={listRef} style={{ maxHeight: 360, overflowY: "auto" }} role="log" aria-label="对话消息" aria-live="polite">
          {st.messages.length === 0 && st.events.length === 0 ? (
            <div className="rf-muted">还没有消息——在下面输入并发送（流式回复会实时追加）</div>
          ) : (
            <>
              {st.messages.map((m, i) => (
                <div key={`m${i}`} className={m.role === "user" ? "rf-row" : "rf-sub"} style={{ marginTop: 6 }}>
                  <b className="rf-title">{m.role === "user" ? "我" : "助手"}</b>
                  {m.streaming && <span className="rf-chip rf-chip-info">生成中…</span>}
                  <span className="rf-report" style={{ display: "block", marginTop: 4 }}>{m.content}</span>
                </div>
              ))}
              {st.events.length > 0 && (
                <div className="rf-sub" style={{ marginTop: 6 }}>
                  <b className="rf-title">工具事件时间线</b>
                  {st.events.map((e, i) => (
                    <div key={`e${i}`} className="rf-muted">{e.type}{e.text ? `：${e.text}` : ""}</div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            className="rf-input rf-grow"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="输入消息（Enter 发送）…"
            aria-label="消息输入"
          />
          <button type="button" className="rf-btn rf-btn-primary" onClick={send} disabled={busy || !text.trim()}>{busy ? "回复中…" : "发送"}</button>
        </div>
      </div>

      <div className="rf-muted">⚛️ React 特性：useReducer 消息状态机（流式 delta 集中更新）+ useMemo 事件归并；审批流程复用原生渲染层</div>
    </div>
  );
}
