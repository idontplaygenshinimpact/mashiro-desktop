// React 版学习清单（前端三态并行展示工单任务 2 · S2①：列表 + 勾选 + 状态流分组 + 搜索过滤）
// 同一 IPC 桥（window.kanban.studyPlan/studyCheck/studyGenerate——业务层 lib/study-plan.mjs 零改动）。
// ⚛️ React 特性：useDeferredValue 搜索过滤（长清单输入不卡顿）+ useMemo 状态流分组派生
//   （原生版每次 loadStudyPlan 重建整块 innerHTML，React 版按状态差量更新）。
// 讲解入口复用原生讲解弹窗（showStudyDetail 在同一 preload/业务层之上，流式+追问+抽屉不重复实现）：
// 需要时切回原生渲染层再打开——功能等价，不做第二套流式 UI。
import { useDeferredValue, useEffect, useMemo, useState } from "react";

// 批次 2：深色内联已收敛为 panel.css 的 .rf-* 语义类（card/row/chip/btn/input/track/muted）
const muted = {};
const btn = {};
const btnPrimary = { background: "#8fc7ff", color: "#171322", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700 };
const input = {};
const select = { ...input, padding: "6px 8px" };
const row = { display: "flex", gap: 8 };
const chip = {};

/** 清单状态流（与原生 loadStudyPlan 的 stateOf 同口径）：待复习 > 已掌握 > 已学 > 学习中 > 待学习 */
function stateOf(it) {
  if (it.reviewDue) return "review";
  if (it.done && it.mastered) return "mastered";
  if (it.done) return "learned";
  if (it.hasFile) return "learning";
  return "todo";
}
const STATE_LABELS = [
  { key: "todo", label: "📥 待学习" },
  { key: "learning", label: "📖 学习中" },
  { key: "learned", label: "✅ 已学（讲解过）" },
  { key: "review", label: "🔁 待复习（复习卡到期）" },
  { key: "mastered", label: "🏆 已掌握" },
];

