# 实验：GPT 训练不足是否导致截断？
# 对照：底模 GPT(60e) + mashiro2 SoVITS  vs  mashiro2 GPT(8e) + mashiro2 SoVITS
# 同一文本 greeting-2，同一 ref。
import sys, os, io
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

BASE_GPT = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
M2_GPT = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_weights_v2/mashiro2/mashiro2-e8.ckpt"
SOVITS = r"D:/GPT-SoVITS/GPT-SoVITS/SoVITS_weights_v2/mashiro2/G_233333333333_infer.pth"
REF = r"D:/GPT-SoVITS/radio/ref-600.wav"
REF_TEXT = "空とに黙ってきたから戻ろうと思ってエスカレーターに乗ったの話しちゃダメなの"
TEXT = "こんにちは、さっきまで猫と遊んでたの。あなたも一緒に遊ぶ？"

m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
list(change_sovits_weights(sovits_path=SOVITS, prompt_language="日文", text_language="日文"))

def clean(s):
    return "".join(ch for ch in s if ch.isalnum() and not ch.isascii() or (ch.isascii() and ch.isalnum()))

def synth(gpt, label):
    print(f"===== {label} =====", flush=True)
    change_gpt_weights(gpt_path=gpt)
    result = list(get_tts_wav(
        ref_wav_path=REF, prompt_text=REF_TEXT, prompt_language="日文",
        text=TEXT, text_language="日文", top_k=20, top_p=1, temperature=1, pause_second=0.12,
    ))
    sr, audio = result[-1]
    secs = round(len(audio) / sr, 1)
    out = rf"D:\mianshi-agent\scripts\_exp_{label}.wav"
    sf.write(out, audio, sr)
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV")
    buf.seek(0)
    segs, _ = m.transcribe(buf, language="ja", beam_size=1)
    got = "".join(s.text for s in segs).strip()
    exp, g = clean(TEXT), clean(got)
    matched = 0
    idx = 0
    for ch in exp:
        j = g.find(ch, idx)
        if j >= 0:
            matched += 1
            idx = j + 1
    print(f"{label}: {secs}s 完整度 {matched/len(exp)*100:.0f}%  转写: {got}", flush=True)

synth(BASE_GPT, "base-gpt")
synth(M2_GPT, "m2-gpt")
print("DONE")
