// 桌宠图标设置：rcedit 把椎名真白图标嵌进 electron.exe（快捷方式/任务栏图标）
// 用法: node scripts/set-icon.mjs（npm install 后 electron 重装需重跑）
// 说明: electron 二进制被 npm install 覆盖后图标会还原——重跑本脚本即可
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const ico = path.join(ROOT, "assets", "mashiro-icon.ico");
const rcedit = path.join(ROOT, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");

if (!existsSync(exe)) { console.log("electron.exe 不存在（未安装/CI 跳过二进制）——跳过"); process.exit(0); }
if (!existsSync(ico)) { console.log("mashiro-icon.ico 不存在——跳过"); process.exit(0); }
if (!existsSync(rcedit)) { console.log("rcedit 不存在——跳过"); process.exit(0); }

try {
  execFileSync(rcedit, [exe, "--set-icon", ico], { stdio: "inherit" });
  console.log("✅ electron.exe 图标已设为椎名真白（mashiro-icon.ico）");
} catch (e) {
  console.error("rcedit 失败:", String(e?.message || e).slice(0, 120));
  process.exit(1);
}
