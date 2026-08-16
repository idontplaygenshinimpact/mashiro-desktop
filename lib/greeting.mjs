// 投递招呼语生成器：从简历画像/原文提取优势 → 生成"展示优势"的打招呼文案
// 设计：规则提取（快、免费、可测、无 LLM 依赖）；面板/投递时自动使用，可用 LLM 精修
// 数据源：settings.resume_skills（技能标签+方向）+ settings.resume_raw（简历原文）
import { db } from "./db.mjs";
import { getCareerProfile, directionLabel } from "./career.mjs";

/** 读简历画像快照（无简历返回 null） */
export function getResumeSnapshot() {
  try {
    const s = db.prepare("SELECT value FROM settings WHERE key='resume_skills'").get();
    const raw = db.prepare("SELECT value FROM settings WHERE key='resume_raw'").get();
    if (!s && !raw) return null;
    return {
      skills: (() => { try { return JSON.parse(String(s.value)).skills || []; } catch { return []; } })(),
      directions: (() => { try { return JSON.parse(String(s.value)).directions || []; } catch { return []; } })(),
      raw: raw ? (JSON.parse(String(raw.value))?.text || "") : "",
    };
  } catch { return null; }
}

/** 从简历原文提取亮点字段（规则正则，取第一个命中） */
export function extractResumeHighlights(raw) {
  const out = { school: "", internCompany: "", project: "", quant: "" };
  if (!raw) return out;
  const s = raw.replace(/\s+/g, " ");
  // 学校：xx大学/学院；简历头部出现"211"则标注（如"211 计算机本科"）
  const school = s.match(/([\u4e00-\u9fa5]{2,12}(?:大学|学院))/);
  if (school) out.school = school[1] + (/211/.test(s.slice(0, 120)) ? "（211）" : "");
  // 实习公司：实习经历段落里 ｜ 前的公司名（含科技/数据等后缀）
  const intern = s.match(/实习经历.{0,60}?([\u4e00-\u9fa5A-Za-z（）()·]{2,24}?(?:科技|数据|信息|智能|网络|软件|技术)有限公司)/);
  if (intern) out.internCompany = intern[1];
  // 项目：项目经历段落第一个「名称｜」或「名称（…）」
  const proj = s.match(/项目经历.{0,30}?([A-Za-z][\w /]{2,30}|[\u4e00-\u9fa5A-Za-z]{2,20})[（(]?[｜|]/);
  if (proj) out.project = proj[1].trim();
  // 量化亮点：单测/E2E/体积优化 > 已部署（按说服力优先级，避免先命中"已部署"）
  const quant =
    s.match(/(\d+\s*单测)/)?.[1] ||
    s.match(/(\d+\s*E2E)/)?.[1] ||
    s.match(/(首屏.{0,20}?kB)/)?.[1] ||
    s.match(/(已部署)/)?.[1] ||
    "";
  if (quant) out.quant = quant.replace(/\s+/g, " ");
  return out;
}

/**
 * 生成展示优势的投递招呼语（~120 字，BOSS 打招呼风格，1-3 句）
 * @param {{ company?: string, title?: string }} [job] 岗位信息（可选，用于点名岗位）
 * @returns {string} 招呼语文案；无简历时退回简洁默认
 */
export function buildGreeting({ company = "", title = "" } = {}) {
  const snap = getResumeSnapshot();
  const dirLabel = directionLabel(); // 方向中文标签（转方向/开源自动跟随，不再写死"前端"）
  if (!snap) {
    return `您好，我是${dirLabel}方向应届生，对贵司该岗位很感兴趣，这是我的简历，期待进一步沟通。`;
  }
  const hl = extractResumeHighlights(snap.raw);
  const skills = (snap.skills || []).slice(0, 4).join(" / ");

  // 逐句拼装（只放真实存在的优势，避免空话）
  const parts = [];
  // 1) 身份 + 教育 + 实习
  const identity = [];
  if (hl.school) identity.push(hl.school);
  if (hl.internCompany) identity.push(`${hl.internCompany}${dirLabel}实习`);
  else if (snap.directions?.length) identity.push(`${dirLabel}方向`);
  if (skills) identity.push(`熟悉 ${skills}`);
  parts.push(`您好！我是${identity.join(" · ")}。`);
  // 2) 项目亮点（最能打动 HR 的部分）
  if (hl.project) {
    const proj = hl.quant
      ? `独立开发过 ${hl.project}（${hl.quant}），对工程化与${dirLabel}应用有实战经验`
      : `独立开发过 ${hl.project}，有完整${dirLabel}项目落地经验`;
    parts.push(proj + "。");
  } else if (hl.quant) {
    parts.push(`有扎实的${dirLabel}项目落地经验（${hl.quant}）。`);
  }
  // 3) 岗位意向 + 结尾
  const post = title ? `对贵司「${String(title).slice(0, 20)}」${company ? `（${String(company).slice(0, 15)}）` : ""}很感兴趣` : "对贵司岗位很感兴趣";
  parts.push(`${post}，期待进一步沟通，随时可以约面～`);
  return parts.join("");
}

/**
 * LLM 精修招呼语（可选：面板「✨ 生成」按钮用；投递链路默认走规则版，保证快且免费）
 * @param {{ company?: string, title?: string, summary?: string }} [job]
 * @returns {Promise<string>} 精修后的文案（LLM 失败时退回规则版）
 */
export async function polishGreeting({ company = "", title = "", summary = "" } = {}) {
  const base = buildGreeting({ company, title });
  try {
    const { llmChat, getReplyText } = await import("./llm.mjs");
    const snap = getResumeSnapshot();
    const skills = snap?.skills?.length ? snap.skills.join("、") : "";
    const data = await llmChat([
      { role: "system", content: "你是资深求职顾问。把招呼语改写得更有吸引力、更真诚，突出候选人优势与岗位契合点。要求：80-130 字、2-3 句、口语自然、不浮夸不造假、不出现 emoji 和 Markdown。只输出改写后的招呼语本身。" },
      {
        role: "user",
        content: `候选人技能：${skills || "未提供"}\n岗位：${title || "未知"}（${company || "未知公司"}）${summary ? `\n岗位要求：${String(summary).slice(0, 300)}` : ""}\n\n原始招呼语：\n${base}`,
      },
    ], { maxTokens: 300, temperature: 0.6 });
    const text = getReplyText(data).trim();
    if (text && text.length >= 20 && text.length <= 300) return text;
    return base;
  } catch {
    return base; // LLM 失败退回规则版
  }
}
