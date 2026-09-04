// 日志轮转工具（M7：日志 append 无轮转 → 10MB × 5 份，防磁盘无限膨胀）
import { statSync, renameSync, unlinkSync, existsSync } from "node:fs";

/**
 * 检查日志文件大小，超过上限则轮转（xxx.log → xxx.log.1 → ... → xxx.log.4，删最旧）
 * @param {string} filePath 日志路径
 * @param {number} [maxMB] 上限 MB（默认 10）
 * @returns {boolean} 是否发生了轮转
 */
export function rotateIfBig(filePath, maxMB = 10) {
  try {
    if (!existsSync(filePath)) return false;
    const st = statSync(filePath);
    if (st.size < maxMB * 1024 * 1024) return false;
    // 滚动：先删最旧（.4），再 .3→.4、.2→.3、.1→.2、原→.1
    try { unlinkSync(`${filePath}.4`); } catch { /* 不存在忽略 */ }
    for (const i of [3, 2, 1]) {
      try { renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`); } catch { /* 不存在忽略 */ }
    }
    try { renameSync(filePath, `${filePath}.1`); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}
