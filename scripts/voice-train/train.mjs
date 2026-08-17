// 真白语音训练一键编排：数据准备 → 数据格式化 → GPT 训练 → SoVITS 训练 → 推理权重接入 → 合成 → 评测
// 用法：
//   node scripts/voice-train/train.mjs prepare          # 只跑数据准备（从原始音频切段+转写 → esd.list）
//   node scripts/voice-train/train.mjs format           # 数据格式化（esd.list → semantic tsv）
//   node scripts/voice-train/train.mjs train-gpt        # GPT 训练（数小时，建议 --no-wait 后台）
//   node scripts/voice-train/train.mjs train-sovits     # SoVITS 训练（数小时，建议 --no-wait 后台）
//   node scripts/voice-train/train.mjs synth            # 用新模型合成语音包（调 synth-mashiro-long）
//   node scripts/voice-train/train.mjs score            # 质量评测（voice:score）
//   node scripts/voice-train/train.mjs all              # 全流程
//   --config <path> 指定配置（默认 scripts/voice-train/config.json）
// 说明：GPT/SoVITS 训练依赖 D:/GPT-SoVITS（外部环境），数据准备/合成/评测是本项目能力
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VT = path.join(ROOT, "scripts", "voice-train");
const PY = "C:/python/python.exe";

const args = process.argv.slice(2);
const step = args.find((a) => !a.startsWith("--")) || "help";
const cfgFlag = args.includes("--config") ? args[args.indexOf("--config") + 1] : path.join(VT, "config.json");
const noWait = args.includes("--no-wait");

// config 延迟加载：help/缺失时友好提示（不因无 config 崩）
const fs = await import("node:fs");
function getConfig() {
  if (!fs.existsSync(cfgFlag)) {
    console.error(`❌ 未找到配置: ${cfgFlag}
请先：
  cp scripts/voice-train/config.example.json ${path.relative(ROOT, cfgFlag)}
  # 编辑 voiceName / sourceVocalsDir(或 sourceWav) / 路径 / 训练参数`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(cfgFlag, "utf8"));
}
const cfg = step === "help" ? {} : getConfig();
const voiceName = cfg.voiceName || "（未配置）";

const run = (label, cmd, opts = {}) => {
  console.log(`\n===== ${label} =====`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) { console.error(`❌ ${label} 失败`); process.exit(1); }
  return true;
};

const STEPS = {
  prepare: () => run("数据准备（切段+转写 → esd.list）", [PY, path.join(VT, "prepare.py"), "--config", cfgFlag]),
  format: () => run("训练集格式化（→ semantic tsv）", [PY, path.join(VT, "format-dataset.py"), "--config", cfgFlag]),
  "train-gpt": () => run("GPT 训练", [PY, path.join(VT, "train-gpt.py"), "--config", cfgFlag, ...(noWait ? ["--no-wait"] : [])]),
  "train-sovits": () => run("SoVITS 训练", [PY, path.join(VT, "train-sovits.py"), "--config", cfgFlag, ...(noWait ? ["--no-wait"] : [])]),
  synth: () => {
    // 找训练产出的最新权重（GPT_weights_v2/<name>/*.ckpt 最高 epoch；SoVITS_weights_v2/<name>/G_*_infer 或 G_*.pth）
    const gs = cfg.gptSoVitsRoot;
    const gptDir = path.join(gs, "GPT_weights_v2", voiceName);
    const sovitsDir = path.join(gs, "SoVITS_weights_v2", voiceName);
    const findGpt = (dir) => {
      if (!fs.existsSync(dir)) return null;
      const ckpts = fs.readdirSync(dir).filter((f) => f.endsWith(".ckpt")).sort();
      return ckpts.length ? path.join(dir, ckpts[ckpts.length - 1]) : null;
    };
    const findSovits = (dir) => {
      if (!fs.existsSync(dir)) return null;
      const pths = fs.readdirSync(dir).filter((f) => /G_.*(infer)?\.pth$/.test(f) && !f.endsWith("D_")).sort();
      return pths.length ? path.join(dir, pths[pths.length - 1]) : null;
    };
    const gptW = findGpt(gptDir);
    const sovW = findSovits(sovitsDir);
    if (!gptW || !sovW) {
      console.error(`❌ 未找到训练权重：GPT(${gptDir}) / SoVITS(${sovitsDir})——先跑 train-gpt/train-sovits`);
      process.exit(1);
    }
    // 闭环：把新训练权重写进 long-lines.json（synth 脚本读它），合成才用新模型
    const llFile = path.join(ROOT, "scripts", "long-lines.json");
    const ll = JSON.parse(fs.readFileSync(llFile, "utf8"));
    ll.gpt = gptW;
    ll.sovits = sovW;
    if (cfg.refWav) ll.ref_wav = cfg.refWav;
    if (cfg.refText) ll.ref_text = cfg.refText;
    fs.writeFileSync(llFile, JSON.stringify(ll, null, 2) + "\n", "utf8");
    console.log(`已更新 long-lines.json：gpt=${gptW}\n  sovits=${sovW}`);
    // 强制重合成（不 --skip-existing，避免旧 wav 遮蔽新权重）
    return run("合成语音包（用新训练权重，强制重合成）", [PY, path.join(ROOT, "scripts", "synth-mashiro-long.py")]);
  },
  score: () => run("质量评测", [PY, path.join(ROOT, "scripts", "score-voices.py")]),
  help: () => {
    console.log(`语音训练编排（config: ${cfgFlag}，voice: ${voiceName}）
步骤: prepare | format | train-gpt | train-sovits | synth | score | all
示例:
  npm run voice:train -- prepare
  npm run voice:train -- train-gpt --no-wait    # GPT 训练后台跑
  npm run voice:train -- all                    # 全流程
提示: GPT/SoVITS 训练是长任务（数小时），用 --no-wait 后台跑；训练完跑 synth/score 出语音包`);
  },
};

if (step === "all") {
  for (const s of ["prepare", "format", "train-gpt", "train-sovits", "synth", "score"]) STEPS[s]();
} else if (STEPS[step]) {
  STEPS[step]();
} else {
  console.log(`未知步骤: ${step}`); STEPS.help();
}
console.log("\n✅ 完成");
