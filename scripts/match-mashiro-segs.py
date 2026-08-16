# 在 24 集樱花庄干声中定位真白语音段：
# 用训练标注（esd.list）做文本指纹，与各集 whisper 转写匹配。
# 匹配段 = 真白语音 + 精确文本 → 可作 GPT-SoVITS 参考音频（ref + prompt_text）。
# 用法：py -3.12 scripts/match-mashiro-segs.py
import os, re, json, sys

VOCALS = r"D:/GPT-SoVITS/vocals/htdemucs"
ESD = r"D:/GPT-SoVITS/GPT-SoVITS/dataset_processed/mashiro2/esd.list"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_mashiro_matches.txt")

def norm(s):
    # 日文假名保留，去掉标点空白，英文小写
    s = s.lower()
    s = re.sub(r"[\s\u3000、。！？!?\.\,、·「」『』（）()ー—…\-\"']", "", s)
    return s

def jac(a, b):
    if len(a) < 2 or len(b) < 2:
        return 0.0
    ga = {a[i:i+2] for i in range(len(a)-1)}
    gb = {b[i:i+2] for i in range(len(b)-1)}
    u = ga | gb
    if not u:
        return 0.0
    return len(ga & gb) / len(u)

def main():
    # 训练标注文本
    labels = []
    for line in open(ESD, encoding="utf-8"):
        parts = line.strip().split("|")
        if len(parts) >= 4:
            labels.append(norm(parts[3]))
    labels = [l for l in labels if len(l) >= 4]
    print(f"labels: {len(labels)}", flush=True)

    from faster_whisper import WhisperModel
    m = WhisperModel(r"D:/GPT-SoVITS/whisper-medium", device="cuda", compute_type="int8")

    matches = []
    eps = sorted(os.listdir(VOCALS))
    for ep in eps:
        wav = os.path.join(VOCALS, ep, "vocals.wav")
        if not os.path.exists(wav):
            continue
        print(f"--- {ep} ---", flush=True)
        segs, _ = m.transcribe(wav, language="ja", vad_filter=True,
                               vad_parameters=dict(min_silence_duration_ms=300))
        for s in segs:
            d = s.end - s.start
            t = s.text.strip()
            if not (2.5 <= d <= 13.0) or not (8 <= len(t) <= 80):
                continue
            nt = norm(t)
            best, bestj = None, 0.0
            for lab in labels:
                j = jac(nt, lab)
                if j > bestj:
                    bestj, best = j, lab
            if bestj >= 0.55:
                matches.append((ep, round(s.start, 1), round(s.end, 1), round(d, 1),
                                round(bestj, 2), best, t))
                print(f"  MATCH {ep} [{s.start:.1f}-{s.end:.1f}] j={bestj:.2f} | 标注: {best}", flush=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("ep\tstart\tend\tdur\tjac\tesd_text\twhisper_text\n")
        for ep, a, b, d, j, lab, t in matches:
            f.write(f"{ep}\t{a}\t{b}\t{d}\t{j}\t{lab}\t{t}\n")
    print(f"DONE matches={len(matches)} -> {OUT}")

if __name__ == "__main__":
    main()
