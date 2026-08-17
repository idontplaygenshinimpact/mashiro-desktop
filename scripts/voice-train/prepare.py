# 语音训练数据准备（参数化）：源音频 → dataset_raw/<voiceName> + esd.list
# 支持两种源：
#   1) vocalsDir：{ep}/vocals.wav（多人声分离后的单角色轨）+ 可选 segments TSV [ep,a,b,text]（声纹筛选段）
#   2) sourceWav：单文件长音频 → whisper word timestamps 自动切段 + 转写
# 用法：py -3.12 scripts/voice-train/prepare.py --config scripts/voice-train/config.json
# （未标注段用 whisper 自动转写文本；段落 2.5-12.5s 为 GPT-SoVITS 训练标准）
import sys, os, json, csv, shutil, argparse
import numpy as np
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import soundfile as sf

def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def cut_wav(src, a, b, out, sr=32000):
    """切音频段存 32k mono wav；返回是否成功"""
    try:
        audio, s = sf.read(src, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        seg = audio[int(a * s):int(b * s)]
        if len(seg) < s * 1.0:
            return False
        sf.write(out, seg, sr)
        return True
    except Exception as e:
        print(f"  [warn] 切 {src}[{a},{b}] 失败: {str(e)[:60]}")
        return False

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--whisper-only", action="store_true", help="只跑 whisper 转写（不切音频）")
    args = ap.parse_args()
    cfg = load_config(args.config)
    name = cfg["voiceName"]
    gs = cfg.get("gptSoVitsRoot", "D:/GPT-SoVITS/GPT-SoVITS")
    work = cfg.get("workRoot", os.path.dirname(gs))
    out_dir = os.path.join(gs, "dataset_raw", name)
    os.makedirs(out_dir, exist_ok=True)
    seg_min, seg_max = cfg.get("segMinLen", 2.5), cfg.get("segMaxLen", 12.5)
    sr = cfg.get("sampleRate", 32000)

    rows = []  # (wav_name, text)
    n = 0

    # whisper 转写（复用，供未标注段）
    m = None
    def transcribe(wav_path):
        nonlocal m
        if m is None:
            from faster_whisper import WhisperModel
            m = WhisperModel(cfg.get("whisperModel"), device=cfg.get("whisperDevice", "cuda"), compute_type="int8")
        segs, info = m.transcribe(wav_path, language="ja", beam_size=5, word_timestamps=True)
        # 返回 [(start,end,text)]，按词级时间戳聚合
        items = []
        for s in segs:
            for w in (s.words or []):
                items.append((w.start, w.end, "".join(ch for ch in w.word if not ch.isspace())))
        # 合并成 <seg_max 的句子块
        blocks = []
        cur_start, cur_end, cur_text = None, None, ""
        for st, en, w in items:
            if cur_start is None:
                cur_start, cur_end, cur_text = st, en, w
            elif en - cur_start <= seg_max:
                cur_end, cur_text = en, cur_text + w
            else:
                blocks.append((cur_start, cur_end, cur_text))
                cur_start, cur_end, cur_text = st, en, w
        if cur_start is not None:
            blocks.append((cur_start, cur_end, cur_text))
        return blocks

    # 1) 人声目录 + TSV 标注
    vocals_dir = cfg.get("sourceVocalsDir", "")
    tsv = cfg.get("sourceSegmentsTsv", "")
    if vocals_dir and os.path.isdir(vocals_dir):
        tsv_data = []
        if tsv and os.path.exists(tsv):
            with open(tsv, encoding="utf-8") as f:
                for r in csv.reader(f, delimiter="\t"):
                    if len(r) >= 6:
                        try:
                            tsv_data.append((r[0], float(r[1]), float(r[2]), float(r[4]), r[5]))
                        except ValueError:
                            continue
        # TSV 标注段优先（含声纹 sim 过滤）
        sim_thresh = cfg.get("voiceSimThreshold", 0.72)
        n_tsv = 0
        for ep, a, b, sim, text in tsv_data:
            if sim < sim_thresh or not (seg_min <= (b - a) <= seg_max):
                continue
            wav = os.path.join(vocals_dir, ep, "vocals.wav")
            out = os.path.join(out_dir, f"{n+1}.wav")
            if cut_wav(wav, a, b, out, sr) and text:
                rows.append((f"{n+1}.wav", text)); n += 1; n_tsv += 1
        print(f"[vocals] TSV 标注段 {n_tsv}")
        # 未标注集：whisper 自动转写切段（可选：默认跳过，避免每集全转耗时）
        if cfg.get("autoTranscribeVocals", False):
            for ep in sorted(os.listdir(vocals_dir)):
                if os.path.exists(tsv) and any(x[0] == ep for x in tsv_data):
                    continue
                wav = os.path.join(vocals_dir, ep, "vocals.wav")
                if not os.path.exists(wav):
                    continue
                print(f"  [auto] 转写 {ep}/vocals.wav…")
                for a, b, text in transcribe(wav):
                    if seg_min <= (b - a) <= seg_max and len(text) >= 4:
                        out = os.path.join(out_dir, f"{n+1}.wav")
                        if cut_wav(wav, a, b, out, sr):
                            rows.append((f"{n+1}.wav", text)); n += 1

    # 2) 单文件长音频 → whisper 自动切段转写
    src_wav = cfg.get("sourceWav", "")
    if src_wav and os.path.exists(src_wav):
        print(f"[wav] 自动切段 {os.path.basename(src_wav)}…")
        for a, b, text in transcribe(src_wav):
            if seg_min <= (b - a) <= seg_max and len(text) >= 4:
                out = os.path.join(out_dir, f"{n+1}.wav")
                if cut_wav(src_wav, a, b, out, sr):
                    rows.append((f"{n+1}.wav", text)); n += 1

    # 3) 可选：复用旧数据集（--reuse 老角色）
    reuse = cfg.get("reuseDatasetDir", "")
    if reuse and os.path.isdir(reuse):
        old_list = os.path.join(reuse, "esd.list")
        old_text = {}
        if os.path.exists(old_list):
            for line in open(old_list, encoding="utf-8"):
                p = line.strip().split("|")
                if len(p) >= 4:
                    old_text[os.path.basename(p[0])] = p[3]
        for f in sorted(os.listdir(reuse)):
            if f.endswith(".wav") and f in old_text:
                shutil.copy2(os.path.join(reuse, f), os.path.join(out_dir, f"{n+1}.wav"))
                rows.append((f"{n+1}.wav", old_text[f])); n += 1
        print(f"[reuse] 复用 {n} 条")

    # esd.list：GPT-SoVITS 训练格式
    esd = os.path.join(out_dir, "esd.list")
    seen = set()
    with open(esd, "w", encoding="utf-8") as f:
        for fn, text in rows:
            if text in seen:
                continue
            seen.add(text)
            f.write(f"{out_dir}/{fn}|{name}|ja|{text}\n")
    print(f"DONE total={len(rows)} (去重后 {len(seen)}), esd.list @ {esd}")
    print(f"下一步：npm run voice:train:gpt -- --config scripts/voice-train/config.json")

if __name__ == "__main__":
    main()
