# 真白 TTS 播放脚本：接收文本文件路径，用系统日语语音朗读（不用中文语音）
param([string]$TextFile)
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
# 优先日语声线（Haruka 是 Windows 自带日语女声）；不存在则回退默认
try { $s.SelectVoice("Microsoft Haruka Desktop") } catch { }
$s.Rate = 1
$s.Volume = 90
$s.Speak($text)
$s.Dispose()
