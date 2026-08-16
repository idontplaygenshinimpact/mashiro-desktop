# Mashiro desk pet launcher: create desktop shortcut (first run) then start Electron.
# NOTE: keep this file pure ASCII -- Windows PowerShell 5.1 reads BOM-less files as ANSI,
# so any CJK literal would garble. The shortcut name is built from code points instead.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1 -AppDir "D:\mianshi-agent"
param([string]$AppDir = "")

if (-not $AppDir) { $AppDir = Split-Path -Parent $PSScriptRoot }
$exe = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'

# 1) Desktop shortcut (create once; skip if exists)
# "Mashiro" = U+771F U+767D ; "desk pet" = U+684C U+5BA0
$name = -join [char[]](0x771F, 0x767D, 0x684C, 0x5BA0)
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($name + '.lnk')
if (-not (Test-Path $lnk)) {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath = $exe
    $s.Arguments = Join-Path $AppDir 'desktop\main.mjs'
    $s.WorkingDirectory = $AppDir
    $s.IconLocation = "$exe,0"
    $s.Description = 'Mashiro frontend job-hunt desk pet'
    $s.Save()
  } catch {
    # shortcut failure must not block launch
  }
}

# 2) Start the pet (hidden; duplicate launch is blocked by single-instance lock)
if (Test-Path $exe) {
  Start-Process $exe -ArgumentList (Join-Path $AppDir 'desktop\main.mjs')
}
