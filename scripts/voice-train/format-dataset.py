# 训练集格式化（GPT-SoVITS 一键三连：wave 32k → hubert/bert → semantic token）
# 输入：dataset_raw/<voiceName>/esd.list（prepare.py 产物）
# 输出：dataset_raw/<voiceName>/6-name2semantic.tsv（GPT 训练输入）+ 中间缓存
# 用法：py -3.12 scripts/voice-train/format-dataset.py --config scripts/voice-train/config.json
# 说明：调 GPT-SoVITS 的 prepare_datasets/*.py（与 webui 一键三连同机制，环境变量传参）
import sys, os, json, subprocess, argparse

def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--gpu", default="0")
    args = ap.parse_args()
    cfg = load_config(args.config)
    name = cfg["voiceName"]
    gs = cfg.get("gptSoVitsRoot", "D:/GPT-SoVITS/GPT-SoVITS")
    python = cfg.get("python", "python")
    opt_dir = os.path.join(gs, "dataset_raw", name)

    # 共享环境（与 webui 1a/1b/1c 一致）
    base_env = os.environ.copy()
    base_env["inp_text"] = os.path.join(opt_dir, "esd.list")
    base_env["exp_name"] = name
    base_env["opt_dir"] = opt_dir
    base_env["i_part"] = "0"
    base_env["all_parts"] = "1"
    base_env["_CUDA_VISIBLE_DEVICES"] = str(cfg.get("gpu", args.gpu))
    base_env["cnhubert_base_dir"] = os.path.join(gs, "GPT_SoVITS", "pretrained_models", "chinese-hubert-base")
    base_env["bert_path"] = os.path.join(gs, "GPT_SoVITS", "pretrained_models", "chinese-roberta-wwm-ext-large")
    base_env["ssl_pretrained_dir"] = base_env["cnhubert_base_dir"]

    cwd = gs  # prepare_datasets 脚本相对 cwd 解析
    steps = [
        ("1B hubert/wav32k", "GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py"),
        ("1C semantic token", "GPT_SoVITS/prepare_datasets/3-get-semantic.py"),
    ]
    for label, script in steps:
        print(f"== {label} ==")
        r = subprocess.run([python, "-s", script], env=base_env, cwd=cwd)
        if r.returncode != 0:
            print(f"❌ {label} 失败（exit {r.returncode}）")
            sys.exit(1)
        print(f"✅ {label} 完成")

    semantic = os.path.join(opt_dir, "6-name2semantic.tsv")
    print(f"\nDONE semantic tsv: {semantic}" if os.path.exists(semantic) else f"\n⚠ 未找到 {semantic}")
    print("下一步：python scripts/voice-train/train-gpt.py --config scripts/voice-train/config.json")

if __name__ == "__main__":
    main()
