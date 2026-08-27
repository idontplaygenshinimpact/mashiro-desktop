# 实时 TTS 推理子进程（bin/tts-server.mjs 的 python 后端）
# stdin/stdout JSON 行协议（每行一个请求/响应，天然串行）：
#   请求: {"id": "uuid", "text": "≤60字"}
#   响应: {"id": ..., "ok": true, "wav": base64, "sr": 32000, "ms": 合成耗时}
#      或 {"id": ..., "ok": false, "error": "..."}
#   事件: {"event": "ready", "ms": 模型加载耗时}（加载完成后发一次）
# 配置（2026-08-26 实验最优，从 long-lines.json 跟随 ref 变更）：
#   top_k=20 / top_p=0.85 / temperature=1.0（参数网格 27 组胜出）
#   ref = ref-clean-2（ref 对比实验胜出 +27%，听感确认）
import sys, os, json, base64, time, uuid
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")

ROOT = r"D:\mianshi-agent"
SOVITS_ROOT = r"D:/GPT-SoVITS/GPT-SoVITS"
sys.path.insert(0, SOVITS_ROOT)
sys.path.insert(0, os.path.join(SOVITS_ROOT, "GPT_SoVITS"))
os.environ["cnhubert_base_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-hubert-base"
os.environ["bert_path"] = r"D:/GPT-SoVITS/GPT-SoVITS/GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
os.chdir(SOVITS_ROOT)

CFG = json.load(open(os.path.join(ROOT, "scripts", "long-lines.json"), encoding="utf-8"))
TOP_K = int(os.environ.get("MIANSHI_TTS_TOP_K", "20"))
TOP_P = float(os.environ.get("MIANSHI_TTS_TOP_P", "0.85"))
TEMP = float(os.environ.get("MIANSHI_TTS_TEMP", "1.0"))
MAX_TEXT = 60

def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def main():
    t0 = time.time()
    # import 顺序：GPT_SoVITS（torch）——本 worker 不需要 faster_whisper，无 cudnn 冲突面
    from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav
    list(change_sovits_weights(sovits_path=CFG["sovits"], prompt_language="日文", text_language="日文"))
    change_gpt_weights(gpt_path=CFG["gpt"])
    send({"event": "ready", "ms": round((time.time() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            rid = req.get("id", str(uuid.uuid4()))
            text = str(req.get("text", "")).strip()
            if not text:
                send({"id": rid, "ok": False, "error": "empty text"})
                continue
            if len(text) > MAX_TEXT:
                send({"id": rid, "ok": False, "error": f"text too long ({len(text)}>{MAX_TEXT}), 需切句"})
                continue
            t1 = time.time()
            result = list(get_tts_wav(
                ref_wav_path=CFG["ref_wav"], prompt_text=CFG["ref_text"], prompt_language="日文",
                text=text, text_language="日文",
                top_k=TOP_K, top_p=TOP_P, temperature=TEMP, pause_second=0.08,
            ))
            if not result:
                send({"id": rid, "ok": False, "error": "empty result"})
                continue
            sr, audio = result[-1]
            ms = round((time.time() - t1) * 1000)
            import io
            import soundfile as sf
            buf = io.BytesIO()
            sf.write(buf, audio, sr, format="WAV")
            wav_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            send({"id": rid, "ok": True, "wav": wav_b64, "sr": sr, "ms": ms})
        except Exception as e:
            send({"id": req.get("id", "?"), "ok": False, "error": str(e)[:200]})

if __name__ == "__main__":
    main()
