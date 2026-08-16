# -*- coding: utf-8 -*-
import sys, os, json, io
sys.path.insert(0, r"D:/GPT-SoVITS/GPT-SoVITS")
sys.path.insert(0, os.path.join(r"D:/GPT-SoVITS/GPT-SoVITS", "GPT_SoVITS"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
os.environ["cnhubert_base_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-hubert-base"
os.environ["bert_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
os.environ["gpt_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_weights_v2/mashiro2/mashiro2-e8.ckpt"
os.environ["sovits_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/SoVITS_weights_v2/mashiro2/G_233333333333_infer.pth"
os.chdir(r"D:/GPT-SoVITS/GPT-SoVITS")
import soundfile as sf
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
from faster_whisper import WhisperModel
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

change_gpt_weights(gpt_path=os.environ["gpt_path"])
list(change_sovits_weights(sovits_path=os.environ["sovits_path"], prompt_language="日文", text_language="日文"))
m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
segs, _ = m.transcribe(r"D:/GPT-SoVITS/radio/ref-600.wav", language="ja")
ref_text = "".join(s.text for s in segs).strip()

TEXT = "こんにちは。さっきまで猫と遊んでたの。……あなたも、一緒に遊ぶ？"  # greeting-2
for top_p, temp in [(1.0, 0.6), (0.8, 0.8), (0.8, 1.0)]:
    out = rf"D:/GPT-SoVITS/mashiro2-out/exp_{top_p}_{temp}.wav"
    try:
        result = list(get_tts_wav(ref_wav_path=r"D:/GPT-SoVITS/radio/ref-600.wav", prompt_text=ref_text,
                                  prompt_language="日文", text=TEXT, text_language="日文",
                                  top_p=top_p, temperature=temp, pause_second=0.12))
        if result:
            sr, audio = result[-1]
            sf.write(out, audio, sr)
            segs2, _ = m.transcribe(out, language="ja", beam_size=1)
            got = "".join(s.text for s in segs2).strip()
            print(f"top_p={top_p} temp={temp}: {round(len(audio)/sr,1)}s | 转写: {got}")
        else:
            print(f"top_p={top_p} temp={temp}: EMPTY")
    except Exception as e:
        print(f"top_p={top_p} temp={temp}: FAIL {str(e)[:100]}")
