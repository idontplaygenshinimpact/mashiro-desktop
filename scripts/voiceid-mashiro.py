# 声纹定位：用 981 段训练切片的平均声纹做真白锚点，
# 在 24 集原剧干声的所有语音段上做说话人比对，输出真白段清单（含时间戳+转写文本）。
# 用法：py -3.12 scripts/voiceid-mashiro.py
import os, glob, json, sys
import numpy as np

VOCALS = r"D:/GPT-SoVITS/vocals/htdemucs"
EMBS = r"D:\mianshi-agent\scripts\_m2_embs.npy"
OUT = r"D:\mianshi-agent\scripts\_voiceid_mashiro.tsv"
THRESH = 0.72  # resemblyzer 同人余弦阈值（先粗筛，看分布）

from resemblyzer import VoiceEncoder, preprocess_wav
import soundfile as sf

def main():
    enc = VoiceEncoder()
    anchor = np.mean(np.load(EMBS), axis=0)
    anchor = anchor / np.linalg.norm(anchor)
    print("anchor ready", flush=True)

    from faster_whisper import WhisperModel
    m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")

    rows = []
    sims = []
    eps = sorted(os.listdir(VOCALS))
    for ep in eps:
        wav = os.path.join(VOCALS, ep, "vocals.wav")
        if not os.path.exists(wav):
            continue
        print(f"--- {ep} ---", flush=True)
        audio, sr = sf.read(wav, dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        segs, _ = m.transcribe(wav, language="ja", vad_filter=True,
                               vad_parameters=dict(min_silence_duration_ms=300))
        for s in segs:
            d = s.end - s.start
            if not (1.5 <= d <= 14.0):
                continue
            t = s.text.strip()
            if len(t) < 4:
                continue
            seg = audio[int(s.start * sr):int(s.end * sr)]
            w = preprocess_wav(seg, sr)
            e = enc.embed_utterance(w)
            e = e / np.linalg.norm(e)
            sim = float(e @ anchor)
            sims.append(sim)
            if sim >= THRESH:
                rows.append((ep, round(s.start, 2), round(s.end, 2), round(d, 2),
                             round(sim, 3), t))
                print(f"  VOICEID {ep} [{s.start:.1f}-{s.end:.1f}] sim={sim:.2f} {t[:40]}", flush=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("ep\tstart\tend\tdur\tsim\ttext\n")
        for r in rows:
            f.write("\t".join(str(x) for x in r) + "\n")
    sims = np.array(sims)
    print(f"DONE matched={len(rows)} total_segs={len(sims)}")
    print(f"sim dist: p10={np.percentile(sims,10):.2f} p25={np.percentile(sims,25):.2f} "
          f"med={np.median(sims):.2f} p75={np.percentile(sims,75):.2f} p90={np.percentile(sims,90):.2f}")

if __name__ == "__main__":
    main()
