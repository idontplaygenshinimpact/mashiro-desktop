// 测试用 Skill：正常插件（含 auto 与 confirm 两种权限工具 + system 说明 + hooks）
export const name = "good-skill";
export const description = "测试用正常插件";
export const system = "good-skill 的 system 补充说明：ping 用于连通性验证。";

export const hooks = {
  after_tool: (p) => {
    // 记录最后一次工具名（供测试断言 hooks 自动注册）
    globalThis.__goodSkillLastTool = p?.toolName || null;
  },
};

export const tools = [
  {
    name: "ping",
    description: "返回 pong（测试用只读工具）",
    parameters: { type: "object", properties: { echo: { type: "string" } } },
    permission: "auto",
    async run({ echo }) {
      return { ok: true, pong: `echo:${String(echo ?? "")}` };
    },
  },
  {
    name: "write_note",
    description: "写入一条笔记（测试用 confirm 工具，验证权限分级）",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    permission: "confirm",
    async run({ text }) {
      return { ok: true, wrote: String(text ?? "").length };
    },
  },
];
