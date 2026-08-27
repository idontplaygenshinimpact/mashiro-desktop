# 诊断：原版 idle-long-1.wav 末尾实际内容（决定精准补尾补什么）
# 用法：py -3.12 scripts/_probe-tail.py
import os, sys, json, subprocess, io
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = r"D:\mianshi-agent"
WAV = os.path.join(ROOT, "assets", "voice", "long", "idle-long-1.wav")
FFMPEG = r"D:\hfut\file\Videopro\exp01\exp01_ffmpeg\ffmpeg\ffmpeg\bin\ffmpeg.exe"
TAIL_SECS = 90

# 1) 截取尾部 90s
tmp = os.path.join(ROOT, "data", "_tail-probe.wav")
subprocess.run([FFMPEG, "-y", "-v", "error", "-sseof", f"-{TAIL_SECS}", "-i", WAV, tmp], check=True)

# 2) whisper 转写
from faster_whisper import WhisperModel
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
segs, _ = m.transcribe(tmp, language="ja", beam_size=5)
got = "".join(s.text for s in segs).strip()
print("== 原版 idle-long-1 尾部 90s 转写 ==")
print(got[-200:])

# 3) 原文末尾
cfg = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
jp = [l["jp"] for l in cfg["longs"] if l["file"] == "idle-long-1.wav"][0]
print("\n== 原文末尾 100 字 ==")
print(jp[-100:])

def clean(s):
    return "".join(ch for ch in s if ch.isalnum() and not ch.isascii() or (ch.isascii() and ch.isalnum()))
def grams(s):
    return {s[i:i+2] for i in range(len(s)-1)} if len(s) >= 2 else set()
exp, g = clean(jp), clean(got)
n = 24
te, tg = grams(exp[-n:]), grams(g[-n:])
print(f"\n末尾 24 字 2-gram 覆盖: {len(te & tg)/len(te)*100:.0f}%")
print(f"转写末尾 24 字: {g[-24:]}")
print(f"原文末尾 24 字: {exp[-24:]}")
os.unlink(tmp)
