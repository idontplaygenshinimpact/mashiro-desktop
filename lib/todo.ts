// Agent 任务清单（todo）：多步任务的可见进度（对标 DSH todo_write）
// 持久化到 settings 表（JSON），面板刷新不丢；agent 用 todo_init/todo_done 推进
// 全量 TS 升级工单阶段 3 批次 E9：lib/todo.mjs 保留为桶（agent/routes/工具实现/测试 13+ 导入位零改动）
import { db } from "./db.mjs";

const KEY = "agent_todo";

/** 清单项（content 展示文本；done 完成标记） */
export interface TodoItem {
  content: string;
  done: boolean;
}

/** 清单（无清单 → items: []） */
export interface Todo {
  items: TodoItem[];
}

/** 计划步骤（title 目标文本；done 完成标记） */
export interface PlanStep {
  title: string;
  done: boolean;
}

/** 计划状态机（pending → confirmed → done/cancelled；settings 持久化，进程重启可恢复） */
export interface PlanState {
  id: string;
  goal: string;
  steps: PlanStep[];
  currentStep: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** 读取当前清单（无 → 空） */
export function getTodo(): Todo {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY);
    if (row?.value != null) {
      const parsed = JSON.parse(String(row.value));
      if (Array.isArray(parsed.items)) return { items: parsed.items.map((i: { content?: unknown; done?: unknown }) => ({ content: String(i.content || ""), done: !!i.done })) };
    }
  } catch { /* ignore */ }
  return { items: [] };
}

function save(items: TodoItem[]): void {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(KEY, JSON.stringify({ items, ts: Date.now() }), Date.now());
  } catch { /* ignore */ }
}

/** 初始化清单：替换 + 保留已存在项（按内容去重合并），返回最终清单 */
export function initTodo(newItems: unknown): Todo {
  const list = (Array.isArray(newItems) ? newItems : [])
    .map((i) => String((i && typeof i === "object" ? (i as { content?: unknown }).content : i) ?? "").trim().slice(0, 100))
    .filter(Boolean);
  if (!list.length) return getTodo();
  const existing = getTodo().items;
  const merged: TodoItem[] = [];
  const seen = new Set<string>();
  for (const it of [...existing, ...list.map((content) => ({ content, done: false }))]) {
    if (seen.has(it.content)) continue;
    seen.add(it.content);
    merged.push(it);
  }
  save(merged);
  return { items: merged };
}

