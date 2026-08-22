// mashiro-desktop 配置
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

// 主端点（官方 API）key：opencode auth.json 的 deepseek key 优先（官方 key）
// → 兜底 .env key（用户若配过官方 key 也能直接用）
function resolveOfficialApiKey() {
  const authPath = path.join(homedir(), ".local", "share", "opencode", "auth.json");
  try {
    if (existsSync(authPath)) {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (auth?.deepseek?.key) return auth.deepseek.key;
    }
  } catch {
    /* ignore */
  }
  return resolveApiKey();
}

// 多 Provider 路由（对标 Claude Code/OpenClaw 多模型支持）
// 优先级：环境变量 MIANSHI_PROVIDERS（JSON 数组 [{name,baseUrl,apiKey,model},...]）> 默认双端点（主 + 官方 failover）
// 示例：
//   MIANSHI_PROVIDERS=[{"name":"deepseek","baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-xxx","model":"deepseek-chat"},{"name":"local","baseUrl":"http://127.0.0.1:11434/v1","apiKey":"ollama","model":"qwen2.5"}]
function resolveProviders() {
  const env = process.env.MIANSHI_PROVIDERS;
  if (env && env.trim()) {
    try {
      const list = JSON.parse(env);
      if (Array.isArray(list) && list.length > 0) {
        const valid = list.every(
          (p) => p && typeof p === "object" && typeof p.baseUrl === "string" && p.baseUrl &&
            typeof p.apiKey === "string" && p.apiKey && typeof p.model === "string" && p.model
        );
        if (valid) {
          return list.map((p, i) => ({ name: String(p.name || `provider${i + 1}`), baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }));
        }
      }
    } catch { /* 非法 JSON 走默认双端点 */ }
  }
  return [
    {
      name: "main",
      baseUrl: process.env.DEEPSEEK_BASE_URL || "https://opencode.ai/zen/go/v1",
      apiKey: resolveApiKey(),
      model: process.env.MIANSHI_MODEL || "deepseek-v4-flash",
    },
    {
      name: "fallback",
      baseUrl: process.env.DEEPSEEK_FALLBACK_BASE_URL || "https://api.deepseek.com/v1",
      apiKey: resolveOfficialApiKey(),
      model: process.env.MIANSHI_OFFICIAL_MODEL || "deepseek-chat",
    },
  ];
}

export const config = {
  // 主端点：OpenCode Go 订阅（省钱，网关实测正常）；空响应/超时自动 failover 官方 API
  apiKey: resolveApiKey(),
  baseUrl: process.env.DEEPSEEK_BASE_URL || "https://opencode.ai/zen/go/v1",
  // 备用端点（failover）：官方 API（稳定），key 用 opencode auth.json 的官方 deepseek key
  fallbackApiKey: resolveOfficialApiKey(),
  fallbackBaseUrl: process.env.DEEPSEEK_FALLBACK_BASE_URL || "https://api.deepseek.com/v1",
  // 多 provider 路由（llm.mjs 优先使用；未配置时等价于上面主+备双端点）
  providers: resolveProviders(),
  // 判断/过滤用 flash（便宜快），完整讲解用 flash 亦可，质量不够可切 pro
  model: process.env.MIANSHI_MODEL || "deepseek-v4-flash",
  // 官方 API 端点专用模型：实测 deepseek-v4-flash 直连官方 API 稳定空响应(HTTP200+空content)，
  // deepseek-chat 稳定且被映射到 v4-flash 后端（模型列表没有但兼容旧客户端，调用通）
  officialModel: process.env.MIANSHI_OFFICIAL_MODEL || "deepseek-chat",
  linksFile: path.join(import.meta.dirname, "links.txt"),
  // 产出目录（测试可用 MIANSHI_OUTPUT_DIR 指向临时目录，避免污染真实产出）
  outputDir: process.env.MIANSHI_OUTPUT_DIR || path.join(import.meta.dirname, "output"),
  // Playwright 抓取超时（毫秒）
  navTimeout: 45000,
  // 每题讲解的 max_tokens（长文完整讲解需要足够空间，24000 防截断）
  solveMaxTokens: 24000,
  // 上下文压缩参数（.env 可覆盖：COMPACT_BUDGET / COMPACT_KEEP_RECENT）
  compactBudget: Number(process.env.COMPACT_BUDGET) || 18000,
  compactKeepRecent: Number(process.env.COMPACT_KEEP_RECENT) || 4000,
};

// 启动自检：key 缺失时明确报错（避免静默失败）
export function assertConfig() {
  if (!config.apiKey) {
    console.error(
      "\n❌ 未找到 DeepSeek API Key！\n" +
        "  请在项目根目录的 .env 中配置：\n" +
        "    DEEPSEEK_API_KEY=sk-xxx\n" +
        "  或设置环境变量 DEEPSEEK_API_KEY\n" +
        "  （也可复用 opencode 的 key：~/.local/share/opencode/auth.json）\n"
    );
    process.exit(1);
  }
  if (!/^(sk-|deepseek-)/.test(config.apiKey)) {
    console.error("\n❌ API Key 格式异常（应以 sk- 开头）：", config.apiKey.slice(0, 8) + "...\n");
    process.exit(1);
  }
  return true;
}
