@echo off
rem Mashiro desk pet launcher (no cmd window)
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process 'D:\mianshi-agent\node_modules\electron\dist\electron.exe' -ArgumentList 'D:\mianshi-agent\desktop\main.mjs'"
exit
