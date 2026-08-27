# ref 锚点对比实验：6 套候选 ref × 3 代表文本 × 各 3 次采样（固定最优参数 top_k=20/p=0.85/t=1.0）
# 每个 ref 先用 whisper 转写精确 ref_text（ref 音频与文本不匹配会劣化质量）
# 用法：py -3.12 scripts/_ref-compare.py
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
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
from faster_whisper import WhisperModel

CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
ANCHOR_CACHE = os.path.join(ROOT, "data", "mashiro-anchor.npy")
TRAIN_WAVS = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_raw/mashiro2/*.wav"

RADIO = r"D:/GPT-SoVITS/radio"
REFS = [
    ("ref-clean-A（现状）", os.path.join(RADIO, "ref-clean-A.wav")),
    ("ref-clean-1", os.path.join(RADIO, "ref-clean-1.wav")),
    ("ref-clean-2", os.path.join(RADIO, "ref-clean-2.wav")),
    ("ref-clean-3", os.path.join(RADIO, "ref-clean-3.wav")),
    ("ref-mashiro-ep03", os.path.join(RADIO, "ref-mashiro-ep03.wav")),
    ("ref-mashiro-v1", os.path.join(RADIO, "ref-mashiro-v1.wav")),
]
TEST_TEXTS = [
    ("短句", "さっき、窓の外を猫が通ったの。三毛猫だったよ。ちょっとだけ、絵に描いてみた。"),
    ("中句", "それから、今日のあなたの分のお茶も、用意しておくから。帰ってきたら、一緒に飲もう。"),
    ("语气词尾句", "うん、真白はここで、ちゃんと待ってるからね。"),
]
TOP_K, TOP_P, TEMP = 20, 0.85, 1.0  # 固定最优参数
N_RUNS = 3

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

list(change_sovits_weights(sovits_path=CFG["sovits"], prompt_language="日文", text_language="日文"))
change_gpt_weights(gpt_path=CFG["gpt"])
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
import torch
from resemblyzer import VoiceEncoder
voice_anchor = load_voice_anchor()
voice_enc = VoiceEncoder(torch.device("cpu"))

report = {"refs": [], "ref_texts": {}}
for rname, rwav in REFS:
    # 每个 ref 先转写精确 ref_text
    segs, _ = m.transcribe(rwav, language="ja", beam_size=5)
    ref_text = "".join(s.text for s in segs).strip()
    report["ref_texts"][rname] = ref_text
    print(f"[ref] {rname}: ref_text={ref_text[:40]}", flush=True)
    per_text = {}
    all_scores = []
    for tname, text in TEST_TEXTS:
        scores = []
        for i in range(N_RUNS):
            try:
                result = list(get_tts_wav(
                    ref_wav_path=rwav, prompt_text=ref_text, prompt_language="日文",
                    text=text, text_language="日文", top_k=TOP_K, top_p=TOP_P, temperature=TEMP, pause_second=0.08,
                ))
                if not result:
                    continue
                s, audio = result[-1]
                cov, tail = verify_complete_v2(audio, s, text)
                sim = voice_sim_of(audio, s, voice_anchor, voice_enc)
                pace, _ = pace_score_of(audio, s, text)
                scores.append(quality_score(cov, tail, sim, pace))
            except Exception as e:
                print(f"ERR {rname} {tname} #{i}: {str(e)[:60]}")
        per_text[tname] = {"mean": round(float(np.mean(scores)), 3) if scores else None,
                           "std": round(float(np.std(scores)), 3) if scores else None}
        all_scores.extend(scores)
        print(f"  {tname}: mean={per_text[tname]['mean']} std={per_text[tname]['std']} (n={len(scores)})", flush=True)
    report["refs"].append({"name": rname, "wav": rwav,
                           "mean": round(float(np.mean(all_scores)), 3) if all_scores else None,
                           "std": round(float(np.std(all_scores)), 3) if all_scores else None,
                           "per_text": per_text})

with open(os.path.join(ROOT, "data", "ref-compare.json"), "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print("\n===== ref 对比结论（按 mean 降序）=====")
for r in sorted(report["refs"], key=lambda x: x["mean"] or 0, reverse=True):
    print(f"{r['name']}: mean={r['mean']} std={r['std']}")
