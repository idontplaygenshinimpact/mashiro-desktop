# 验证 assets/voice/long 全部文件完整性：whisper 转写 vs 原文覆盖率
# 算法：2-gram 集合覆盖率（对 whisper 转写错字鲁棒，不依赖字符顺序）
# 用法：py -3.12 scripts/verify-voices.py
import json, os, sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from faster_whisper import WhisperModel

ROOT = r"D:/mianshi-agent"
OUT_DIR = os.path.join(ROOT, "assets", "voice", "long")
CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")

def clean(s):
    return "".join(ch for ch in s if (ch.isascii() and ch.isalnum()) or (not ch.isascii() and ch.isalnum()))

def grams(s, n=2):
    return {s[i:i+n] for i in range(len(s)-n+1)}

def verify(wav_path, expected):
    segs, _ = m.transcribe(wav_path, language="ja", beam_size=1)
    got = "".join(s.text for s in segs).strip()
    exp_g = grams(clean(expected))
    got_g = grams(clean(got))
    if not exp_g:
        return 0.0, got
    return len(exp_g & got_g) / len(exp_g), got

rows = []
for l in CFG["lines"] + CFG.get("longs", []):
    p = os.path.join(OUT_DIR, l["file"])
    if not os.path.exists(p):
        rows.append((l["file"], "MISSING", 0.0, ""))
        continue
    cov, got = verify(p, l["jp"])
    rows.append((l["file"], "OK", cov, got[:60]))
    print(f"OK {l['file']}: {cov*100:5.0f}%  {got[:60]}")

rows.sort(key=lambda r: r[2])
bad = [r for r in rows if r[2] < 0.5]
print(f"\nTOTAL {len(rows)}  达标(>=50%): {len(rows)-len(bad)}  待重试(<50%): {len(bad)}")
for fname, st, cov, got in bad:
    print(f"  LOW {fname}: {cov*100:.0f}%")
