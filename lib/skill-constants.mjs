// 技能共享常量（技术债 L15：project-eval 与 interview-prep 的 GROUP_BUDGET/FILE_CAP
// 逐字相同各自定义——收敛单点——改一处全局生效）
// 分组字符预算：每组累计 ≤24000 字符（subagent 上下文可控——大文件全文读/单独组）
export const GROUP_BUDGET = 24000;
// 单文件读取上限（防超大文件爆上下文；>30KB 的文件仍截断——罕见）
export const FILE_CAP = 30000;
