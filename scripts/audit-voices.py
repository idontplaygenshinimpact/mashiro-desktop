# 审计 assets/voice/long 全部文件：2-gram 覆盖率 + ref 泄漏检测
import json, os, sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from faster_whisper import WhisperModel

ROOT = r"D:/mianshi-agent"
CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
lines = CFG["lines"] + CFG.get("longs", [])
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")

def clean(s):
    return "".join(ch for ch in s if (ch.isascii() and ch.isalnum()) or (not ch.isascii() and ch.isalnum()))

def grams(s):
    return {s[i:i+2] for i in range(len(s)-1)}

POLLUTE = ["話しちゃダメ", "声をかけて", "空とに黙って", "エスカレーター", "綾野が"]

bad = []
for l in lines:
    p = os.path.join(ROOT, "assets", "voice", "long", l["file"])
    segs, _ = m.transcribe(p, language="ja", beam_size=1)
    got = "".join(s.text for s in segs).strip()
    exp_g, got_g = grams(clean(l["jp"])), grams(clean(got))
    cov = len(exp_g & got_g) / len(exp_g) if exp_g else 0.0
    pol = [k for k in POLLUTE if k in got]
    ok = cov >= 0.5 and not pol
    if not ok:
        bad.append(l["file"])
    print(f"{'OK ' if ok else 'BAD'} {l['file']}: cov={cov*100:.0f}%" + (f" POLLUTE={pol}" if pol else ""))

print(f"\nBAD files: {len(bad)} -> {bad}" if bad else "\nALL GOOD (26/26)")
