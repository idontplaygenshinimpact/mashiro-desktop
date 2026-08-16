@echo off
rem ============================================================
rem  真白 · 前端秋招桌宠 启动器（无黑窗）
rem  首次运行自动在桌面创建快捷方式「真白桌宠」，之后双击桌面图标即可
rem  重复启动会被单实例锁拦截（聚焦到已运行窗口），不会出现双实例
rem ============================================================
set "APP_DIR=%~dp0"
set "APP_DIR=%APP_DIR:~0,-1%"

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%APP_DIR%\scripts\create-shortcut.ps1" -AppDir "%APP_DIR%"
exit
