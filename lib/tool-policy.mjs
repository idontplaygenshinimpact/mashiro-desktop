// 工具策略层（tool policy before prompt，对标 OpenClaw 的"策略先于提示词"）
// 纯模块：零依赖、不 import 其他 lib 模块（自包含），后续 agent.mjs 接线时不会产生循环依赖。
//
// 核心原则：
//   - 被用户 DENY 的工具，其 schema 绝不进入 LLM prompt（filterTools 直接剔除，schema 不暴露）
//   - allow / confirm 保留在列表里（confirm 仍需运行时审批，但 schema 对模型可见）
//   - 分层优先级：显式 overrides > 激活 profile > default profile > 内置兜底（'confirm' 保守）
//
// profile 支持 `*` 通配键：匹配该层未显式列出的任意工具，用于"仅白名单可见"类 profile
// （如 interview 模式：只暴露面试相关工具，其余全部 deny）。

/** 合法的工具权限等级（升序为可见性/权限递进） */
export const LEVELS = Object.freeze(["allow", "confirm", "deny"]);

/** 未知工具的内置兜底等级：保守 confirm（schema 可见，但每次调用需审批） */
export const BUILTIN_FALLBACK = "confirm";

const isLevel = (v) => LEVELS.includes(v);

/**
 * 本应用预置 profile（createToolPolicy 不传 profiles 时使用；可被覆盖/扩展）。
 * 注意：default 层不设 `*` 通配，因此未列出工具走内置兜底 confirm。
 */
export const DEFAULT_PROFILES = Object.freeze({
  default: {
    // 网络 / 搜索工具
    web_search: "allow",
    fetch_page: "allow",
    search_posts: "allow",
    search_knowledge: "allow",
    // 输出 / 归档工具
    solve_question: "allow",
    detect_questions: "allow",
    read_tool_result: "allow",
    // 学习闭环
    get_study_plan: "allow",
    get_weak_points: "allow",
    get_memory: "allow",
    get_recent_outputs: "allow",
    remember: "allow",
    // 面试
    start_interview: "allow",
    submit_answer: "allow",
    end_interview: "allow",
    // 任务规划
    plan_task: "allow",
    // 写库类保持 confirm（需运行时审批）
    record_interview_topics: "confirm",
  },
  focus: {
    // 专注模式：禁止一切浏览（web_search / fetch_page / search_posts），其余沿用 default
    web_search: "deny",
    fetch_page: "deny",
    search_posts: "deny",
  },
  interview: {
    // 模拟面试模式：仅面试相关工具可见，其余全部 deny（`*` 通配）
    "*": "deny",
    start_interview: "allow",
    submit_answer: "allow",
    end_interview: "allow",
    get_study_plan: "allow",
    get_weak_points: "allow",
  },
});

/**
 * 在某一层（profile 或 overrides）内查找工具等级。
 * 先精确匹配工具名，再退到 `*` 通配；都没有则返回 null（表示该层未决策）。
 * @param {Record<string, string>} map
 * @param {string} toolName
 * @returns {{ level: "allow"|"confirm"|"deny", key: string } | null}
 */
function lookupLayer(map, toolName) {
  if (!map || typeof map !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(map, toolName)) {
    return { level: /** @type {"allow"|"confirm"|"deny"} */ (map[toolName]), key: toolName };
  }
  if (Object.prototype.hasOwnProperty.call(map, "*")) {
    return { level: /** @type {"allow"|"confirm"|"deny"} */ (map["*"]), key: "*" };
  }
  return null;
}

/** 从工具条目（string / { name } / { function: { name } }）提取工具名 */
function toolNameOf(tool) {
  if (typeof tool === "string") return tool;
  if (!tool || typeof tool !== "object") return null;
  if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  if (typeof tool.name === "string") return tool.name;
  return null;
}

/**
 * 创建工具策略对象。
 * @param {{ profiles?: Record<string, Record<string, string>>, overrides?: Record<string, string> }} [opts]
 *   profiles：命名 profile → 工具名到等级的映射；缺省用 DEFAULT_PROFILES。
 *   overrides：显式覆盖（最高优先级），同样支持 `*` 通配。
 * @returns 策略对象（含 effectiveLevel / filterTools / validate / serialize / deserialize）。
 */
