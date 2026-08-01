// mianshi-agent 配置
// API key 优先级：.env 文件 > 环境变量 DEEPSEEK_API_KEY > opencode auth.json
// 端点默认走 OpenCode Go（opencode.ai/zen/go/v1），用 Go 订阅额度
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function loadDotEnv() {
  const envPath = path.join(import.meta.dirname, ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].trim();
  }
  return env;
}

const dotenv = loadDotEnv();

function resolveApiKey() {
  if (dotenv.DEEPSEEK_API_KEY) return dotenv.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  // 兜底：复用 opencode 的 deepseek key
  const authPath = path.join(homedir(), ".local", "share", "opencode", "auth.json");
  try {
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (auth?.deepseek?.key) return auth.deepseek.key;
    }
  } catch {
    /* ignore */
  }
  return "";
}

export const config = {
  apiKey: resolveApiKey(),
  // OpenCode Go 端点（OpenAI 兼容），走 Go 订阅额度
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://opencode.ai/zen/go/v1",
  // 判断/过滤用 flash（便宜快），完整讲解用 flash 亦可，质量不够可切 pro
  model: process.env.MIANSHI_MODEL || "deepseek-v4-flash",
  linksFile: path.join(import.meta.dirname, "links.txt"),
  outputDir: path.join(import.meta.dirname, "output"),
  // Playwright 抓取超时（毫秒）
  navTimeout: 45000,
  // 每题讲解的 max_tokens（长文完整讲解需要足够空间，24000 防截断）
  solveMaxTokens: 24000,
};
