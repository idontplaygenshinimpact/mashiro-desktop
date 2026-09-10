// React 版复习卡（前端三态并行展示工单任务 2 收尾：补全三态矩阵最后一格——review 此前只有 Vue 版）
// 同一 IPC 桥（window.kanban.reviewDue/reviewSubmit——业务层 lib/review.mjs 零改动，FSRS 调度在业务层）
// 范围：到期卡列表 → 翻面看答案 → FSRS 评分提交 → 下一张 + 本次统计；测验/讲解等重流程复用原生渲染层。
// ⚛️ React 特性：useReducer 复习状态机（load/reveal/rate/next）+ useMemo 派生本次统计
import { useEffect, useMemo, useReducer, useState } from "react";

const RATINGS = [
  [1, "😵 忘了", "完全想不起来（下次很快再见）"],
  [2, "🤔 模糊", "想起来一部分（间隔缩短）"],
  [3, "🙂 记得", "基本回忆起来（间隔拉长）"],
  [4, "😎 熟练", "脱口而出（间隔大幅拉长）"],
];

function reviewReducer(state, action) {
  switch (action.type) {
    case "load": return { ...state, cards: action.cards || [], idx: 0, revealed: false, busy: false, done: 0 };
    case "reveal": return { ...state, revealed: true };
    case "rate": return { ...state, done: state.done + 1, idx: state.idx + 1, revealed: false };
    case "busy": return { ...state, busy: action.busy };
    default: return state;
  }
}

export function ReviewPanel() {
  const [st, dispatch] = useReducer(reviewReducer, { cards: [], idx: 0, revealed: false, busy: false, done: 0 });
  const [err, setErr] = useState("");
  const [at, setAt] = useState("");

  async function load() {
    setErr("");
    try {
      const r = await window.kanban.reviewDue();
      if (r?.ok === false) { setErr("读取到期卡失败：" + String(r.error || "").slice(0, 60)); return; }
      dispatch({ type: "load", cards: r?.due || r?.cards || [] });
      setAt(new Date().toLocaleTimeString("zh-CN"));
    } catch (e) { setErr("读取到期卡异常：" + String(e?.message || e).slice(0, 80)); }
  }
  useEffect(() => { load(); }, []);

  async function rate(card, rating) {
    dispatch({ type: "busy", busy: true });
    try {
      const r = await window.kanban.reviewSubmit(card.id, rating);
      if (r?.ok === false) { setErr("评分提交失败：" + String(r.error || "").slice(0, 60)); return; }
      if (r?.clearedWeak) window.kanban?.notify?.("✨ 薄弱点消灭", `「${r.clearedWeak}」已消灭（复习答对回流）`);
      dispatch({ type: "rate" });
    } catch (e) { setErr("评分提交异常：" + String(e?.message || e).slice(0, 80)); }
    finally { dispatch({ type: "busy", busy: false }); }
  }

  const card = st.cards[st.idx];
  const finished = st.cards.length > 0 && st.idx >= st.cards.length;
  const stats = useMemo(() => ({ total: st.cards.length, left: Math.max(0, st.cards.length - st.idx), done: st.done }), [st]);

  return (
    <div className="rf-stack">
      <div className="rf-card">
        <div className="rf-head">
          <b className="rf-title">🔁 复习卡 · React 版</b>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {at && <span className="rf-muted">{at} 更新</span>}
            <span className="rf-muted">到期 {stats.total} · 已复习 {stats.done} · 剩余 {stats.left}</span>
            <button type="button" className="rf-btn" onClick={load}>🔄 刷新</button>
            <button
              type="button"
              className="rf-btn"
              title="测验/讲解等流程在原生渲染层（Vue 版与原生已具备）"
              onClick={() => window.switchRenderer?.("review", "native")}
            >📝 测验/讲解（原生）</button>
          </span>
        </div>
        {err && <div className="rf-muted rf-chip-warn">⚠️ {err}</div>}
        <div className="rf-muted">🧠 FSRS 间隔复习：评分由业务层调度（lib/review.mjs），三态共用同一算法</div>
      </div>

      {st.cards.length === 0 ? (
        <div className="rf-card rf-muted">📭 今日无到期卡——继续学习清单或稍后再来（FSRS 会按记忆强度安排下一次）</div>
      ) : finished ? (
        <div className="rf-card">
          <b className="rf-title">✅ 本轮复习完成</b>
          <div className="rf-muted" style={{ marginTop: 4 }}>共复习 {stats.done} 张，调度已写回 FSRS（下次到期时间由算法决定）</div>
          <button type="button" className="rf-btn rf-btn-primary" style={{ marginTop: 8 }} onClick={load}>🔄 再看有没有新到期</button>
        </div>
      ) : (
        <div className="rf-card">
          <div className="rf-muted">第 {st.idx + 1}/{st.cards.length} 张 · {card.topic || ""}</div>
          <div className="rf-report" style={{ marginTop: 6, fontWeight: 700 }}>{card.question || card.topic || ""}</div>
          {st.revealed ? (
            <>
              <pre className="rf-report rf-sub" style={{ marginTop: 8 }}>{card.answer || "（该卡无参考答案）"}</pre>
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {RATINGS.map(([v, label, hint]) => (
                  <button key={v} type="button" className="rf-btn" disabled={st.busy} title={hint} onClick={() => rate(card, v)}>{label}</button>
                ))}
              </div>
            </>
          ) : (
            <button type="button" className="rf-btn rf-btn-primary" style={{ marginTop: 8 }} onClick={() => dispatch({ type: "reveal" })}>👁 显示答案</button>
          )}
        </div>
      )}

      <div className="rf-muted">⚛️ React 特性：useReducer 复习状态机（load/reveal/rate/next）+ useMemo 派生本轮统计</div>
    </div>
  );
}
