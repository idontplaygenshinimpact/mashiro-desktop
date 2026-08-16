// 示例 Skill：GitHub 仓库信息查询（公开 API，无需 token）
// 演示 skills 插件机制：目录 skills/<name>/skill.mjs → 自动注入 agent 工具
// 工具命名空间：skill__github-repo__get_repo_info
export const name = "github-repo";
export const description = "查询 GitHub 公开仓库基本信息（星标/语言/描述/更新时间），了解开源项目与框架动态";

export const tools = [
  {
    name: "get_repo_info",
    description:
      "查询 GitHub 公开仓库基本信息：stars/forks/language/描述/最近更新时间。如用户问「React 仓库情况」「xx 开源项目多火」时调用。",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库名，格式 owner/repo，如 vuejs/core、facebook/react" },
      },
      required: ["repo"],
    },
    permission: "auto", // 只读公开 API，无需审批
    async run({ repo }) {
      const m = String(repo || "").trim().match(/^[\w.-]+\/[\w.-]+$/);
      if (!m) return { error: "仓库名格式应为 owner/repo，如 vuejs/core" };
      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(m[0])}`, {
        headers: { "User-Agent": "mianshi-agent", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404) return { error: `仓库不存在: ${m[0]}` };
      if (!res.ok) return { error: `GitHub API ${res.status}` };
      const j = await res.json();
      return {
        ok: true,
        name: j.full_name,
        stars: j.stargazers_count ?? 0,
        forks: j.forks_count ?? 0,
        openIssues: j.open_issues_count ?? 0,
        language: j.language || "未知",
        license: j.license?.spdx_id || "未知",
        description: String(j.description || "").slice(0, 200),
        updatedAt: j.updated_at || "",
      };
    },
  },
];
