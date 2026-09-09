// 五维评分可视化：评分条 + SVG 雷达图（React 版模拟面试）
// 框架特色展示工单任务 2②：雷达图几何计算 useMemo 缓存（scores/rounds 不变不重算）
import { useMemo } from "react";

const DIMS = [
  ["tech", "技术深度"],
  ["expr", "表达清晰"],
  ["depth", "原理追问"],
  ["edge", "边界意识"],
  ["reflect", "复盘反思"],
];

/** 横向评分条（五维） */
export function ScoreBars({ scores }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {DIMS.map(([k, label]) => {
        const v = Math.round(Number(scores?.[k]) || 0);
        const pct = Math.min(100, v);
        return (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 64, fontSize: 12, color: "#a8a3c8", flexShrink: 0 }}>{label}</span>
            <div style={{ flex: 1, height: 10, background: "#2a2540", borderRadius: 5, overflow: "hidden" }}>
              <div style={{ width: pct + "%", height: "100%", background: pct >= 80 ? "#5fd85f" : pct >= 60 ? "#e8c04a" : "#e87a5f", transition: "width .3s" }} />
            </div>
            <span style={{ width: 30, textAlign: "right", fontSize: 12 }}>{v}</span>
          </div>
        );
      })}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, paddingTop: 6, borderTop: "1px solid #2a2540" }}>
        <span style={{ fontSize: 12, color: "#a8a3c8" }}>轮数：{scores?.rounds ?? 0}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#8fc7ff" }}>总分 {Math.round(Number(scores?.total) || 0)}</span>
      </div>
    </div>
  );
}

/** SVG 五边形雷达图（每维 0-100 归一；scores 为累计分时按轮数取均值） */
export function ScoreRadar({ scores, rounds }) {
  const n = DIMS.length;
  const cx = 90, cy = 85, R = 62;
  // useMemo：pts/avg/ring 几何计算缓存——scores/rounds 不变不重算（声明式 + 性能优化）
  const { poly, rings, spokes, labels } = useMemo(() => {
    const pts = (vals) =>
      DIMS.map((_, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        const r = R * (vals[i] / 100);
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      });
    const avg = (k) => {
      const r = Math.max(1, Number(rounds) || 1);
      return Math.min(100, Math.round((Number(scores?.[k]) || 0) / r));
    };
    const vals = DIMS.map(([k]) => avg(k));
    const poly = pts(vals).map((p) => p.join(",")).join(" ");
    const rings = [25, 50, 75, 100].map((p) => pts(DIMS.map(() => p)).map((p2) => p2.join(",")).join(" "));
    const spokes = DIMS.map((_, i) => pts([100, 100, 100, 100, 100])[i]);
    const labels = pts(DIMS.map(() => 100)).map((p, i) => ({ x: p[0], y: p[1], label: DIMS[i][1] }));
    return { poly, rings, spokes, labels };
  }, [scores, rounds, n, cx, cy, R]);

  return (
    <svg width={180} height={170} viewBox="0 0 180 170">
      {rings.map((pts, i) => (
        <polygon key={i} points={pts} fill="none" stroke="#2a2540" strokeWidth={1} />
      ))}
      {spokes.map(([x1, y1], i) => (
        <line key={i} x1={x1} y1={y1} x2={cx} y2={cy} stroke="#2a2540" strokeWidth={1} />
      ))}
      <polygon points={poly} fill="rgba(143,199,255,.25)" stroke="#8fc7ff" strokeWidth={2} />
      {labels.map((l) => (
        <text key={l.label} x={l.x} y={l.y + 4} fontSize={9} fill="#a8a3c8" textAnchor="middle">{l.label}</text>
      ))}
    </svg>
  );
}
