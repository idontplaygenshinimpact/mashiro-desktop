# SBV2 风格向量生成（resemblyzer 替代 pyannote/wespeaker——同为 256 维说话人嵌入，
# data_utils 只 np.load 不校验来源；绕开 torchvision DLL 坑）
# 用法：py -3.12 scripts/voice-train/gen-style-vec.py
import os, sys, glob
import numpy as np
import torch

WAV_DIR = r"D:\Style-Bert-VITS2\Data\mashiro3\wavs"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from resemblyzer import VoiceEncoder, preprocess_wav

enc = VoiceEncoder(torch.device("cpu"))
wavs = sorted(glob.glob(os.path.join(WAV_DIR, "*.wav")))
done = 0
for i, w in enumerate(wavs, 1):
    npy = w + ".npy"
    if os.path.exists(npy):
        done += 1
        continue
    try:
        e = enc.embed_utterance(preprocess_wav(w))
        np.save(npy, e)
        done += 1
    except Exception as ex:
        print(f"FAIL {os.path.basename(w)}: {str(ex)[:60]}")
    if i % 300 == 0:
        print(f"{i}/{len(wavs)}")
print(f"DONE: {done}/{len(wavs)} 个风格向量（resemblyzer 256 维）")
