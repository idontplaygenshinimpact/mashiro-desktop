# 精准补尾 v2：只补 idle-long-1 缺失的最后一句，主体一个字节不动
# 流程：转写定位截断点 → 合成缺失句（四维选优内联实现 + 音色校验）→ 拼接
# 失败自动回退（不覆盖原文件）
# 用法：py -3.12 scripts/_tail-fix.py
import sys, os, json, io, subprocess
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
# 注意 import 顺序：GPT_SoVITS（torch/cuDNN）必须先于 faster_whisper（ctranslate2）——
# 反序会触发 "Could not load symbol cudnnGetLibConfig"（两个 cuDNN 初始化顺序冲突，实测 127）
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
from faster_whisper import WhisperModel

CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
WAV = os.path.join(ROOT, "assets", "voice", "long", "idle-long-1.wav")
OUT_TMP = os.path.join(ROOT, "assets", "voice", "long", ".tail-fix.tmp.wav")
MISSING = "うん、真白はここで、ちゃんと待ってるからね。"

# ---------- 四维选优（与 synth-mashiro-long.py 同款，内联避免 import 时序问题） ----------
ANCHOR_CACHE = os.path.join(ROOT, "data", "mashiro-anchor.npy")
TRAIN_WAVS = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_raw/mashiro2/*.wav"
import glob

def clean_text(s):
    return "".join(ch for ch in s if ch.isalnum() and not ch.isascii() or (ch.isascii() and ch.isalnum()))

def verify_complete_v2(audio, sr, expected_text):
    """whisper 转写 → (整块 2-gram 覆盖, 尾部覆盖)"""
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
    except Exception as e:
        print(f"  [verify] 转写失败: {str(e)[:80]}")
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

# ---------- 1) 模型加载（与 synth 完全同序） ----------
list(change_sovits_weights(sovits_path=CFG["sovits"], prompt_language="日文", text_language="日文"))
change_gpt_weights(gpt_path=CFG["gpt"])
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
import torch
from resemblyzer import VoiceEncoder
voice_anchor = load_voice_anchor()
voice_enc = VoiceEncoder(torch.device("cpu"))

# ---------- 2) 转写原版定位截断点（取最后一个语音段的起点——替换残缺尾句） ----------
segs, _ = m.transcribe(WAV, language="ja", beam_size=5)
seg_list = list(segs)
for s in seg_list[-3:]:
    print(f"  段 {s.start:.1f}-{s.end:.1f}s: {s.text[:40]}")
cut = seg_list[-1].start if seg_list else 0.0
print(f"截断点: {cut:.2f}s（最后语音段起点，替换其后的残缺内容）")

# ---------- 3) 合成缺失句（四维选优） ----------
best = None
for attempt in range(1, 49):  # 最多 48 次采样（模型随机性大，实测一轮 12 次可能全军覆没）
    pp = [1.0, 0.95, 1.0, 0.9, 1.0, 0.85, 0.8, 1.0, 0.95, 1.0, 0.9, 0.85][(attempt - 1) % 12]
    tt = [1.0, 0.9, 1.1, 1.0, 1.2, 0.95, 0.85, 0.8, 1.0, 1.1, 0.9, 0.8][(attempt - 1) % 12]
    try:
        result = list(get_tts_wav(
            ref_wav_path=CFG["ref_wav"], prompt_text=CFG["ref_text"], prompt_language="日文",
            text=MISSING, text_language="日文", top_k=20, top_p=pp, temperature=tt, pause_second=0.08,
        ))
        if not result:
            continue
        s, audio = result[-1]
        cov, tail = verify_complete_v2(audio, s, MISSING)
        sim = voice_sim_of(audio, s, voice_anchor, voice_enc)
        pace, pacing_ms = pace_score_of(audio, s, MISSING)
        score = quality_score(cov, tail, sim, pace)
        print(f"  #{attempt}: cov={cov*100:.0f}% tail={tail*100:.0f}% sim={round(sim,3) if sim else None} pace={pacing_ms} → {score:.3f}")
        if not best or score > best[0]:
            best = (score, cov, tail, sim, audio, s)
        if cov >= 0.55 and (sim is None or sim >= 0.88) and tail >= 0.5:
            break
    except Exception as e:
        print(f"  #{attempt} 失败: {str(e)[:100]}")
if not best:
    print("FAIL 补尾句全部采样失败，保留原文件")
    sys.exit(1)
score, cov, tail, sim, new_audio, new_sr = best
if tail < 0.5 or (sim is not None and sim < 0.85):
    print(f"FAIL 补尾质量不达标（tail={tail*100:.0f}% sim={sim}），保留原文件")
    sys.exit(1)
print(f"OK 补尾选中: cov={cov*100:.0f}% tail={tail*100:.0f}% sim={sim}")

# ---------- 4) 拼接（修复衔接：新句过 loudnorm 对齐主体响度 + acrossfade 交叉淡入） ----------
FFMPEG = r"D:\hfut\file\Videopro\exp01\exp01_ffmpeg\ffmpeg\ffmpeg\bin\ffmpeg.exe"
orig_sr = sf.info(WAV).samplerate
part_wav = os.path.join(ROOT, "data", "_tail-part.wav")
new_wav = os.path.join(ROOT, "data", "_tail-new.wav")
# 4.1 主体：原版 0~cut（已是 loudnorm 产物，原样截取）
subprocess.run([FFMPEG, "-y", "-v", "error", "-i", WAV, "-t", f"{cut:.3f}", part_wav], check=True)
# 4.2 新句：loudnorm 对齐响度（与原版同参）+ 0.15s 淡入 + 重采样到原版采样率
sf.write(new_wav, new_audio, new_sr, format="WAV")
tmp2 = os.path.join(ROOT, "data", "_tail-new2.wav")
if new_sr != orig_sr:
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", new_wav, "-ar", str(orig_sr), tmp2], check=True)
    os.replace(tmp2, new_wav)
subprocess.run([FFMPEG, "-y", "-v", "error", "-i", new_wav,
                "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.15", tmp2], check=True)
os.replace(tmp2, new_wav)
# 4.3 acrossfade 交叉淡入拼接（0.2s 重叠，替代硬切+静音，衔接自然）
subprocess.run([FFMPEG, "-y", "-v", "error", "-i", part_wav, "-i", new_wav,
                "-filter_complex", "[0][1]acrossfade=d=0.2:c1=tri:c2=tri", OUT_TMP], check=True)
for t in (part_wav, new_wav):
    try:
        os.unlink(t)
    except Exception:
        pass
print(f"拼接完成: {OUT_TMP}（主体 {cut:.1f}s + acrossfade 0.2s + 新句，响度已对齐 -16 LUFS）")
print("NEXT: 人工试听后替换 idle-long-1.wav")
