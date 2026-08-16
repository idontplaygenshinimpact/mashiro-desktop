# 组装 mashiro3 全量训练集：
# 1) 24 集声纹确认真白段（_voiceid_mashiro.tsv，sim>=0.72）切 32k mono wav
# 2) 1h 广播 >=4s 段（_1h_segs.txt）切出
# 3) mashiro-radio 转写段（_radio_segs.txt）切出（等转写完成后运行）
# 4) 981 段旧短句直接复用（dataset_raw/mashiro2）
# 输出：dataset_raw/mashiro3/*.wav + esd.list
# 用法：py -3.12 scripts/build-dataset-mashiro3.py
import os, sys, csv
import soundfile as sf
import numpy as np

SRC = r"D:/GPT-SoVITS/vocals/htdemucs"
OUT_DIR = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_raw/mashiro3"
OLD_DIR = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_raw/mashiro2"
VOICEID = r"D:\mianshi-agent\scripts\_voiceid_mashiro.tsv"
H1 = r"D:\mianshi-agent\scripts\_1h_segs.txt"
RADIO = r"D:\mianshi-agent\scripts\_radio_segs.txt"
SIM_THRESH = 0.72
os.makedirs(OUT_DIR, exist_ok=True)

_audio_cache = {}
def cut(src_wav, a, b, out_wav, sr=32000):
    if src_wav not in _audio_cache:
        audio, s = sf.read(src_wav, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        _audio_cache[src_wav] = (audio, s)
    audio, s = _audio_cache[src_wav]
    seg = audio[int(a * s):int(b * s)]
    if len(seg) < s * 1.0:
        return False
    sf.write(out_wav, seg, sr)
    return True

rows = []  # (file, text)
n = 0
seen_ts = set()  # 跨集去重：同一 (round start, round end) 只保留一次（OP/ED 等固定重复镜头）
def emit(text, a=0, b=0, key=None):
    global n
    k = key if key is not None else (round(a, 1), round(b, 1))
    if k in seen_ts:
        return
    seen_ts.add(k)
    n += 1
    rows.append((f"{n}.wav", text))

# 1) 24 集声纹段
if os.path.exists(VOICEID):
    with open(VOICEID, encoding="utf-8") as f:
        rd = csv.reader(f, delimiter="\t")
        next(rd, None)
        for r in rd:
            if len(r) < 6:
                continue
            ep, a, b, dur, sim, text = r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), r[5]
            if sim < SIM_THRESH or not (2.5 <= dur <= 12.5):
                continue
            wav = os.path.join(SRC, ep, "vocals.wav")
            out = os.path.join(OUT_DIR, f"{n+1}.wav")
            if cut(wav, a, b, out):
                emit(text, a, b)
    print(f"[voiceid] emitted so far {n}")

# 2) 1h 广播段（>=4s）
H1_WAV = r"D:/GPT-SoVITS/radio/mashiro-1h.wav"
if os.path.exists(H1):
    for line in open(H1, encoding="utf-8"):
        p = line.strip().split("\t")
        if len(p) < 3:
            continue
        a, b, text = float(p[0]), float(p[1]), p[2].strip()
        if 4.0 <= b - a <= 12.5:
            out = os.path.join(OUT_DIR, f"{n+1}.wav")
            if cut(H1_WAV, a, b, out):
                emit(text, a, b)
    print(f"[1h] emitted so far {n}")

# 3) mashiro-radio 段（如已转写）
if os.path.exists(RADIO):
    R_WAV = r"D:/GPT-SoVITS/radio/mashiro-radio.wav"
    for line in open(RADIO, encoding="utf-8"):
        p = line.strip().split("\t")
        if len(p) < 3:
            continue
        a, b, text = float(p[0]), float(p[1]), p[2].strip()
        if 2.5 <= b - a <= 12.5:
            out = os.path.join(OUT_DIR, f"{n+1}.wav")
            if cut(R_WAV, a, b, out):
                emit(text, a, b)
    print(f"[radio] emitted so far {n}")

# 4) 981 旧短句复用（复制 wav + esd.list 文本）
old_list = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_processed/mashiro2/esd.list"
old_text = {}
if os.path.exists(old_list):
    for line in open(old_list, encoding="utf-8"):
        p = line.strip().split("|")
        if len(p) >= 4:
            old_text[os.path.basename(p[0])] = p[3]
import shutil
for f in sorted(os.listdir(OLD_DIR)):
    if f.endswith(".wav") and f in old_text:
        shutil.copy2(os.path.join(OLD_DIR, f), os.path.join(OUT_DIR, f"{n+1}.wav"))
        emit(old_text[f], key=f"old-{f}")
print(f"[old981] total {n}")

# esd.list
with open(os.path.join(OUT_DIR, "esd.list"), "w", encoding="utf-8") as f:
    for fn, text in rows:
        f.write(f"{OUT_DIR}/{fn}|mashiro3|ja|{text}\n")
print(f"DONE total={len(rows)} esd.list written")
