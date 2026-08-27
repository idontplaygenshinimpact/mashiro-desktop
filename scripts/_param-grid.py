# 推理参数网格实验：找 GPT-SoVITS 最优参数组合（替代盲扫微扫描）
# 27 组 = top_k(5/10/20) × top_p(0.85/0.95/1.0) × temperature(0.6/0.8/1.0)
# 3 条代表性测试文本：短句 / 带停顿中句 / 语气词尾句（最难）
# 每组合成 1 次 + 四维评分（cov/tail/sim/pace），汇总找全局最优
# 用法：py -3.12 scripts/_param-grid.py
import sys, os, json, io, glob
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = r"D:\mianshi-agent"
SOVITS_ROOT = r"D:/GPT-SoVITS/GPT-SoVITS"
sys.path.insert(0, SOVITS_ROOT)
sys.path.insert(0, os.path.join(SOVITS_ROOT, "GPT_SoVITS"))
os.environ["cnhubert_base_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-hubert-base"
os.environ["bert_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
os.chdir(SOVITS_ROOT)

import numpy as np
import soundfile as sf
# import 顺序：GPT_SoVITS(torch) 必须先于 faster_whisper(ctranslate2)，否则 cudnnGetLibConfig 127
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
from faster_whisper import WhisperModel

CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
ANCHOR_CACHE = os.path.join(ROOT, "data", "mashiro-anchor.npy")
TRAIN_WAVS = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_raw/mashiro2/*.wav"

TEST_TEXTS = [
    ("短句", "さっき、窓の外を猫が通ったの。三毛猫だったよ。ちょっとだけ、絵に描いてみた。"),
    ("中句", "それから、今日のあなたの分のお茶も、用意しておくから。帰ってきたら、一緒に飲もう。"),
    ("语气词尾句", "うん、真白はここで、ちゃんと待ってるからね。"),
]

def clean_text(s):
    return "".join(ch for ch in s if ch.isalnum() and not ch.isascii() or (ch.isascii() and ch.isalnum()))

def verify_complete_v2(audio, sr, expected_text):
    try:
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV")
        buf.seek(0)
        segs, _ = m.transcribe(buf, language="ja", beam_size=5)
        got = "".join(s.text for s in segs).strip()
        exp, g = clean_text(expected_text), clean_text(got)
        grams = lambda s: {s[i:i+2] for i in range(len(s)-1)} if len(s) >= 2 else set()
        if len(exp) < 2:
            return (0.0, 0.0)
        eg, gg = grams(exp), grams(g)
        cov = len(eg & gg) / len(eg) if eg else 0.0
        n = min(10, len(exp), len(g))
        tail = 0.0 if n < 2 else (len(grams(exp[-n:]) & grams(g[-n:])) / len(grams(exp[-n:])))
        return (cov, tail)
    except Exception:
        return (0.0, 0.0)

def load_voice_anchor():
    if os.path.exists(ANCHOR_CACHE):
        return np.load(ANCHOR_CACHE)
    import torch
    from resemblyzer import VoiceEncoder, preprocess_wav
    enc = VoiceEncoder(torch.device("cpu"))
    embs = []
    for f in sorted(glob.glob(TRAIN_WAVS))[:300]:
        try:
            embs.append(enc.embed_utterance(preprocess_wav(f)))
        except Exception:
            pass
    a = np.mean(np.array(embs), axis=0)
    a = a / np.linalg.norm(a)
    os.makedirs(os.path.dirname(ANCHOR_CACHE), exist_ok=True)
    np.save(ANCHOR_CACHE, a)
    return a

def voice_sim_of(audio, sr, anchor, enc):
    try:
        import tempfile
        from resemblyzer import preprocess_wav
        tmp = tempfile.mktemp(suffix=".wav")
        sf.write(tmp, audio, sr, format="WAV")
        e = enc.embed_utterance(preprocess_wav(tmp))
        os.unlink(tmp)
        e = e / np.linalg.norm(e)
        return float(e @ anchor)
    except Exception:
        return None

def pace_score_of(audio, sr, expected_text):
    try:
        nchar = len(clean_text(expected_text))
        pacing = (len(audio) / sr) / max(nchar, 1) * 1000
        if 110 <= pacing <= 170:
            return (1.0, pacing)
        if 90 <= pacing <= 200:
            return (0.7, pacing)
        return (0.3, pacing)
    except Exception:
        return (0.3, None)

def quality_score(cov, tail, sim, pace):
    cov_s = min(cov / 0.8, 1.0)
    sim_s = min(max((sim - 0.7) / 0.2, 0), 1.0) if sim is not None else 0.0
    tail_s = min(tail / 0.5, 1.0)
    return cov_s * 0.35 + sim_s * 0.30 + pace * 0.20 + tail_s * 0.15

# ---------- 模型加载 ----------
list(change_sovits_weights(sovits_path=CFG["sovits"], prompt_language="日文", text_language="日文"))
change_gpt_weights(gpt_path=CFG["gpt"])
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
import torch
from resemblyzer import VoiceEncoder
voice_anchor = load_voice_anchor()
voice_enc = VoiceEncoder(torch.device("cpu"))

# ---------- 网格 ----------
GRID = []
for top_k in (5, 10, 20):
    for top_p in (0.85, 0.95, 1.0):
        for temp in (0.6, 0.8, 1.0):
            GRID.append((top_k, top_p, temp))

results = []
for gi, (top_k, top_p, temp) in enumerate(GRID, 1):
    row = {"top_k": top_k, "top_p": top_p, "temp": temp}
    scores = []
    for tname, text in TEST_TEXTS:
        try:
            result = list(get_tts_wav(
                ref_wav_path=CFG["ref_wav"], prompt_text=CFG["ref_text"], prompt_language="日文",
                text=text, text_language="日文", top_k=top_k, top_p=top_p, temperature=temp, pause_second=0.08,
            ))
            if not result:
                row[tname] = None
                continue
            s, audio = result[-1]
            cov, tail = verify_complete_v2(audio, s, text)
            sim = voice_sim_of(audio, s, voice_anchor, voice_enc)
            pace, pacing_ms = pace_score_of(audio, s, text)
            q = quality_score(cov, tail, sim, pace)
            row[tname] = {"cov": round(cov, 2), "tail": round(tail, 2), "sim": round(sim, 3) if sim else None, "pace": round(pacing_ms, 1) if pacing_ms else None, "score": round(q, 3)}
            scores.append(q)
        except Exception as e:
            row[tname] = {"error": str(e)[:60]}
    row["avg"] = round(sum(scores) / len(scores), 3) if scores else 0
    results.append(row)
    print(f"[{gi}/27] top_k={top_k} top_p={top_p} temp={temp} avg={row['avg']} 短句={row['短句']} 中句={row['中句']} 尾句={row['语气词尾句']}", flush=True)

results.sort(key=lambda r: r["avg"], reverse=True)
out = {"ref": CFG["ref_wav"], "test_texts": {n: t for n, t in TEST_TEXTS}, "grid": results}
os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
with open(os.path.join(ROOT, "data", "param-grid.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("\n===== TOP 5 参数组合 =====")
for r in results[:5]:
    print(f"top_k={r['top_k']} top_p={r['top_p']} temp={r['temp']} avg={r['avg']}")
print("结果已存 data/param-grid.json")
