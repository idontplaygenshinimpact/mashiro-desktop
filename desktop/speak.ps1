# 真白 TTS 播放脚本：接收文本文件路径，用系统中文语音朗读
param([string]$TextFile)
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice("Microsoft Huihui Desktop") } catch { }
$s.Rate = 1
$s.Volume = 90
$s.Speak($text)
$s.Dispose()
