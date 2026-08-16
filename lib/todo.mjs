// Agent 任务清单（todo）：多步任务的可见进度（对标 DSH todo_write）
// 持久化到 settings 表（JSON），面板刷新不丢；agent 用 todo_init/todo_done 推进
import { db } from "./db.mjs";

const KEY = "agent_todo";

/** 读取当前清单（无 → 空） */
export function getTodo() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY);
    if (row?.value != null) {
      const parsed = JSON.parse(String(row.value));
      if (Array.isArray(parsed.items)) return { items: parsed.items.map((i) => ({ content: String(i.content || ""), done: !!i.done })) };
    }
  } catch { /* ignore */ }
  return { items: [] };
}

function save(items) {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(KEY, JSON.stringify({ items, ts: Date.now() }), Date.now());
  } catch { /* ignore */ }
}

/** 初始化清单：替换 + 保留已存在项（按内容去重合并），返回最终清单 */
export function initTodo(newItems) {
  const list = (Array.isArray(newItems) ? newItems : []).map((i) => String(i?.content ?? i ?? "").trim().slice(0, 100)).filter(Boolean);
  if (!list.length) return getTodo();
  const existing = getTodo().items;
  const merged = [];
  const seen = new Set();
  for (const it of [...existing, ...list.map((content) => ({ content, done: false }))]) {
    if (seen.has(it.content)) continue;
    seen.add(it.content);
    merged.push(it);
  }
  save(merged);
  return { items: merged };
}

/** 标记完成/未完成：按 index 或内容匹配 */
export function updateTodoItem({ index = null, content = "", done = true } = {}) {
  const cur = getTodo().items;
  let target = -1;
  if (index !== null && Number.isInteger(Number(index))) {
    target = Number(index);
  } else if (content) {
    target = cur.findIndex((i) => i.content === String(content));
  }
  if (target < 0 || target >= cur.length) return { ok: false, error: `清单项不存在（共 ${cur.length} 项）` };
  cur[target] = { ...cur[target], done: !!done };
  save(cur);
  return { ok: true, items: cur };
}

/** 清空清单 */
export function clearTodo() {
  save([]);
  return { items: [] };
}