/** 标记完成/未完成：按 index 或内容匹配 */
export function updateTodoItem({ index = null, content = "", done = true }: { index?: number | null; content?: string; done?: boolean } = {}): { ok: boolean; error?: string; items?: TodoItem[] } {
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
export function clearTodo(): Todo {
  save([]);
  return { items: [] };
}

// ============ 编排能力缺口工单 T1：PlanStore（对话级计划状态机） ============
// 与 todo（展示层清单）分离：plan 是"先计划后执行"的执行状态机——
//   status: pending（plan_task 创建，待 plan_mode 确认）→ confirmed（用户确认）→ done/cancelled
// 持久化到 settings 表（agent_plan key），进程重启可恢复；新对话 clearPlan（会话重置口径）
const PLAN_KEY = "agent_plan";

/** 创建/替换计划（plan_task 写库）——steps 保留未完成项（与 initTodo 同口径合并） */
export function initPlan({ goal = "", steps = [] }: { goal?: string; steps?: Array<{ title?: string } | string> } = {}): { ok: false; error: string } | { ok: true; plan: PlanState } {
  const g = String(goal || "").trim().slice(0, 200);
  const list = (Array.isArray(steps) ? steps : [])
    .map((s) => String((s && typeof s === "object" ? s.title : s) ?? "").trim().slice(0, 100))
    .filter(Boolean);
  if (!g || !list.length) return { ok: false, error: "计划需要目标与至少一个步骤" };
  const existing = getPlan();
  const merged: PlanStep[] = [];
  const seen = new Set<string>();
  // 保留旧计划未完成步骤（同目标续跑）；新步骤追加
  for (const it of [...(existing?.status === "active" ? existing.steps.filter((s) => !s.done) : []), ...list.map((title) => ({ title, done: false }))]) {
    if (seen.has(it.title)) continue;
    seen.add(it.title);
    merged.push(it);
  }
  const plan: PlanState = {
    id: `plan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    goal: g,
    steps: merged,
    currentStep: 0, // 当前执行步索引（0-based；全部完成 = steps.length）
    status: "pending", // pending → confirmed → done/cancelled
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(PLAN_KEY, JSON.stringify(plan), Date.now());
  } catch { /* ignore */ }
  return { ok: true, plan };
}

/** 读取当前计划（无 → null） */
export function getPlan(): PlanState | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PLAN_KEY);
    if (row?.value != null) {
      const p = JSON.parse(String(row.value));
      if (p && typeof p === "object" && p.goal && Array.isArray(p.steps)) return p as PlanState;
    }
  } catch { /* ignore */ }
  return null;
}

/** 用户确认计划（plan_mode ✅ 执行后调用）→ status: confirmed */
export function confirmPlan(): { ok: boolean; error?: string; plan?: PlanState } {
  const p = getPlan();
  if (!p || p.status !== "pending") return { ok: false, error: "没有待确认的计划" };
  p.status = "confirmed";
  p.updatedAt = Date.now();
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(PLAN_KEY, JSON.stringify(p), Date.now());
  } catch { /* ignore */ }
  return { ok: true, plan: p };
}

/** 推进计划：标记当前步完成 + currentStep 后移；全部完成 → status: done */
export function advancePlan(): { ok: boolean; error?: string; done?: boolean; plan?: PlanState } {
  const p = getPlan();
  if (!p || p.status !== "confirmed") return { ok: false, error: "没有进行中的已确认计划" };
  if (p.currentStep >= p.steps.length) { p.status = "done"; p.updatedAt = Date.now(); savePlan(p); return { ok: true, done: true, plan: p }; }
  p.steps[p.currentStep] = { ...p.steps[p.currentStep], done: true };
  p.currentStep += 1;
  if (p.currentStep >= p.steps.length) p.status = "done";
  p.updatedAt = Date.now();
  savePlan(p);
  return { ok: true, done: p.status === "done", plan: p };
}

/** 取消计划（plan_mode ❌ 或用户放弃）→ status: cancelled */
export function cancelPlan(): { ok: boolean; error?: string; plan?: PlanState } {
  const p = getPlan();
  if (!p) return { ok: false, error: "没有计划" };
  p.status = "cancelled";
  p.updatedAt = Date.now();
  savePlan(p);
  return { ok: true, plan: p };
}

/** 清空计划（新对话会话重置） */
export function clearPlan(): void {
  try {
    db.prepare("DELETE FROM settings WHERE key = ?").run(PLAN_KEY);
  } catch { /* ignore */ }
}

function savePlan(plan: PlanState): void {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(PLAN_KEY, JSON.stringify(plan), Date.now());
  } catch { /* ignore */ }
}

/** 计划状态文本（system prompt 注入：第 N/M 步 + 目标 + 未完成步骤——防 LLM 中途跑偏） */
export function planStatusText(): string {
  const p = getPlan();
  if (!p || p.status === "cancelled") return "";
  if (p.status === "pending") return `【当前计划（待确认）】目标：${p.goal}\n步骤：${p.steps.map((s, i) => `${i + 1}. ${s.title}${s.done ? " ✅" : ""}`).join("\n")}\n**必须先调用 plan_mode 让用户确认计划，确认后才能执行步骤。**`;
  if (p.status === "done") return `【当前计划（已完成）】目标：${p.goal}——全部步骤已完成，可以总结收尾。`;
  const cur = p.steps[p.currentStep];
  return `【当前计划（执行中）】目标：${p.goal}——第 ${p.currentStep + 1}/${p.steps.length} 步：${cur ? cur.title : "（已完成）"}\n未完成步骤：${p.steps.slice(p.currentStep).map((s, i) => `${p.currentStep + i + 1}. ${s.title}`).join("、")}\n**按步骤顺序执行，每完成一步调用 todo_done 推进；不要跳过未完成步骤。**`;
}
