// 场景装配（Phase P1：事件 → 技能子集映射）
// 场景 = 策略不是功能：SCENARIOS 数组即配置，when 纯函数（无副作用、可测），
// 数组顺序 = 优先级（首个命中生效），default 兜底保证永远有场景。
// 状态：currentScenario 持久化 data/scene.json（原子写）——重启恢复，不回落到全量
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { emitEvent } from "./events.mjs";

/** 场景声明（skills = 该场景激活的技能子集；空 = 不注入任何技能） */
export interface Scenario {
  id: string;
  name: string;
  /** 事件 → 是否命中本场景（纯函数、无副作用、可测） */
  when: (ev: unknown) => boolean;
  skills: string[];
}

/** 兜底场景：不注入任何技能（always 命中，保证 matchScenario 永不落空） */
export const DEFAULT_SCENARIO: Scenario = { id: "default", name: "默认", when: () => true, skills: [] };

/** 防御式读取统一事件的 type 字段（事件可能任意形状：非对象/null/无 type 都回落 undefined） */
function evType(ev: unknown): string | undefined {
  if (ev === null || typeof ev !== "object") return undefined;
  const t = (ev as { type?: unknown }).type;
  return typeof t === "string" ? t : undefined;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "interview", name: "面试陪练",
    when: (ev: unknown) => evType(ev) === "interview:started" || evType(ev) === "interview:answering",
    skills: ["interview-warmup", "resume-coach"],
  },
  {
    id: "companion", name: "CC 陪伴",
    when: (ev: unknown) => {
      const t = evType(ev);
      return t !== undefined && t.startsWith("cc:");
    },
    skills: ["company-intel", "tech-compare"], // 陪伴期间可查询公司/对比技术
  },
  {
    id: "study", name: "学习模式",
    when: (ev: unknown) => evType(ev) === "study:opened",
    skills: ["frontend-cheatsheet"],
  },
  DEFAULT_SCENARIO, // 兜底：不注入任何技能
];

const STATE_FILE = path.join(import.meta.dirname, "..", "data", "scene.json");
const TMP_FILE = STATE_FILE + ".tmp";

function loadSavedState(): string {
  try {
    if (existsSync(STATE_FILE)) {
      const j = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (j?.scenarioId && SCENARIOS.some((s) => s.id === j.scenarioId)) return j.scenarioId;
    }
  } catch { /* 状态损坏回落到 default */ }
  return "default";
}

function saveState(scenarioId: string): void {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(TMP_FILE, JSON.stringify({ scenarioId, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    renameSync(TMP_FILE, STATE_FILE); // 原子替换（写 tmp → rename）
  } catch { /* 持久化失败不影响运行（下次事件重试） */ }
}

/** 当前场景（启动从状态文件恢复；缺省 default） */
let current = loadSavedState();

/** 事件 → 匹配场景（数组顺序优先，default 兜底；纯函数可测） */
export function matchScenario(ev: unknown): Scenario | null {
  for (const s of SCENARIOS) {
    if (s.when(ev)) return s;
  }
  return SCENARIOS.find((s) => s.id === "default") || null;
}

/** 当前场景对象（default 兜底：状态损坏/未匹配时也返回有效场景） */
export function getCurrentScenario(): Scenario {
  return SCENARIOS.find((s) => s.id === current) ?? DEFAULT_SCENARIO;
}

/**
 * 处理一条事件：匹配场景 → 若切换：更新状态 + 持久化 + 发 scene:switched（能力装配变化，非播报动作）
 * @returns 是否切换 + 切换后（未切换时为当前）场景对象
 */
export function resolveEvent(ev: unknown): { changed: boolean; scenario: Scenario } {
  const matched = matchScenario(ev);
  if (!matched || matched.id === current) return { changed: false, scenario: getCurrentScenario() };
  current = matched.id;
  saveState(matched.id);
  // scene:switched 事件（监听者：skills 按集合重载 + 可选 notify 级表达）
  emitEvent({ type: "scene:switched", source: "scenarios", payload: { scenario: matched.id, skills: matched.skills } });
  return { changed: true, scenario: matched };
}

/** 强制回到默认场景（面试结束等显式收尾；测试也用） */
export function resetScenario(): { changed: boolean; scenario: Scenario } {
  const prev = current;
  current = "default";
  if (prev !== "default") {
    saveState("default");
    emitEvent({ type: "scene:switched", source: "scenarios", payload: { scenario: "default", skills: [] } });
  }
  return { changed: prev !== "default", scenario: getCurrentScenario() };
}
