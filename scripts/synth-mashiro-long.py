# 真白长句语音合成：GPT-SoVITS 真白声线（茅野愛衣）离线批量合成
# 输入：scripts/long-lines.json（场景/日语文本/中文翻译）
# 输出：assets/voice/long/{file}.wav + assets/voice/long/long.json（voice-pack 运行时读取）
# 用法：py -3.12 scripts/synth-mashiro-long.py [--only greeting] [--skip-existing]
#       --gpt <ckpt>  --ref <wav> --ref-text <精确文本>（默认 mashiro2-e16 + 真白精确段）
# 环境：依赖 D:/GPT-SoVITS 训练模型 + CUDA（RTX 4060 实测约 5-15s/条）
import sys, os, json, argparse
import numpy as np
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

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
# 注意：GPT 必须全量训练（mashiro3-e20 = 1472 段声纹确认数据 20 epoch，解决长句截断）
os.environ["gpt_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_weights_v2/mashiro3/mashiro3-e20.ckpt"
os.environ["sovits_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/SoVITS_weights_v2/mashiro3/G_233333333333_infer.pth"
os.chdir(SOVITS_ROOT)  # inference_webui 会读写 ./weight.json（相对 cwd）

import soundfile as sf
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
from faster_whisper import WhisperModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # mianshi-agent 根
CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
OUT_DIR = os.path.join(ROOT, "assets", "voice", "long")
os.makedirs(OUT_DIR, exist_ok=True)

m = None  # 全局 WhisperModel（main 里初始化，verify_complete 使用）

def clean_punct(t):
    """清洗停顿标记：段落换行 → 句号（语义完整但停顿短），省略号 → 顿号（短停顿）
    GPT-SoVITS 对 \n/…… 会生成明显长停顿，导致长独白断断续续"""
    t = t.replace("\n", "。")
    t = t.replace("……", "、")
    return t

def split_chunks(text, max_len=60):
    """按句拆分：以 。！？ 断句，合并成 ≤max_len 字的子句（日语 char 计）"""
    import re
    parts = re.split(r"(?<=[。！？])", text)
    chunks = []
    cur = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if len(cur) + len(p) <= max_len:
            cur += p
        else:
            if cur:
                chunks.append(cur)
            cur = p
    if cur:
        chunks.append(cur)
    return chunks or [text]

def main():
    global m
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="只合成某场景（如 greeting）")
    ap.add_argument("--skip-existing", action="store_true", help="跳过已存在的 wav")
    ap.add_argument("--gpt", default=os.environ["gpt_path"], help="GPT ckpt 路径")
    ap.add_argument("--ref", default=r"D:/GPT-SoVITS/radio/ref-clean-A.wav", help="参考音频（声纹最优：真白干声段 sim=0.962）")
    ap.add_argument("--ref-text", default="戻ろうと思って エスカレーターに乗ったの離しちゃダメなの 離したら飛んでくわ", help="参考音频精确文本")
    args = ap.parse_args()

    print("loading trained models...")
    change_gpt_weights(gpt_path=args.gpt)
    # change_sovits_weights 是生成器：必须完整迭代才会真正加载模型（hps/vq_model 全局赋值）
    # 注意：必须传 prompt_language/text_language，否则该版本 inference_webui 的 yield 引用未定义变量（bug）
    list(change_sovits_weights(sovits_path=CFG["sovits"], prompt_language="日文", text_language="日文"))
    print("models loaded")

    # 参考音频转写（真白原声片段；优先 --ref-text 精确文本，其次 whisper 转写）
    # 注意：SoVITS 必须传训练权重对应 infer（mashiro3 全量 1472 段 16 epoch 训练，音质优于旧 mashiro2）
    m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
    if args.ref_text:
        ref_text = args.ref_text
    else:
        segs, _ = m.transcribe(args.ref, language="ja")
        ref_text = "".join(s.text for s in segs).strip() or "こんにちは"
    print("ref_text:", ref_text[:80])

    lines = CFG["lines"] + CFG.get("longs", [])
    if args.only:
        lines = [l for l in lines if l["scene"] == args.only]
    ok, fail, retried = 0, 0, 0
    for i, l in enumerate(lines, 1):
        out = os.path.join(OUT_DIR, l["file"])
        if args.skip_existing and os.path.exists(out):
            print(f"SKIP {l['file']}（已存在）")
            continue
        # 拆句拼接：长文本按句拆成 ≤60 字的子句（短句生成成功率高），
        # 每子句独立合成（多采样取 best）→ 拼接（子句间 0.15s 静音，停顿可控、不吞句）
        text = clean_punct(l["jp"])
        chunks = split_chunks(text, 60)
        merged = None
        sr = 32000
        all_good = True
        for ci, chunk in enumerate(chunks):
            best = None  # (score, secs, audio)
            for attempt in range(1, 6):
                pp = [1.0, 0.95, 1.0, 0.9, 1.0][attempt - 1]
                tt = [1.0, 0.9, 1.1, 1.0, 1.2][attempt - 1]
                try:
                    result = list(get_tts_wav(
                        ref_wav_path=args.ref, prompt_text=ref_text, prompt_language="日文",
                        text=chunk, text_language="日文", top_k=20, top_p=pp, temperature=tt, pause_second=0.08,
                    ))
                    if not result:
                        continue
                    s, audio = result[-1]
                    secs = round(len(audio) / s, 1)
                    score = verify_complete(audio, s, chunk) if m else 1.0
                    if not best or score > best[0]:
                        best = (score, secs, audio, s)
                    if score >= 0.5:
                        break
                    retried += 1
                except Exception as e:
                    print(f"FAIL {l['file']}[{ci}] 第{attempt}次 {str(e)[:150]}")
                    break
            if not best:
                print(f"FAIL {l['file']}[{ci}] 子句全部失败")
                all_good = False
                break
            score, secs, audio, s = best
            sr = s
            if score < 0.5:
                all_good = False
            # 拼接：子句间插 0.15s 静音（比 GPT 的 \n 停顿短且可控）
            gap = np.zeros(int(s * 0.15), dtype=audio.dtype)
            merged = audio if merged is None else np.concatenate([merged, gap, audio])
        if merged is not None:
            secs_total = round(len(merged) / sr, 1)
            score_total = verify_complete(merged, sr, text) if m else 1.0
            sf.write(out, merged, sr)
            flag = "" if all_good else f" ⚠️部分子句不完整（总完整度{round(score_total * 100)}%）"
            print(f"OK {l['file']}（{l['scene']}）{secs_total}s{flag}（{len(chunks)} 段拼接）")
            ok += 1
        else:
            print(f"FAIL {l['file']}（全部重试失败）")
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
    print(f"ALL-DONE ok={ok} fail={fail} retried={retried} scenes={len(index)}")

def verify_complete(audio, sr, expected_text):
    """whisper 转写合成结果，与期望文本算 2-gram 覆盖率（0-1，对转写错字鲁棒）；转写失败返回 0"""
    try:
        import io
        import soundfile as sf2
        buf = io.BytesIO()
        sf2.write(buf, audio, sr, format="WAV")
        buf.seek(0)
        segs, _ = m.transcribe(buf, language="ja", beam_size=1)
        got = "".join(s.text for s in segs).strip()
        clean = lambda s: "".join(ch for ch in s if ch.isalnum() and not ch.isascii() or (ch.isascii() and ch.isalnum()))
        exp = clean(expected_text)
        g = clean(got)
        if len(exp) < 2:
            return 0.0
        eg = {exp[i:i+2] for i in range(len(exp)-1)}
        gg = {g[i:i+2] for i in range(len(g)-1)} if len(g) >= 2 else set()
        if not eg:
            return 0.0
        return len(eg & gg) / len(eg)
    except Exception as e:
        print(f"  [verify] 转写失败: {str(e)[:80]}")
        return 0.0

if __name__ == "__main__":
    main()