export function createToolPolicy({ profiles, overrides } = {}) {
  // 注意区分"未传"（undefined → 用预置）与"显式传 null/非法"（保留给 validate 报错）
  const mergedProfiles = profiles === undefined ? DEFAULT_PROFILES : profiles;
  const mergedOverrides = overrides === undefined ? {} : overrides;

  // 内部拷贝，隔离外部后续修改（调用方拿到对象后再改不影响本策略）
  const profileMap = {};
  if (mergedProfiles && typeof mergedProfiles === "object" && !Array.isArray(mergedProfiles)) {
    for (const [name, map] of Object.entries(mergedProfiles)) {
      profileMap[name] = map && typeof map === "object" && !Array.isArray(map) ? { ...map } : {};
    }
  }
  const overrideMap = mergedOverrides && typeof mergedOverrides === "object" && !Array.isArray(mergedOverrides)
    ? { ...mergedOverrides }
    : {};

  /**
   * 计算某工具在当前激活 profile 下的生效等级。
   * @param {string} toolName
   * @param {{ activeProfile?: string }} [opts]
   * @returns {{ level: "allow"|"confirm"|"deny", source: "override"|"profile"|"default"|"builtin", key: string, reason: string }}
   */
  function effectiveLevel(toolName, { activeProfile } = {}) {
    const name = String(toolName);

    // 1. 显式 overrides（最高优先级）
    const ov = lookupLayer(overrideMap, name);
    if (ov) {
      return { level: ov.level, source: "override", key: ov.key, reason: `override: ${ov.key}=${ov.level}` };
    }

    // 2. 激活 profile（未命中或 profile 名非法时跳过）
    if (activeProfile && profileMap[activeProfile]) {
      const p = lookupLayer(profileMap[activeProfile], name);
      if (p) {
        return { level: p.level, source: "profile", key: p.key, reason: `profile "${activeProfile}": ${p.key}=${p.level}` };
      }
    }

    // 3. default profile
    const d = lookupLayer(profileMap.default, name);
    if (d) {
      return { level: d.level, source: "default", key: d.key, reason: `default profile: ${d.key}=${d.level}` };
    }

    // 4. 内置兜底
    return { level: BUILTIN_FALLBACK, source: "builtin", key: "*", reason: `builtin fallback (unknown tool): ${BUILTIN_FALLBACK}` };
  }

  /**
   * 过滤工具列表：deny 的工具被剔除（schema 不进 prompt），allow/confirm 保留。
   * 不修改原数组。
   * @param {Array<{name?: string, function?: {name?: string}}|string>} tools
   * @param {{ activeProfile?: string }} [opts]
   * @returns {{ allowed: object[], hidden: object[], hiddenCount: number }}
   */
  function filterTools(tools, { activeProfile } = {}) {
    const list = Array.isArray(tools) ? tools : [];
    const allowed = [];
    const hidden = [];
    for (const tool of list) {
      const name = toolNameOf(tool);
      // 无法识别名称的工具：保守保留（可见），避免误杀
      if (name == null) {
        allowed.push(tool);
        continue;
      }
      const { level } = effectiveLevel(name, { activeProfile });
      if (level === "deny") hidden.push(tool);
      else allowed.push(tool);
    }
    return { allowed, hidden, hiddenCount: hidden.length };
  }

  /**
   * 校验 profiles / overrides 结构。返回 { ok, errors[] }。
   * @returns {{ ok: boolean, errors: string[] }}
   */
  function validate() {
    const errors = [];
    if (!mergedProfiles || typeof mergedProfiles !== "object" || Array.isArray(mergedProfiles)) {
      errors.push("profiles 必须是对象（{ name: { tool: level } }）");
    } else {
      for (const [pname, map] of Object.entries(mergedProfiles)) {
        if (!map || typeof map !== "object" || Array.isArray(map)) {
          errors.push(`profile "${pname}" 必须是对象（{ tool: level }）`);
          continue;
        }
        for (const [tool, level] of Object.entries(map)) {
          if (!isLevel(level)) {
            errors.push(`profile "${pname}" 工具 "${tool}" 等级非法: "${level}"（应为 allow/confirm/deny）`);
          }
        }
      }
    }
    if (!mergedOverrides || typeof mergedOverrides !== "object" || Array.isArray(mergedOverrides)) {
      errors.push("overrides 必须是对象（{ tool: level }）");
    } else {
      for (const [tool, level] of Object.entries(mergedOverrides)) {
        if (!isLevel(level)) {
          errors.push(`override 工具 "${tool}" 等级非法: "${level}"（应为 allow/confirm/deny）`);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /** 序列化为 JSON 字符串（用于持久化，如 widget settings）。 */
  function serialize() {
    return JSON.stringify({ profiles: profileMap, overrides: overrideMap });
  }

  const policy = {
    profiles: profileMap,
    overrides: overrideMap,
    effectiveLevel,
    filterTools,
    validate,
    serialize,
    deserialize,
  };
  return policy;
}

/**
 * 从序列化 JSON 重建策略对象（顶层导出，供持久化恢复）。
 * @param {string | { profiles?: object, overrides?: object }} json
 */
export function deserialize(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  return createToolPolicy({
    profiles: data && data.profiles,
    overrides: data && data.overrides,
  });
}
