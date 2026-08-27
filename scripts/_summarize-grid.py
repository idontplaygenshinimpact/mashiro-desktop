# 汇总参数网格结果（读取 data/param-grid.json）
import json, sys, collections
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
d = json.load(open(r"D:\mianshi-agent\data\param-grid.json", encoding="utf-8"))
rows = d["grid"]
print("=== TOP 8 参数组合 ===")
for r in rows[:8]:
    s = r.get("短句") or {}
    z = r.get("中句") or {}
    w = r.get("语气词尾句") or {}
    print(f"top_k={r['top_k']:>3} top_p={r['top_p']} temp={r['temp']} avg={r['avg']} | 短句={s.get('score','-')} 中句={z.get('score','-')} 尾句={w.get('score','-')}")
print()
print("=== 最差 3 组 ===")
for r in rows[-3:]:
    print(f"top_k={r['top_k']:>3} top_p={r['top_p']} temp={r['temp']} avg={r['avg']}")
print()
def dim(key):
    groups = collections.defaultdict(list)
    for r in rows:
        groups[r[key]].append(r["avg"])
    return {k: round(sum(v) / len(v), 3) for k, v in groups.items()}
print("top_k 维度平均:", dim("top_k"))
print("top_p 维度平均:", dim("top_p"))
print("temp  维度平均:", dim("temp"))
print()
print("=== 尾句（最难）表现最佳的组合 ===")
def tail_best():
    return sorted(rows, key=lambda r: (r.get("语气词尾句") or {}).get("score", 0), reverse=True)[:3]
for r in tail_best():
    print(f"top_k={r['top_k']} top_p={r['top_p']} temp={r['temp']} avg={r['avg']} 尾句={r['语气词尾句'].get('score')}")
