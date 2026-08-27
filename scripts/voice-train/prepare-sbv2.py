# SBV2 训练数据准备：mashiro3 esd.list → Style-Bert-VITS2 Data/mashiro3
# 1) wav 重采样到 44.1kHz 单声道（SBV2 期望；源是 32k/44.1k 混合）
# 2) esd.list 路径指向新目录（格式 utt|spk|ja|text 与 SBV2 兼容，直接复用转写）
# 用法：py -3.12 scripts/voice-train/prepare-sbv2.py
import os, sys, subprocess

ROOT = r"D:\mianshi-agent"
SRC_DIR = r"D:\GPT-SoVITS\GPT-SoVITS\dataset_raw\mashiro3"
SRC_ESD = os.path.join(SRC_DIR, "esd.list")
DST = r"D:\Style-Bert-VITS2\Data\mashiro3"
WAVS = os.path.join(DST, "wavs")
FFMPEG = r"D:\hfut\file\Videopro\exp01\exp01_ffmpeg\ffmpeg\ffmpeg\bin\ffmpeg.exe"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

os.makedirs(WAVS, exist_ok=True)
lines = [l for l in open(SRC_ESD, encoding="utf-8").read().strip().splitlines() if l.strip()]
out = []
skip = 0
for i, line in enumerate(lines, 1):
    parts = line.split("|")
    if len(parts) != 4:
        print(f"SKIP 格式: {line[:60]}")
        skip += 1
        continue
    src, spk, lang, text = parts
    name = os.path.basename(src)
    dst_wav = os.path.join(WAVS, name)
    if not os.path.exists(dst_wav):
        try:
            subprocess.run(
                [FFMPEG, "-y", "-v", "error", "-i", src, "-ar", "44100", "-ac", "1", dst_wav],
                check=True, capture_output=True,
            )
        except Exception as e:
            print(f"FAIL {name}: {str(e)[:80]}")
            skip += 1
            continue
    out.append(f"{dst_wav}|{spk}|{lang}|{text}")
    if i % 300 == 0:
        print(f"{i}/{len(lines)}")

with open(os.path.join(DST, "esd.list"), "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
print(f"DONE: {len(out)} 条 → {DST}/esd.list（跳过 {skip}）")
