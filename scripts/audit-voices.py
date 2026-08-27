# 审计 assets/voice/long 全部文件：2-gram 覆盖率 + ref 泄漏 + 末尾完整度（话没说完预警）
# 升级项：
#   - beam_size 1→5（识别更准，降低误判）
#   - 长句（*-long-*）额外检查末尾完整度：转写末尾 vs 原文末尾 <0.3 → TRUNC（话没说完）
#     （旧版只查总覆盖 0.5，长句"话没说完"被放过——2026-08 实测全部长句末尾缺失）
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

def grams(s, n=2):
    return {s[i:i+n] for i in range(len(s)-n+1)}

def cov(got, exp):
    eg, gg = grams(clean(exp)), grams(clean(got))
    return len(eg & gg) / len(eg) if eg else 0.0

POLLUTE = ["話しちゃダメ", "声をかけて", "空とに黙って", "エスカレーター", "綾野が"]  # ref-clean-A 特征（ref-clean-2 语气不符人设已回滚）
TAIL_MIN = 0.3  # 末尾完整度下限（长句：结尾句子缺失 → <0.3 判话没说完）

bad, trunc, pollute = [], [], []
for l in lines:
    p = os.path.join(ROOT, "assets", "voice", "long", l["file"])
    segs, _ = m.transcribe(p, language="ja", beam_size=5)
    got = "".join(s.text for s in segs).strip()
    total = cov(got, l["jp"])
    # 末尾完整度：转写最后 24 字 vs 原文最后 24 字
    tail = cov(got[-24:], l["jp"][-24:])
    pol = [k for k in POLLUTE if k in got]
    is_long = "-long-" in l["file"] or "long" in os.path.basename(l["file"])
    ok = total >= 0.5 and not pol and not (is_long and tail < TAIL_MIN)
    if not ok:
        if pol:
            pollute.append(l["file"])
        elif is_long and tail < TAIL_MIN:
            trunc.append(l["file"])
        else:
            bad.append(l["file"])
    state = "TRUNC" if (is_long and tail < TAIL_MIN) else ("POLLUT" if pol else ("BAD" if not ok else "OK"))
    print(f"{state:<6} {l['file']:<24} cov={total*100:5.0f}% tail={tail*100:5.0f}%" + (f" 泄漏={pol}" if pol else (f" ← 话没说完" if state == "TRUNC" else "")))

print(f"\n结果: 全部 {len(lines)} | ❌ 覆盖率不足 {len(bad)} {bad} | ⚠️ 话没说完(长句) {len(trunc)} {trunc} | 🔴 ref泄漏 {len(pollute)} {pollute}")
print("全部通过" if not (bad or trunc or pollute) else "存在需重合成的文件（长句话没说完 → 提高分块/采样后重跑 synth）")
