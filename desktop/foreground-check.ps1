# Foreground window detector: desktop / fullscreen / normal
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32FS {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
"@

$h = [Win32FS]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[Win32FS]::GetClassName($h, $sb, 256) | Out-Null
$cls = $sb.ToString()

if ($cls -eq "Progman" -or $cls -eq "WorkerW") {
  Write-Output "DESKTOP"
  exit 0
}

$rect = New-Object Win32FS+RECT
[Win32FS]::GetWindowRect($h, [ref]$rect) | Out-Null
$mi = New-Object Win32FS+MONITORINFO
$mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32FS+MONITORINFO])
[Win32FS]::GetMonitorInfo([Win32FS]::MonitorFromWindow($h, 2), [ref]$mi) | Out-Null

$w = $rect.Right - $rect.Left
$ht = $rect.Bottom - $rect.Top
$mw = $mi.rcMonitor.Right - $mi.rcMonitor.Left
$mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top

if ($w -ge $mw -and $ht -ge $mh) {
  Write-Output "FULLSCREEN"
} else {
  Write-Output "NORMAL"
}
