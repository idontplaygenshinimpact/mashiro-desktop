# GPT 训练（s1_train.py）：生成角色化的 s1.yaml → 调用训练
# 输入：dataset_raw/<voiceName>/6-name2semantic.tsv（format-dataset.py 产物）
# 输出：GPT_weights_v2/<voiceName>/<voiceName>-e<epoch>.ckpt
# 用法：py -3.12 scripts/voice-train/train-gpt.py --config scripts/voice-train/config.json
import sys, os, json, subprocess, argparse, time

def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--exp-dir", default="", help="覆盖 exp 目录（weight 落点）")
    ap.add_argument("--no-wait", action="store_true", help="后台启动不等待（训练可能数小时）")
    args = ap.parse_args()
    cfg = load_config(args.config)
    name = cfg["voiceName"]
    gs = cfg.get("gptSoVitsRoot", "D:/GPT-SoVITS/GPT-SoVITS")
    python = cfg.get("python", "python")
    g = cfg.get("gpt", {})
    opt_dir = os.path.join(gs, "dataset_raw", name)
    semantic = os.path.join(opt_dir, "6-name2semantic.tsv")
    if not os.path.exists(semantic):
        print(f"❌ 缺 semantic tsv: {semantic}（先跑 format-dataset.py）")
        sys.exit(1)

    # 生成 s1.yaml（参考 s1.yaml + webui 注入的顶层 key：semantic/phoneme/output/pretrained）
    exp_dir = args.exp_dir or os.path.join(gs, "logs", name)
    os.makedirs(exp_dir, exist_ok=True)
    yaml_path = os.path.join(gs, f"tmp_s1_{name}.yaml")
    epochs = int(g.get("epochs", 20))
    # 学习率：config 的 gpt.learningRate 生效（映射到 s1.yaml optimizer；此前硬编码 0.01 被忽略）
    lr = float(g.get("learningRate", 0.0001))
    lr_init = float(g.get("lrInit", lr / 10))
    lr_end = float(g.get("lrEnd", lr))
    pretrained = g.get("pretrained", "") or os.path.join(
        gs, "GPT_SoVITS", "pretrained_models", "gsv-v2final-pretrained", "s1bert25hz-5kh-longer-epoch=12-step=369k.ckpt")
    train_semantic_path = os.path.join(opt_dir, "6-name2semantic.tsv")
    train_phoneme_path = os.path.join(opt_dir, "2-name2text.txt")
    yaml = f"""train_semantic_path: {train_semantic_path}
train_phoneme_path: {train_phoneme_path}
output_dir: {exp_dir}
pretrained: {pretrained}
train:
  seed: 1234
  epochs: {epochs}
  batch_size: {int(g.get('batchSize', 8))}
  gradient_accumulation: 4
  save_every_n_epoch: {int(g.get('saveEveryEpoch', 2))}
  precision: 16
  gradient_clip: 1.0
  if_save_latest: true
  if_save_every_weights: true
  half_weights_save_dir: {os.path.join(gs, 'GPT_weights_v2', name)}
  exp_name: {name}
optimizer:
  lr: {lr}
  lr_init: {lr_init}
  lr_end: {lr_end}
  warmup_steps: 2000
  decay_steps: 40000
data:
  max_eval_sample: 8
  max_sec: 54
  num_workers: 1
  pad_val: 1024
model:
  vocab_size: 1025
  phoneme_vocab_size: 512
  embedding_dim: 512
  hidden_dim: 512
  head: 16
  linear_units: 2048
  n_layer: 12
  dropout: 0
  EOS: 1024
inference:
  top_k: 5
"""
    with open(yaml_path, "w", encoding="utf-8") as f:
        f.write(yaml)
    print(f"s1.yaml @ {yaml_path}")

    env = os.environ.copy()
    env["_CUDA_VISIBLE_DEVICES"] = str(cfg.get("gpu", "0"))
    cmd = [python, "-s", "GPT_SoVITS/s1_train.py", "--config_file", yaml_path]
    print("启动 GPT 训练（可能数小时，--no-wait 可后台）：")
    print("  " + " ".join(cmd))
    if args.no_wait:
        subprocess.Popen(cmd, env=env, cwd=gs, shell=False)
        print("已后台启动")
    else:
        r = subprocess.run(cmd, env=env, cwd=gs)
        sys.exit(r.returncode)

if __name__ == "__main__":
    main()
