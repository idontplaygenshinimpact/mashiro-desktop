# 真白语音训练流程（内置版）

把"原始音频 → GPT/SoVITS 训练 → 推理权重 → 项目语音包 → 质量评测"全程固化在项目里，
换角色/换音源/微调都能用。训练核心调用 `D:/GPT-SoVITS` 的官方脚本（与 webui 同机制），
本项目负责：数据准备、训练配置生成、一键编排、合成与评测闭合。

## 前置

- `D:/GPT-SoVITS/GPT-SoVITS` 已安装并有预训练权重（s1bert/s2G2333k/s2D2333k、cnhubert、roberta）
- Python 环境有 faster_whisper + torch + GPT-SoVITS 依赖（训练/数据/评测用）
- 原始音频：多人声分离后的单角色轨（`vocals/htdemucs/{ep}/vocals.wav` 格式）或单文件长音频

## 快速开始

```bash
# 1) 配置（复制模板并改造）
cp scripts/voice-train/config.example.json scripts/voice-train/config.json
# 编辑 config.json：voiceName / sourceVocalsDir(或 sourceWav) / 路径 / 训练参数

# 2) 数据准备：切段 + whisper 转写 → dataset_raw/<voiceName>/esd.list
npm run voice:train -- prepare

# 3) 数据格式化（hubert/semantic token → 6-name2semantic.tsv）
npm run voice:train -- format

# 4) 训练（长任务，后台跑）。--no-wait = 立即返回，训练在后台
npm run voice:train -- train-gpt --no-wait
npm run voice:train -- train-sovits --no-wait

# 5) 训练完 → 用新模型合成语音包（更新 scripts/long-lines.json 的 gpt/sovits/ref 后）
npm run voice:train -- synth

# 6) 质量评测（内容完整度/音色/节奏/污染 → 等级 + 对比上次）
npm run voice:train -- score
```

或全流程一条命令：`npm run voice:train -- all`（训练会前台阻塞数小时，慎用；建议分步骤 + --no-wait）。

## 各步骤详情

| 步骤 | 脚本 | 输入 → 输出 |
|---|---|---|
| prepare | `prepare.py` | 源音频 → `dataset_raw/<name>/esd.list`（2.5-12.5s 切片 + 转写文本；支持 TSV 声纹标注段 / whisper 自动切段 / 复用旧数据集） |
| format | `format-dataset.py` | esd.list → `6-name2semantic.tsv`（调 GPT-SoVITS 的 2-get-hubert / 3-get-semantic，环境变量传参同 webui） |
| train-gpt | `train-gpt.py` | semantic tsv → `GPT_weights_v2/<name>/<name>-e*.ckpt`（生成角色化 s1.yaml） |
| train-sovits | `train-sovits.py` | 训练集 → `SoVITS_weights_v2/<name>/G_*.pth`（生成 s2.json；产出即推理可用） |
| synth | synth-mashiro-long.py | long-lines.json（新权重/ref）→ `assets/voice/long/*.wav` + long.json |
| score | score-voices.py | 语音包 → 综合分/等级 + 对比 |

## 配置（config.json）要点

- `voiceName`：角色名，贯穿 dataset_raw / GPT_weights / SoVITS_weights / logs 目录命名
- `sourceVocalsDir` / `sourceWav`：源音频（csv 分离轨目录 或 单文件）
- `sourceSegmentsTsv`：可选手动/声纹筛选段落 `[ep,a,b,sim,text]`（高置信标注优先，`voiceSimThreshold` 过滤）
- `whisperModel` / `whisperDevice`：转写模型（缺标注段时自动转写）
- `gpt.sovits.*`：训练参数（epochs/batch/learningRate/预训练权重路径）
- `refWav` / `refText`：合成音色锚点（重要：ref 声纹决定成品像不像目标角色）

## 训练完接入项目

1. 确认 `scripts/long-lines.json` 顶部 `gpt` / `sovits` 指向新权重、`ref_wav/ref_text` 指向目标角色参考音频
2. `npm run voice:train -- synth` 重新合成
3. `npm run voice:train -- score` 评测 → 全部 ≥A 可发布，个别差用 `scripts/refix-voices.py <file>` 补

## 已知边界

- GPT 训练前必须 format（缺 `6-name2semantic.tsv` 会直接报错退出）
- s1/s2 训练脚本路径与参数版本敏感：如 GPT-SoVITS 升级大版本导致接口变化，脚本报错时对照 `GPT_SoVITS/s1_train.py` / `s2_train.py` 的参数修正
- 训练耗时长（GPT 20ep + SoVITS 16ep 在中端 GPU 约 2-3 小时），建议 `--no-wait` 后台 + 定期看日志
