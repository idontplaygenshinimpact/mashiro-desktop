// desktop/lib/window-state.ts —— 窗口位置持久化（纵向拆分：从 desktop/main.mjs 迁出）
// 纯逻辑模块（无 electron 依赖，可单测）：读写 data/window-state.json（防抖保存）+ 屏内校验
// 全量 TS 升级工单阶段 4（桌面）：desktop/lib/window-state.mjs → .ts
//   调用方 2 处：desktop/main.mjs（`./lib/window-state.mjs` 写法）、tests/desktop-utils.test.mjs → 直接改路径
import { readFileSync, writeFileSync } from "node:fs";

const SAVE_DELAY_MS = 400; // 防抖：拖动/缩放时避免频繁写盘

/** 窗口几何（mascot = 桌宠窗口，panel = 面板窗口） */
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 持久化的窗口状态（**允许部分字段**：桌宠窗口尺寸固定 → 只存 x/y；读回时也按缺失容错） */
export interface WindowState {
  mascot?: Partial<WindowRect>;
  panel?: Partial<WindowRect>;
}

/** 屏幕工作区（screen.getPrimaryDisplay().workArea 的纯数据形状） */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 读取窗口状态（无文件/损坏返回 {}） */
export function readWindowState(stateFile: string): WindowState {
  try { return JSON.parse(readFileSync(stateFile, "utf8")) as WindowState; } catch { return {}; }
}

/** 写窗口状态（{ mascot, panel }） */
export function saveWindowState(stateFile: string, { mascot, panel }: WindowState): void {
  try {
    writeFileSync(stateFile, JSON.stringify({ mascot, panel }, null, 2), "utf8");
  } catch { /* ignore */ }
}

/** 防抖保存：返回 cancel（再次调用会重置计时） */
export function scheduleSaveWindowState(stateFile: string, getState: () => WindowState, delayMs = SAVE_DELAY_MS): () => void {
  let timer: NodeJS.Timeout | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveWindowState(stateFile, getState());
    }, delayMs);
  };
}

/**
 * 校验位置是否在屏内（至少露出 40px，避免恢复到屏幕外）
 * @param workArea 屏幕工作区（screen.getPrimaryDisplay().workArea）
 */
export function isOnScreen(workArea: WorkArea | null | undefined, x: number, y: number, w: number, h: number): boolean {
  if (!workArea) return false;
  const minVisible = 40;
  return (
    x + minVisible <= workArea.x + workArea.width &&
    x + w - minVisible >= workArea.x &&
    y + minVisible <= workArea.y + workArea.height &&
    y + h - minVisible >= workArea.y
  );
}
