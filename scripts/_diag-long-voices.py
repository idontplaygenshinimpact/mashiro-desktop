# 长句完整性诊断：whisper 转写 vs 日语原文 —— 总覆盖率 + 末尾完整度（检测"话没说完"）
# 用法：py -3.12 scripts/_diag-long-voices.py
import json, os, sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from faster_whisper import WhisperModel

ROOT = r"D:/mianshi-agent"
OUT_DIR = os.path.join(ROOT, "assets", "voice", "long")
CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")

def clean(s):
    return "".join(ch for ch in s if ch.isalnum())

def grams(s, n=2):
    return {s[i:i+n] for i in range(len(s)-n+1)}

def cov(got, exp):
    eg, gg = grams(clean(exp)), grams(clean(got))
    if not eg:
        return 0.0
    return len(eg & gg) / len(eg)

def tail(got, exp, n=12):
    # 末尾完整度：转写末尾 n 个字符 vs 原文末尾 n 个字符的 2-gram 覆盖率
    # "话没说完"的特征：原文末句缺失 → 转写末尾与原文末尾几乎无交集
    return cov(got[-40:], exp[-40:])

print(f"{'file':<24}{'总覆盖':>7}{'末尾':>7}  末尾转写")
for l in CFG["longs"]:
    p = os.path.join(OUT_DIR, l["file"])
    if not os.path.exists(p):
        print(f"{l['file']:<24} MISSING")
        continue
    segs, _ = m.transcribe(p, language="ja", beam_size=5)
    got = "".join(s.text for s in segs).strip()
    total = cov(got, l["jp"])
    t = tail(got, l["jp"])
    flag = "⚠️ 话没说完" if t < 0.3 else ("⚠ 内容缺失" if total < 0.6 else "✅")
    print(f"{l['file']:<24}{total*100:6.0f}%{t*100:6.0f}%  {flag}  …{got[-30:]}")
