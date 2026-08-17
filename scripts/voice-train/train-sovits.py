# SoVITS 训练（s2_train.py -c）：生成角色化的 s2.json → 调用训练
# 输入：dataset_raw/<voiceName>/（format-dataset.py 产物：wav32k + 文本）
# 输出：SoVITS_weights_v2/<voiceName>/G_<step>_e<epoch>_s<step>.pth（推理直接可用）+ logs/<voiceName>/
# 用法：py -3.12 scripts/voice-train/train-sovits.py --config scripts/voice-train/config.json
import sys, os, json, subprocess, argparse

def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--no-wait", action="store_true")
    args = ap.parse_args()
    cfg = load_config(args.config)
    name = cfg["voiceName"]
    gs = cfg.get("gptSoVitsRoot", "D:/GPT-SoVITS/GPT-SoVITS")
    python = cfg.get("python", "python")
    s = cfg.get("sovits", {})

    opt_dir = os.path.join(gs, "dataset_raw", name)
    if not os.path.exists(os.path.join(opt_dir, "esd.list")):
        print(f"❌ 缺训练集: {opt_dir}/esd.list（先跑 prepare.py）")
        sys.exit(1)

    exp_dir = os.path.join(gs, "logs", name)
    os.makedirs(exp_dir, exist_ok=True)
    cfg_path = os.path.join(gs, f"tmp_s2_{name}.json")
    s2config_path = os.path.join(gs, "GPT_SoVITS", "configs", "s2.json")

    # 生成 s2.json（结构对齐已验证的 tmp_s2_mashiro3.json，参数从 config.json 读）
    s2 = {
        "train": {
            "log_interval": 100, "eval_interval": 500, "seed": 1234,
            "epochs": int(s.get("epochs", 16)),
            "learning_rate": float(s.get("learningRate", 0.0001)),
            "betas": [0.8, 0.99], "eps": 1e-09,
            "batch_size": int(s.get("batchSize", 4)),
            "fp16_run": True, "lr_decay": 0.999875, "segment_size": 20480,
            "init_lr_ratio": 1, "warmup_epochs": 0,
            "c_mel": 45, "c_kl": 1, "text_low_lr_rate": 0.4, "grad_ckpt": False,
            "gpu_numbers": str(cfg.get("gpu", "0")),
            "pretrained_s2G": s.get("pretrainedS2G", os.path.join(gs, "GPT_SoVITS", "pretrained_models", "gsv-v2final-pretrained", "s2G2333k.pth")),
            "pretrained_s2D": s.get("pretrainedS2D", os.path.join(gs, "GPT_SoVITS", "pretrained_models", "gsv-v2final-pretrained", "s2D2333k.pth")),
            "save_every_epoch": int(s.get("saveEveryEpoch", 2)),
            "save_every_weights": 1, "if_save_latest": True, "if_save_every_weights": True, "keep_ckpts": 5,
        },
        "data": {
            "max_wav_value": 32768, "sampling_rate": 32000,
            "filter_length": 2048, "hop_length": 640, "win_length": 2048,
            "n_mel_channels": 128, "mel_fmin": 0, "mel_fmax": None, "add_blank": True,
            "n_speakers": 300, "cleaned_text": True, "exp_dir": exp_dir,
        },
        "model": {
            "inter_channels": 192, "hidden_channels": 192, "filter_channels": 768,
            "n_heads": 2, "n_layers": 6, "kernel_size": 3, "p_dropout": 0.1,
            "resblock": "1", "resblock_kernel_sizes": [3, 7, 11],
            "resblock_dilation_sizes": [[1, 3, 5], [1, 3, 5], [1, 3, 5]],
            "upsample_rates": [10, 8, 2, 2, 2], "upsample_initial_channel": 512,
            "upsample_kernel_sizes": [16, 16, 8, 2, 2], "n_layers_q": 3,
            "use_spectral_norm": False, "gin_channels": 512, "semantic_frame_rate": "25hz",
            "freeze_quantizer": True, "version": "v2", "name": name,
        },
        "s2_ckpt_dir": exp_dir,
        "content_module": "cnhubert",
        "name": name,
        "s2config_path": s2config_path,
        "opt_dir": opt_dir,
    }
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(s2, f, ensure_ascii=False, indent=2)
    print(f"s2.json @ {cfg_path}")

    env = os.environ.copy()
    env["_CUDA_VISIBLE_DEVICES"] = str(cfg.get("gpu", "0"))
    env["cnhubert_base_path"] = os.path.join(gs, "GPT_SoVITS", "pretrained_models", "chinese-hubert-base")
    env["bert_path"] = os.path.join(gs, "GPT_SoVITS", "pretrained_models", "chinese-roberta-wwm-ext-large")
    cmd = [python, "-s", "GPT_SoVITS/s2_train.py", "-c", cfg_path]
    print("启动 SoVITS 训练（可能数小时，--no-wait 可后台）：")
    print("  " + " ".join(cmd))
    if args.no_wait:
        subprocess.Popen(cmd, env=env, cwd=gs, shell=False)
        print("已后台启动")
    else:
        r = subprocess.run(cmd, env=env, cwd=gs)
        sys.exit(r.returncode)

if __name__ == "__main__":
    main()
