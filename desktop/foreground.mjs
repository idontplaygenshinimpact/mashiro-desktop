// 前台窗口检测（koffi FFI 直调 Win32，毫秒级，替代慢速 PowerShell）
import koffi from "koffi";

const user32 = koffi.load("user32.dll");

const RECT = koffi.struct("RECT", {
  left: "int32",
  top: "int32",
  right: "int32",
  bottom: "int32",
});

const GetForegroundWindow = user32.func("intptr_t GetForegroundWindow()");
// 用 Buffer 接收类名字符串（char* 输出参数）
const GetClassNameA = user32.func("int GetClassNameA(intptr_t hWnd, _Out_ void* lpClassName, int nMaxCount)");
const GetWindowRect = user32.func("bool GetWindowRect(intptr_t hWnd, _Out_ RECT* lpRect)");
const GetSystemMetrics = user32.func("int GetSystemMetrics(int nIndex)");

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

let cachedScreen = { w: 0, h: 0 };
function getScreenSize() {
  const w = GetSystemMetrics(SM_CXSCREEN);
  const h = GetSystemMetrics(SM_CYSCREEN);
  if (w !== cachedScreen.w || h !== cachedScreen.h) cachedScreen = { w, h };
  return cachedScreen;
}

/**
 * 检测前台窗口状态
 * @returns "desktop" | "fullscreen" | "normal"
 */
export function detectForegroundSync() {
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return "normal";

    // 类名（ANSI 版，类名均为 ASCII）——用 Buffer 接收
    const nameBuf = Buffer.alloc(256);
    GetClassNameA(hwnd, nameBuf, 256);
    let cls = "";
    for (const b of nameBuf) {
      if (b === 0) break;
      cls += String.fromCharCode(b);
    }

    // 桌面：Progman / WorkerW
    if (cls === "Progman" || cls === "WorkerW") return "desktop";

    // 全屏检测：窗口 rect 覆盖整个主屏
    const rect = { left: 0, top: 0, right: 0, bottom: 0 };
    const ok = GetWindowRect(hwnd, rect);
    if (!ok) return "normal";

    const { w, h } = getScreenSize();
    const winW = rect.right - rect.left;
    const winH = rect.bottom - rect.top;

    // 容差 4px（窗口边框）
    if (winW >= w - 4 && winH >= h - 4) return "fullscreen";
    return "normal";
  } catch (e) {
    return "normal"; // 检测失败保守不隐藏
  }
}
