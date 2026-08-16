# 合成语音质量评测：内容完整度 + 音色相似度 + 节奏 + ref 污染 → 综合评分
# 用法：py -3.12 scripts/score-voices.py [--dir assets/voice/long] [--compare]
# 输出：终端报告 + data/voice-score-last.json（历史对比用）
# 指标权重：完整度 0.4 / 音色 0.3 / 节奏 0.2 / 污染 -0.15 每次
import os, sys, json, glob, argparse, time
import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = r"D:/mianshi-agent"
ANCHOR_CACHE = os.path.join(ROOT, "data", "mashiro-anchor.npy")
TRAIN_WAVS = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_raw/mashiro2/*.wav"
CFG_PATH = os.path.join(ROOT, "scripts", "long-lines.json")
OUT_JSON = os.path.join(ROOT, "data", "voice-score-last.json")

# ref 泄漏特征短语（与合成 ref 对应；换 ref 时同步更新）
POLLUTE = ["話しちゃダメ", "声をかけて", "空とに黙って", "エスカレーター", "離しちゃダメ", "飛んでく", "戻ろうと思って"]

def clean(s):
    return "".join(ch for ch in s if (ch.isascii() and ch.isalnum()) or (not ch.isascii() and ch.isalnum()))

def grams(s):
    return {s[i:i+2] for i in range(len(s)-1)}

def get_anchor():
    """真白声纹锚点（缓存到 data/，首次从训练切片现算；CPU 推理避开 ctranslate2/torch cuDNN 冲突）"""
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

def voice_sim(path, anchor, enc):
    try:
        from resemblyzer import preprocess_wav
        e = enc.embed_utterance(preprocess_wav(path))
        e = e / np.linalg.norm(e)
        return float(e @ anchor)
    except Exception:
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(ROOT, "assets", "voice", "long"))
    ap.add_argument("--compare", action="store_true", help="与上次评分对比")
    args = ap.parse_args()

    CFG = json.load(open(CFG_PATH, encoding="utf-8"))
    lines = {l["file"]: l["jp"] for l in CFG["lines"] + CFG.get("longs", [])}
    files = sorted(glob.glob(os.path.join(args.dir, "*.wav")))

    from faster_whisper import WhisperModel
    m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")
    anchor = get_anchor()
    import torch
    from resemblyzer import VoiceEncoder
    enc = VoiceEncoder(torch.device("cpu"))  # CPU：避免 ctranslate2 与 torch cuDNN dll 冲突

    rows = []
    for p in files:
        name = os.path.basename(p)
        exp = lines.get(name, "")
        segs, _ = m.transcribe(p, language="ja", beam_size=1)
        got = "".join(s.text for s in segs).strip()

        # 1) 内容完整度：2-gram 覆盖率
        exp_g, got_g = grams(clean(exp)), grams(clean(got))
        cov = len(exp_g & got_g) / len(exp_g) if exp_g and exp_g else 0.0

        # 2) 音色相似度
        sim = voice_sim(p, anchor, enc)

        # 3) 节奏：ms/字（110-170 自然；过长=停顿多，过短=语速飞）
        import soundfile as sf
        info = sf.info(p)
        secs = info.frames / info.samplerate
        nchar = len(clean(exp))
        pacing = secs / max(nchar, 1) * 1000 if nchar else None

        # 4) ref 污染
        pol = [k for k in POLLUTE if k in got]
        pol_score = -0.15 * len(pol)

        # 综合分（cov 满分线 0.8：内容完整度是首要指标，从严）
        cov_s = min(cov / 0.8, 1.0)  # cov>=0.8 满分
        sim_s = min(max((sim - 0.7) / 0.2, 0), 1.0) if sim else 0  # 0.7→0分, 0.9→满分
        pace_s = 1.0 if pacing and 110 <= pacing <= 170 else (0.7 if pacing and 90 <= pacing <= 200 else 0.3)
        total = max(0.0, min(1.0, cov_s * 0.4 + sim_s * 0.3 + pace_s * 0.2 + 0.1 * (sim is not None) + pol_score))
        grade = "A" if total >= 0.8 else "B" if total >= 0.65 else "C" if total >= 0.5 else "D"

        rows.append({
            "file": name, "cov": round(cov, 3), "voice_sim": round(sim, 3) if sim else None,
            "pacing_ms": round(pacing, 1) if pacing else None, "pollution": pol,
            "secs": round(secs, 1), "score": round(total, 3), "grade": grade,
        })

    # 报告
    print(f"{'file':26s} {'cov':>5s} {'sim':>5s} {'ms/字':>6s} {'secs':>5s} {'pol':>8s} {'grade':>5s} {'score':>5s}")
    for r in sorted(rows, key=lambda x: x["score"]):
        print(f"{r['file']:26s} {r['cov']*100:4.0f}% {str(r['voice_sim'])[:5]:>5s} {str(r['pacing_ms'])[:5]:>6s} {r['secs']:5.1f} {','.join(r['pollution']) or '-':>8s} {r['grade']:>5s} {r['score']:.2f}")

    import statistics
    scores = [r["score"] for r in rows]
    covs = [r["cov"] for r in rows]
    sims = [r["voice_sim"] for r in rows if r["voice_sim"]]
    grades = {g: sum(1 for r in rows if r["grade"] == g) for g in "ABCD"}
    print(f"\n汇总: {len(rows)} 条 | 平均分 {statistics.mean(scores):.2f} | cov {statistics.mean(covs)*100:.0f}% | 声纹 {statistics.mean(sims):.3f} | 等级 {grades}")

    # 与上次对比
    prev = None
    if args.compare and os.path.exists(OUT_JSON):
        try:
            prev = json.load(open(OUT_JSON, encoding="utf-8"))
            prev_avg = statistics.mean([r["score"] for r in prev["rows"]])
            print(f"对比上次({prev['ts']}): 平均分 {prev_avg:.2f} → {statistics.mean(scores):.2f} "
                  f"({statistics.mean(scores) - prev_avg:+.2f})")
        except Exception:
            pass

    json.dump({"ts": time.strftime("%Y-%m-%d %H:%M"), "rows": rows,
               "avg": round(statistics.mean(scores), 3), "grades": grades},
              open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"报告已存: {OUT_JSON}")

if __name__ == "__main__":
    main()