export function StudyPanel() {
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const deferredQ = useDeferredValue(q); // ⚛️ React 特性：输入不等待过滤
  const [lv, setLv] = useState("");
  const [st, setSt] = useState("");
  const [showMastered, setShowMastered] = useState(false);

  async function load() {
    try {
      const r = await window.kanban.studyPlan();
      if (r?.ok) setPlan(r.plan || { date: "", items: [] });
      else setErr("清单读取失败——后端未就绪");
    } catch (e) {
      setErr("清单读取异常：" + String(e?.message || e).slice(0, 80));
    }
  }
  useEffect(() => { load(); }, []);

  async function generate() {
    setBusy(true);
    setErr("");
    try {
      const r = await window.kanban.studyGenerate();
      if (r?.ok === false) setErr("生成失败：" + String(r.error || r.hint || "未知原因").slice(0, 80));
      else if (r?.addedCount === 0 && r?.note) setErr(r.note); // 无新知识点是正常情况，如实提示
      await load();
    } catch (e) {
      setErr("生成异常：" + String(e?.message || e).slice(0, 80));
    } finally {
      setBusy(false);
    }
  }

  /** 勾选/取消：同一 IPC（studyCheck）→ 薄弱点清除时给正反馈（与原生同款 toast 语义） */
  async function toggle(it, checked) {
    try {
      const r = await window.kanban.studyCheck(it.id, checked);
      if (r?.ok === false) { setErr("勾选失败：" + String(r.error || "").slice(0, 60)); return; }
      if (r?.clearedWeak) window.kanban?.notify?.("✨ 薄弱点消灭", `「${r.clearedWeak}」已消灭（清单勾选回流）`);
      await load();
    } catch (e) {
      setErr("勾选异常：" + String(e?.message || e).slice(0, 80));
    }
  }

  /** 讲解：切回原生渲染层 + 打开原生讲解弹窗（流式/追问/抽屉复用同一实现，不做第二套） */
  function explain(id) {
    try {
      window.switchRenderer?.("study", "native");
      window.showStudyDetail?.(id);
    } catch (e) {
      window.kanban?.notify?.("🎨 渲染层", "打开讲解失败：" + String(e?.message || e).slice(0, 60));
    }
  }

  const items = plan?.items || [];
  const doneN = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((doneN / items.length) * 100) : 0;

  // ⚛️ React 特性：过滤 + 分组都是派生值（依赖 deferredQ/lv/st/items——无关状态变化不重算）
  const { groups, matched } = useMemo(() => {
    const query = deferredQ.trim().toLowerCase();
    const pass = (it) => {
      if (lv && it.level !== lv) return false;
      if (st && stateOf(it) !== st) return false;
      if (query && !`${it.topic || ""} ${it.why || ""}`.toLowerCase().includes(query)) return false;
      return true;
    };
    const filtered = items.filter(pass);
    const g = { todo: [], learning: [], learned: [], review: [], mastered: [] };
    for (const it of filtered) g[stateOf(it)].push(it);
    return { groups: g, matched: filtered.length };
  }, [items, deferredQ, lv, st]);

  const filtering = Boolean(q.trim() || lv || st);
  // 主状态流不含"已掌握"——已掌握是折叠区（与原生同款：独立的 doneToggle 行，控制项不能被自己折叠掉）
  const mainStates = STATE_LABELS.filter((s) => s.key !== "mastered");
  const mastered = groups.mastered || [];

  return (
    <div className="rf-stack">
      <div className="rf-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <b className="rf-title">📋 学习清单 · React 版</b>
          <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {plan?.date && <span className="rf-muted">{plan.date}</span>}
            <button type="button" className="rf-btn rf-btn-primary" onClick={generate} disabled={busy}>{busy ? "生成中…" : "✨ 从产出生成清单"}</button>
          </span>
        </div>
        {/* 进度（总进度，不受筛选影响——与原生同口径） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="rf-muted">📋 学习进度</span>
          <span className="rf-track rf-grow">
            <i className="rf-fill" style={{ width: `${pct}%` }} />
          </span>
          <b style={{ fontSize: 11 }}>{doneN}/{items.length}（{pct}%）</b>
        </div>
        {/* 搜索 + 筛选（useDeferredValue：输入即时，过滤延后） */}
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <input
            className="rf-input rf-grow"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索知识点 / 学习理由…"
          />
          <select className="rf-input" value={lv} onChange={(e) => setLv(e.target.value)}>
            <option value="">全部级别</option>
            <option value="必会">必会</option>
            <option value="进阶">进阶</option>
            <option value="拓展">拓展</option>
          </select>
          <select className="rf-input" value={st} onChange={(e) => setSt(e.target.value)}>
            <option value="">全部状态</option>
            {STATE_LABELS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          {filtering && <span className="rf-muted">匹配 {matched}/{items.length}</span>}
        </div>
        {err && <div className="rf-muted rf-chip-warn" style={{ marginTop: 6 }}>⚠️ {err}</div>}
      </div>

      {items.length === 0 ? (
        <div className="rf-card rf-muted">未生成，点「✨ 从产出生成清单」</div>
      ) : (
        mainStates.map((s) => {
          const list = groups[s.key] || [];
          if (!list.length) return null;
          return (
            <div key={s.key} className="rf-card">
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <b className="rf-title">{s.label}</b>
                <span className="rf-chip">{list.length}</span>
              </div>
              {list.map((it) => (
                <div key={it.id} className="rf-row rf-row-start">
                  <input
                    type="checkbox"
                    checked={!!it.done}
                    onChange={(e) => toggle(it, e.target.checked)}
                    title={it.done ? "取消勾选（同时删除自动建的复习卡）" : "勾选完成（学习进度回流 + 自动建复习卡）"}
                    style={{ marginTop: 2 }}
                  />
                  <span style={{ flex: 1 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <b className="rf-title" style={{ textDecoration: it.done ? "line-through" : "none", opacity: it.done ? 0.75 : 1 }}>{it.topic}</b>
                      {it.level && <span className="rf-chip">{it.level}</span>}
                      {it.grp && <span className="rf-chip rf-chip-plain">{it.grp}</span>}
                      {it.fromInterview && <span className="rf-chip rf-chip-warn">面试</span>}
                      {it.reviewDue && <span className="rf-chip rf-chip-ok">待复习</span>}
                    </span>
                    {it.why && <div className="rf-muted" style={{ marginTop: 3 }}>{it.why}</div>}
                  </span>
                  <button type="button" className="rf-btn" onClick={() => explain(it.id)} title="打开讲解（复用原生弹窗：流式 + 追问）">💡 讲解</button>
                </div>
              ))}
            </div>
          );
        })
      )}

      {/* 已掌握折叠区：控制行独立于被折叠内容（否则按钮在折叠块里 → 永远点不开） */}
      {mastered.length > 0 && (
        <div className="rf-card">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <b style={{ fontSize: 12 }}>🏆 已掌握</b>
            <span className="rf-chip">{mastered.length}</span>
            <button type="button" className="rf-btn" onClick={() => setShowMastered((v) => !v)}>
              {showMastered ? "收起" : "展开"}
            </button>
          </div>
          {showMastered && mastered.map((it) => (
            <div key={it.id} className="rf-row rf-row-start">
              <input type="checkbox" checked readOnly title="已达成（取消勾选可退回学习中）" style={{ marginTop: 2 }} />
              <span style={{ flex: 1 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <b className="rf-title">{it.topic}</b>
                  {it.level && <span className="rf-chip">{it.level}</span>}
                  {it.grp && <span className="rf-chip rf-chip-plain">{it.grp}</span>}
                </span>
                {it.why && <div className="rf-muted" style={{ marginTop: 3 }}>{it.why}</div>}
              </span>
              <button type="button" className="rf-btn" onClick={() => explain(it.id)}>💡 讲解</button>
            </div>
          ))}
        </div>
      )}

      <div className="rf-muted">
        ⚛️ React 特性：useDeferredValue 搜索过滤 + useMemo 状态流分组（状态驱动差量更新）；讲解/追问复用同一实现
      </div>
    </div>
  );
}
