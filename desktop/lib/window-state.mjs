// desktop/lib/window-state.mjs —— 窗口位置持久化（纵向拆分：从 desktop/main.mjs 迁出）
// 纯逻辑模块（无 electron 依赖，可单测）：读写 data/window-state.json（防抖保存）+ 屏内校验
import { readFileSync, writeFileSync } from "node:fs";

const SAVE_DELAY_MS = 400; // 防抖：拖动/缩放时避免频繁写盘

/** 读取窗口状态（无文件/损坏返回 {}） */
export function readWindowState(stateFile) {
  try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; }
}

/** 写窗口状态（{ mascot, panel }） */
export function saveWindowState(stateFile, { mascot, panel }) {
  try {
    writeFileSync(stateFile, JSON.stringify({ mascot, panel }, null, 2), "utf8");
  } catch { /* ignore */ }
}

/** 防抖保存：返回 cancel（再次调用会重置计时） */
export function scheduleSaveWindowState(stateFile, getState, delayMs = SAVE_DELAY_MS) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveWindowState(stateFile, getState());
    }, delayMs);
  };
}

/**
 * 校验位置是否在屏内（至少露出 40px，避免恢复到屏幕外）
 * @param {{x:number,y:number,width:number,height:number}} workArea 屏幕工作区（screen.getPrimaryDisplay().workArea）
 */
export function isOnScreen(workArea, x, y, w, h) {
  if (!workArea) return false;
  const minVisible = 40;
  return (
    x + minVisible <= workArea.x + workArea.width &&
    x + w - minVisible >= workArea.x &&
    y + minVisible <= workArea.y + workArea.height &&
    y + h - minVisible >= workArea.y
  );
}
