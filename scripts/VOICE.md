# 真白语音合成流程（固化版）

一键流程：**训练 → 合成 → 评测 → 审计**，全部参数化、可复现。

## 快速开始

```bash
# 1. 训练（完整链路：数据准备 → 数据格式化 → GPT/SoVITS 训练 → 合成 → 评测）
#    详见 scripts/voice-train/README.md；训练是长任务用 --no-wait 后台
npm run voice:train -- prepare        # 数据准备（切段+转写 → esd.list）
npm run voice:train -- format         # 训练集格式化（→ semantic tsv）
npm run voice:train -- train-gpt --no-wait    # GPT 训练（后台）
npm run voice:train -- train-sovits --no-wait # SoVITS 训练（后台）
npm run voice:train -- synth          # 用新权重合成语音包
npm run voice:train -- score          # 质量评测

# 2. 质量评测（内容完整度/音色/节奏/污染 → 综合分 A-D + 与上次对比）
npm run voice:score

# 3. 快速审计（2-gram 覆盖率 + ref 泄漏检测，无评分）
npm run voice:audit
```

## 模型配置（scripts/long-lines.json 顶部）

| 字段 | 当前值 | 说明 |
|---|---|---|
| `gpt` | `GPT_weights_v2/mashiro3/mashiro3-e20.ckpt` | GPT 模型（全量 1472 段 20 epoch） |
| `sovits` | `SoVITS_weights_v2/mashiro3/G_233333333333_infer.pth` | SoVITS 模型（全量 16 epoch，推理格式） |
| `ref_wav` | `radio/ref-clean-A.wav` | 参考音频（人设温柔风；ref-clean-2 曾因质量分 +27% 短暂换用，**听感否决**：语气偏强硬不符真白人设，已回滚 2026-08-26） |
| `ref_text` | `戻ろうと思って…離したら飛んでくわ` | ref 精确文本（whisper 转写确认） |

换模型/ref 后重跑 `npm run voice:synth && npm run voice:score -- --compare` 即可对比。

## 合成管线（synth-mashiro-long.py）

1. **拆句**：长独白按 `。！？` 拆成 ≤60 字子句（短句生成成功率高）
2. **文本清洗**：`\n`→`。`、`……`→`、`（消除模型强停顿标记）
3. **逐子句合成**：每子句 5 次采样（top_p/temperature 微扫描）取 2-gram 完整度最高
4. **拼接**：子句间插 0.15s 静音（停顿可控，`GAP_SEC` 可调）
5. **产出**：`assets/voice/long/*.wav` + `long.json`（voice-pack 运行时读取）

参数：`--gpt` `--sovits` `--ref` `--ref-text` `--only <scene>` `--skip-existing`

## 评测体系（score-voices.py）

每文件 5 项指标 → 综合分（0-1）→ 等级：

| 指标 | 权重 | 说明 |
|---|---|---|
| cov（内容完整度） | 0.4 | whisper 转写 vs 原文 2-gram 覆盖率，≥0.8 满分 |
| voice_sim（音色） | 0.3 | resemblyzer 声纹 vs 真白锚点（0.7→0 分，0.9→满分） |
| pacing（节奏） | 0.2 | ms/字，110-170 自然满分，90-200 良，其余差 |
| 基础分 | 0.1 | 声纹可用即得 |
| pollution | -0.15/次 | ref 特征短语泄漏（换 ref 时更新 `POLLUTE` 列表） |

- 等级：A ≥0.8 / B ≥0.65 / C ≥0.5 / D <0.5
- 锚点缓存：`data/mashiro-anchor.npy`（首次从训练切片自动提取）
- 历史对比：`data/voice-score-last.json`，`--compare` 显示与上次差值
- 注意：faster-whisper(ctranslate2) 与 torch cuDNN 同进程冲突 → resemblyzer 强制 CPU

## 审计（audit-voices.py，npm run voice:audit）

快速完整性审计（whisper beam_size=5 转写全部文件）：

| 标记 | 判定 | 含义 |
|---|---|---|
| OK | cov≥0.5 且无泄漏 且（长句 tail≥0.3） | 通过 |
| TRUNC | 长句尾 2-gram <0.3 | **话没说完**（结尾句子缺失，需重合成）|
| BAD | cov<0.5 | 内容缺失/识别过低 |
| POLLUT | 检出 ref 特征短语 | 参考音频泄漏 |

- 长句末尾完整度（tail）：转写末尾 24 字 vs 原文末尾 24 字 2-gram 覆盖率。
  曾漏判：旧版只查总覆盖 0.5，长句"话没说完"全部放过（2026-08 实测 8 长句末尾仅 7-42%）

## 已知边界

- whisper-medium 转写日文有错字 → cov 是下限估计（实际内容更全）
- 个别文件声优/语气词结尾模型不稳定（idle-long-1 的"うん、真白はここでちゃんと待ってる"末尾"うん"多次重合成仍缺）→ 容忍或改文案
- 个别短句（love-1 / praise-2 等）模型生成不稳定 → `scripts/refix-voices.py <file>` 多采样补（12 次）
- SoVITS 重训流程已内置：`npm run voice:train -- train-sovits`（详见 scripts/voice-train/README.md）

