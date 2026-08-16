# 真白长句语音合成：GPT-SoVITS 真白声线（茅野愛衣）离线批量合成
# 输入：scripts/long-lines.json（场景/日语文本/中文翻译）
# 输出：assets/voice/long/{file}.wav + assets/voice/long/long.json（voice-pack 运行时读取）
# 用法：py -3.12 scripts/synth-mashiro-long.py [--only greeting] [--skip-existing]
# 环境：依赖 D:/GPT-SoVITS 训练模型 + CUDA（RTX 4060 实测约 5-15s/条）
import sys, os, json, argparse

# ---- GPT-SoVITS 环境 ----
SOVITS_ROOT = r"D:/GPT-SoVITS/GPT-SoVITS"
sys.path.insert(0, SOVITS_ROOT)
sys.path.insert(0, os.path.join(SOVITS_ROOT, "GPT_SoVITS"))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
# 预训练模型路径：默认相对路径依赖 cwd（从 D:\GPT-SoVITS\GPT-SoVITS 运行才解析成功）
# 这里显式给绝对路径，脚本可从任意目录运行
os.environ["cnhubert_base_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-hubert-base"
os.environ["bert_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
# 模型权重：inference_webui 从环境变量或 cwd 下 weight.json 读；显式指定 + chdir 到 GPT-SoVITS 根
# 注意：mashiro2 训练存档已转推理格式（G_233333333333_infer.pth，weight+config，见 D:/GPT-SoVITS/convert-sovits-infer.py）
os.environ["gpt_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_weights_v2/mashiro2/mashiro2-e8.ckpt"
os.environ["sovits_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/SoVITS_weights_v2/mashiro2/G_233333333333_infer.pth"
os.chdir(SOVITS_ROOT)  # inference_webui 会读写 ./weight.json（相对 cwd）

import soundfile as sf
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
from faster_whisper import WhisperModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # mianshi-agent 根
CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
OUT_DIR = os.path.join(ROOT, "assets", "voice", "long")
os.makedirs(OUT_DIR, exist_ok=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="只合成某场景（如 greeting）")
    ap.add_argument("--skip-existing", action="store_true", help="跳过已存在的 wav")
    args = ap.parse_args()

    print("loading trained models...")
    change_gpt_weights(gpt_path=CFG["gpt"])
    # change_sovits_weights 是生成器：必须完整迭代才会真正加载模型（hps/vq_model 全局赋值）
    # 注意：必须传 prompt_language/text_language，否则该版本 inference_webui 的 yield 引用未定义变量（bug）
    list(change_sovits_weights(sovits_path=CFG["sovits"], prompt_language="日文", text_language="日文"))
    print("models loaded")

    # 参考音频转写（真白原声片段，600s 广播精选）
    m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
    segs, _ = m.transcribe(CFG["ref_wav"], language="ja")
    ref_text = "".join(s.text for s in segs).strip() or "こんにちは"
    print("ref_text:", ref_text[:80])

    lines = CFG["lines"] + CFG.get("longs", [])
    if args.only:
        lines = [l for l in lines if l["scene"] == args.only]
    ok, fail = 0, 0
    for i, l in enumerate(lines, 1):
        out = os.path.join(OUT_DIR, l["file"])
        if args.skip_existing and os.path.exists(out):
            print(f"SKIP {l['file']}（已存在）")
            continue
        try:
            # 超长独白：文本内 \n 分段 → get_tts_wav 逐段合成再拼接；
            # 段间停顿 pause_second=0.12（默认 0.3 太生硬）
            # 采样参数：top_p=1/temperature=0.6 会让生成发散（语义 token 快速耗尽 → 句中被 max_sec 截断）
            # → 保守采样 top_p=0.8 + temperature=1.0（v2 官方推荐组合，长句更稳）
            result = list(get_tts_wav(
                ref_wav_path=CFG["ref_wav"], prompt_text=ref_text, prompt_language="日文",
                text=l["jp"], text_language="日文", top_p=0.8, temperature=1.0, pause_second=0.12,
            ))
            if result:
                sr, audio = result[-1]
                sf.write(out, audio, sr)
                secs = round(len(audio) / sr, 1)
                print(f"OK {l['file']}（{l['scene']}）{secs}s")
                ok += 1
            else:
                print(f"EMPTY {l['file']}")
                fail += 1
        except Exception as e:
            print(f"FAIL {l['file']} {str(e)[:200]}")
            fail += 1

    # 生成 long.json（voice-pack 运行时读取：scene → files + zh 翻译；同场景短句+超长独白合并）
    index = {}
    for l in CFG["lines"] + CFG.get("longs", []):
        f = l["file"]
        if not os.path.exists(os.path.join(OUT_DIR, f)):
            continue
        index.setdefault(l["scene"], {"files": [], "zh": []})
        index[l["scene"]]["files"].append(f)
        index[l["scene"]]["zh"].append(l.get("zh", ""))
    with open(os.path.join(OUT_DIR, "long.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f"ALL-DONE ok={ok} fail={fail} scenes={len(index)}")

if __name__ == "__main__":
    main()
