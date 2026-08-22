// 前台窗口检测（koffi FFI 直调 Win32，毫秒级，替代慢速 PowerShell）
import koffi from "koffi";

const user32 = koffi.load("user32.dll");

const _RECT = koffi.struct("RECT", {
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
  } catch {
    return "normal"; // 检测失败保守不隐藏
  }
}

// ---------- 前台窗口信息（专注监督用：标题 + 进程名） ----------
// 标题读取（GetWindowTextW，UTF-16）；进程名 best-effort（GetWindowThreadProcessId + QueryFullProcessImageNameW）
// 全部 koffi 调用 try/catch 包裹，任何失败返回空串（不抛错、不中断检测循环）
const GetWindowTextW = user32.func("int GetWindowTextW(intptr_t hWnd, _Out_ void* lpString, int nMaxCount)");
const GetWindowThreadProcessId = user32.func("uint32 GetWindowThreadProcessId(intptr_t hWnd, _Out_ void* lpdwProcessId)");
const kernel32 = koffi.load("kernel32.dll");
const OpenProcess = kernel32.func("intptr_t OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)");
const QueryFullProcessImageNameW = kernel32.func("bool QueryFullProcessImageNameW(intptr_t hProcess, uint32 dwFlags, _Out_ void* lpExeName, _Inout_ void* lpdwSize)");
const CloseHandle = kernel32.func("bool CloseHandle(intptr_t hObject)");
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/**
 * 读取当前前台窗口的标题 + 进程名
 * @returns {{ title: string, processName: string }}
 */
export function getForegroundInfo() {
  try {
    const hwnd = GetForegroundWindow();
    if (!hwnd) return { title: "", processName: "" };

    // 标题（UTF-16，空串表示无标题窗口）
    let title = "";
    try {
      const buf = Buffer.alloc(512);
      const len = GetWindowTextW(hwnd, buf, 256);
      if (len > 0) title = buf.toString("utf16le", 0, len * 2);
    } catch { /* 标题读取失败按空处理 */ }

    // 进程名（best-effort；失败不影响标题）
    let processName = "";
    try {
      const pidBuf = Buffer.alloc(4);
      GetWindowThreadProcessId(hwnd, pidBuf);
      const pid = pidBuf.readUInt32LE(0);
      if (pid > 0) {
        const hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (hProcess) {
          try {
            const nameBuf = Buffer.alloc(1024);
            const sizeBuf = Buffer.alloc(4);
            sizeBuf.writeUInt32LE(512, 0);
            const ok = QueryFullProcessImageNameW(hProcess, 0, nameBuf, sizeBuf);
            if (ok) {
              const chars = sizeBuf.readUInt32LE(0);
              const fullPath = nameBuf.toString("utf16le", 0, Math.min(chars, 512) * 2);
              processName = (fullPath.split("\\").pop() || "").split("/").pop() || "";
            }
          } finally {
            try { CloseHandle(hProcess); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* 进程名读取失败按空处理 */ }

    return { title: title.trim(), processName };
  } catch {
    return { title: "", processName: "" };
  }
}
