@echo off
rem mianshi-agent 看板娘开机自启
rem 启动 Electron 看板娘（主进程会自动拉起 widget.mjs 数据服务）
start "" /min "D:\mianshi-agent\node_modules\electron\dist\electron.exe" "D:\mianshi-agent\desktop\main.mjs"
