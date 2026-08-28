// 工具实现组：杂项（纵向拆分第 3 刀）
// toolReadToolResult（>8K 工具结果落盘恢复链路）
import { wrapUntrusted } from "../prompt-guard.mjs";

export async function toolReadToolResult(file) {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const path = await import("node:path");
    // 修复：写端（exec-utils.mjs）落盘到仓库根 data/tool_results（dirname=lib/tools → ../..），
    // 读端原用 ..（=lib/）→ 路径错位 → read_tool_result 恒"文件不存在"，>8K 结果恢复链路死掉
    const root = path.join(import.meta.dirname, "..", "..");
    const resultsDir = path.resolve(path.join(root, "data", "tool_results"));
    const target = path.resolve(path.join(root, String(file || "")));
    if (!target.startsWith(resultsDir + path.sep)) {
      return { error: `拒绝读取：仅允许 data/tool_results/ 目录下的文件（收到 ${file}）` };
    }
    if (!existsSync(target)) return { error: `文件不存在: ${file}` };
    const content = readFileSync(target, "utf8");
    // 落盘结果可能含外部衍生内容，包裹为不可信数据
    return { ok: true, content: wrapUntrusted(content.slice(0, 30000)) }; // 单次最多 30KB
  } catch (e) {
    return { error: `读取失败: ${e.message}` };
  }
}
