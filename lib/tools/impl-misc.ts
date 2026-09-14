// 工具实现组：杂项（纵向拆分第 3 刀）
// toolReadToolResult（>8K 工具结果落盘恢复链路）
import { wrapUntrusted } from "../prompt-guard.mjs";

/** 读取工具结果存档的返回结构（成功 ok+content，失败 error） */
export interface ReadToolResult {
  ok?: boolean;
  content?: string;
  error?: string;
}

/**
 * 读取工具结果存档（tool_results 目录）
 * @param file 文件名
 * @returns 文件内容（失败返回 error）
 */
export async function toolReadToolResult(file: string): Promise<ReadToolResult> {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const path = await import("node:path");
    // 路径口径必须与写端（exec-utils.ts）完全一致：
    //   写端 = (process.env.MIANSHI_DATA_DIR || 仓库根/data)/tool_results/<fname>
    // 修复（闭环清查）：原先读端硬编码仓库根 data/ → 打包版/headless（MIANSHI_DATA_DIR 已重定向到
    // userData）下写进去的文件读不回来，>8K 结果恢复链路（read_tool_result）恒"文件不存在"。
    // 同时兼容写端记录的 `_file` 形态：`data/tool_results/<fname>`（仓库相对）与裸文件名。
    const dataDir = process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "..", "data");
    const resultsDir = path.resolve(path.join(dataDir, "tool_results"));
    const name = String(file || "")
      .trim()
      .replace(/^[\\/]+/, "")
      .replace(/^data[\\/]tool_results[\\/]/, "")
      .replace(/^tool_results[\\/]/, "");
    const target = path.resolve(path.join(resultsDir, name));
    if (!target.startsWith(resultsDir + path.sep)) {
      return { error: `拒绝读取：仅允许 data/tool_results/ 目录下的文件（收到 ${file}）` };
    }
    if (!existsSync(target)) return { error: `文件不存在: ${file}` };
    const content = readFileSync(target, "utf8");
    // 落盘结果可能含外部衍生内容，包裹为不可信数据
    return { ok: true, content: wrapUntrusted(content.slice(0, 30000)) }; // 单次最多 30KB
  } catch (e) {
    return { error: `读取失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}