## 尾部截断修复（2026-09 落库，TRUNC 根因治理）

**根因（代码实锤）**：旧 `verify_complete` 只算"整块 2-gram 覆盖率"——块尾丢 1-2 词只掉 ~5% 分，照样 ≥0.55 达标，尾部丢词被选为 best（"话没说完"通过）。另有错误工具路径：`refix-voices.py` 对长句整条合成，超过 GPT 生成时长上限（max_sec）尾部硬截断。

**修复**（synth-mashiro-long.py + refix-voices.py）：
1. 新增 `verify_complete_v2` → 返回 (整块覆盖, 尾部覆盖)；尾部 = 期望末尾 10 字 vs 转写末尾 10 字的 2-gram
2. 选优改综合分 `0.7×整块 + 0.3×尾部`；达标线：整块 ≥0.55 且 尾部 ≥0.4（尾部块 ≥0.55）
3. **尾部块专项**：最后一块 3 轮 ×6 采样（普通块 2 轮），更严达标线
4. 尾部仍不达标 → 打印"期望末尾: …"（定向改文案或重合成，不再整条盲跑）
5. refix 对 `*-long-*` 拒绝整条合成（防 max_sec 截断），改走 synth 拆块重跑

**复跑**：`npm run voice:synth -- --only idle`（会重合成 idle 短句+长句）后 `npm run voice:audit` 验证 idle-long-1 tail ≥30%

## 精准补尾（2026-08-26 落地，idle-long-1 修复完成）

整条重合成会换掉主体音色（实测失真，用户否决）。最终采用**精准补尾**（`scripts/_tail-fix.py`）：
1. 转写原版定位"最后语音段起点"（idle-long-1 = 24.0s 处残缺尾句"真白はここで"）
2. 只合成缺失句"うん、真白はここで、ちゃんと待ってるからね。"（四维选优：cov/tail/sim≥0.88/pace；20 字在 min_len 边缘，**模型随机性大，需多轮重试**——实测一轮 12 采样可能全军覆没，重跑即可能选中 cov 61/tail 67/sim 0.93）
3. ffmpeg 重采样新句到原版采样率（原版为 **192kHz**，勿按 32k 估算时长！）→ 拼接（主体 + 0.15s 静音 + 新句）
4. 验证：audit idle-long-1 tail 11%→67%，TRUNC 清零；**主体音色零改动**

**两个实测坑**（已踩）：
- faster-whisper 必须先于 GPT-SoVITS import？**不**——必须 GPT_SoVITS（torch）先于 faster_whisper（ctranslate2），否则 `cudnnGetLibConfig 127`
- np.interp 上采样会压缩时长 6 倍（花栗鼠音）——必须 ffmpeg `-ar` 重采样

## 推理参数网格实验（2026-08-26，27 组实测）`scripts/_param-grid.py`：top_k(5/10/20) × top_p(0.85/0.95/1.0) × temperature(0.6/0.8/1.0) × 3 条代表文本（短句/中句/语气词尾句），四维评分。

**结论**：
- **最优组合：top_k=20 / top_p=0.85 / temperature=1.0**（avg 0.74；最难尾句 0.802）
- 规律：**temperature=1.0 显著最优**（0.638 vs 0.588/0.592）——低温度生成机械且内容缺失；top_k≥10；top_p 影响最小
- 最差：top_k=5/top_p=0.85/temp=0.6（0.395，过度确定性）
- synth-mashiro-long.py 采样序列已改为"最优参数首选 + 邻域微调"

**对比验证**（`scripts/_param-compare.py`，各 5 次采样）：
- 新最优 vs 旧默认：总体 0.534→0.582（+9%）；中句 +0.127 显著；短句微升且更稳
- 语气词尾句两组均值持平（~0.43），新参数方差大（双峰：0.8 或 0）——归因模型固有难点，多采样选优兜底（能命中 0.8 高点）
- 结论：新参数确认有效，保留为默认

## 评测基线（2026-08-17，mashiro3 GPT e20 + SoVITS 全量 + ref-clean-A + 拆句拼接）

```
26 条全 A | 平均分 0.94 | 完整度均 61% | 声纹 0.948 | 长独白 5-6 段拼接 0.15s 停顿
```

## 已知边界

- whisper-medium 转写日文有错字 → cov 是下限估计（实际内容更全）
- 个别短句（love-1 等）模型生成不稳定 → `scripts/refix-voices.py <file>` 多采样补（12 次）
- SoVITS 重训流程：`GPT-SoVITS` 侧 `s2_train.py -c tmp_s2_mashiro3.json` → 转换推理权重（weight+config 底模）→ 更新 long-lines.json 的 `sovits` 字段
