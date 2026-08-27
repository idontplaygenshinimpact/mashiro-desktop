# 低分文件补合成：多采样（最多 12 次）取"无 ref 污染 + 2-gram 完整度最高"的结果
# 用法：py -3.12 scripts/refix-voices.py [file1 file2 ...]（默认处理上次审计低分文件）
import sys, os, io, json, argparse

SOVITS_ROOT = r"D:/GPT-SoVITS/GPT-SoVITS"
sys.path.insert(0, SOVITS_ROOT)
sys.path.insert(0, os.path.join(SOVITS_ROOT, "GPT_SoVITS"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["cnhubert_base_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-hubert-base"
os.environ["bert_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
os.chdir(SOVITS_ROOT)

import soundfile as sf
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
from faster_whisper import WhisperModel

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ap = argparse.ArgumentParser()
ap.add_argument("files", nargs="*", help="wav 文件名（不带路径），缺省处理全部低于阈值的")
args = ap.parse_args()

CFG = json.load(open(r"D:\mianshi-agent\scripts\long-lines.json", encoding="utf-8"))
lines = {l["file"]: l for l in CFG["lines"] + CFG.get("longs", [])}
OUT = r"D:\mianshi-agent\assets\voice\long"
REF = CFG["ref_wav"]
RT = CFG["ref_text"]

list(change_sovits_weights(sovits_path=CFG["sovits"], prompt_language="日文", text_language="日文"))
change_gpt_weights(gpt_path=CFG["gpt"])
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")

POLLUTE = ["話しちゃダメ", "声をかけて", "空とに黙って", "エスカレーター", "離しちゃダメ", "飛んでく"]

def clean(s):
    return "".join(ch for ch in s if (ch.isascii() and ch.isalnum()) or (not ch.isascii() and ch.isalnum()))

def grams(s):
    return {s[i:i+2] for i in range(len(s)-1)}

def synth(text):
    result = list(get_tts_wav(ref_wav_path=REF, prompt_text=RT, prompt_language="日文",
                              text=text, text_language="日文", top_k=20, top_p=1, temperature=1, pause_second=0.12))
    return result[-1]

targets = args.files if args.files else [
    "done-1.wav", "interview-1.wav", "interview-2.wav", "idle-2.wav", "music-1.wav",
    "praise-long-1.wav", "review-long-1.wav", "idle-long-1.wav",
]
for fname in targets:
    l = lines.get(fname)
    if not l:
        print(f"SKIP {fname}（不在清单）")
        continue
    # 长句保护：整条合成会超过 GPT 生成时长上限（max_sec）导致尾部硬截断，
    # 且 12 次采样救不了"系统性尾部丢词"——长句必须走 synth 的拆块+尾部专项评分。
    if "-long-" in fname:
        print(f"SKIP {fname}（长句禁止整条合成：请用 synth-mashiro-long.py 重跑该 scene，已带尾部覆盖评分+尾部块专项）")
        continue
    TEXT = l["jp"]
    exp_g = grams(clean(TEXT))
    best = None  # (score, pol, secs, audio, sr)
    for i in range(12):
        sr, audio = synth(TEXT)
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV")
        buf.seek(0)
        segs, _ = m.transcribe(buf, language="ja", beam_size=5)
        got = "".join(s.text for s in segs).strip()
        g = clean(got)
        gg = grams(g) if len(g) >= 2 else set()
        cov = len(exp_g & gg) / len(exp_g) if exp_g else 0.0
        pol = [k for k in POLLUTE if k in got]
        score = cov - 0.4 * len(pol)  # 污染惩罚
        if not best or score > best[0]:
            best = (score, pol, len(audio) / sr, audio, sr)
            print(f"  {fname} #{i+1}: cov={cov*100:.0f}% pol={pol} {len(audio)/sr:.1f}s", flush=True)
        if cov >= 0.55 and not pol:
            break
    score, pol, secs, audio, sr = best
    sf.write(os.path.join(OUT, fname), audio, sr)
    print(f"OK {fname}: {secs:.1f}s pol={pol} score={score:.2f}")
print("DONE")
