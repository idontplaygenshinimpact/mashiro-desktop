// 浏览器登录态直读：读取用户 Edge/Chrome 的牛客 Cookie（实时同步，零额外登录）
// 原理：Chromium 系 Cookie 存 User Data\<Profile>\Network\Cookies（SQLite）
//       值用 DPAPI（Local State 的 encrypted_key）+ AES-128-GCM 加密 → 本地解密复用
// DPAPI 解密走 PowerShell ProtectedData
import { readFileSync, copyFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const BROWSERS = {
  edge: {
    name: "Edge",
    userData: path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data"),
  },
  chrome: {
    name: "Chrome",
    userData: path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  },
};

/** DPAPI 解密（PowerShell ProtectedData，当前用户上下文） */
function dpapiDecrypt(data) {
  const b64 = data.toString("base64");
  const script = `Add-Type -AssemblyName System.Security;$raw=[Convert]::FromBase64String('${b64}');$c=$raw[5..($raw.Length-1)];$k=[System.Security.Cryptography.ProtectedData]::Unprotect($c,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);([BitConverter]::ToString($k)).Replace('-','')`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000 });
  return Buffer.from(out.trim(), "hex");
}

/** 读取 AES key（Local State → encrypted_key → DPAPI） */
function getAesKey(userData) {
  const localState = path.join(userData, "Local State");
  if (!existsSync(localState)) throw new Error("Local State 不存在");
  const state = JSON.parse(readFileSync(localState, "utf8"));
  const b64 = state?.os_crypt?.encrypted_key;
  if (!b64) throw new Error("Local State 无 encrypted_key");
  const raw = Buffer.from(b64, "base64");
  if (raw.subarray(0, 5).toString() !== "DPAPI") throw new Error("encrypted_key 前缀异常");
  return dpapiDecrypt(raw); // AES-256 key（32 字节）
}

/** AES-128-GCM 解密单个 cookie 值（v10/v11 格式；v20 app-bound 暂不支持） */
function decryptCookieValue(encrypted, key) {
  const buf = Buffer.from(encrypted);
  if (buf.length < 15) return "";
  const prefix = buf.subarray(0, 3).toString();
  if (prefix !== "v10" && prefix !== "v11") return ""; // v20 新版 app-bound 需系统级处理
  const nonce = buf.subarray(3, 15);
  const cipher = buf.subarray(15);
  try {
    const d = createDecipheriv("aes-128-gcm", key.subarray(0, 16), nonce);
    d.setAuthTag(cipher.subarray(cipher.length - 16));
    const out = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
    return out.toString("utf8");
  } catch { return ""; }
}

/**
 * 读取浏览器中牛客域的 Cookie（实时同步用户会话）
 * @param {"edge"|"chrome"} [browser] 指定浏览器；缺省自动检测（先 Edge 后 Chrome）
 * @returns {Promise<{name:string, value:string, domain:string, path:string}[] | null>} null = 读取失败
 */
export async function readNowcoderCookies(browser) {
  const candidates = browser ? [browser] : ["edge", "chrome"];
  for (const b of candidates) {
    const cfg = BROWSERS[b];
    try {
      const userData = cfg.userData;
      if (!existsSync(userData)) continue;
      const key = getAesKey(userData);
      // 遍历该浏览器的所有 profile（Default/Profile N）找牛客 cookie
      const profiles = readdirSync(userData).filter((d) => /^(Default|Profile \d+)$/.test(d));
      for (const profile of profiles) {
        const dbPath = path.join(userData, profile, "Network", "Cookies");
        if (!existsSync(dbPath)) continue;
        // 直接只读打开（SQLite 共享读）；被独占锁时复制到临时目录重试
        let db = null;
        let tmp = null;
        try {
          try {
            db = new DatabaseSync(dbPath, { readOnly: true });
          } catch {
            for (let attempt = 0; attempt < 3; attempt++) {
              tmp = mkdtempSync(path.join(tmpdir(), "browser-cookies-"));
              try {
                copyFileSync(dbPath, path.join(tmp, "Cookies"));
                db = new DatabaseSync(path.join(tmp, "Cookies"), { readOnly: true });
                break;
              } catch (e2) {
                rmSync(tmp, { recursive: true, force: true });
                tmp = null;
                if (attempt === 2) throw e2;
                await new Promise((r) => setTimeout(r, 500));
              }
            }
          }
          const rows = db.prepare(
            "SELECT host_key, name, encrypted_value, path FROM cookies WHERE host_key LIKE '%nowcoder.com'"
          ).all();
          db.close();
          const out = [];
          for (const r of rows) {
            const value = decryptCookieValue(r.encrypted_value, key);
            if (value) out.push({ name: String(r.name), value, domain: String(r.host_key), path: String(r.path) });
          }
          if (out.length) return out; // 找到牛客登录态
        } finally {
          if (tmp) rmSync(tmp, { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.log(`[browser-cookies] ${cfg?.name || b} 读取失败: ${String(e.message).slice(0, 80)}`);
    }
  }
  return null;
}

/** 兼容旧名 */
export const readChromeNowcoderCookies = readNowcoderCookies;
