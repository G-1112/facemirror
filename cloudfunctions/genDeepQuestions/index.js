// 深度面试出题（深度面试 · 第 3 步）：简历 + 岗位能力标准 → 15~20 道强关联面试题
// 输出：{ questions: InterviewQuestion[], coverage: {...} }
const cloud = require("wx-server-sdk");
const { checkText } = require("./sec-check");
const { callLLM } = require("./llm");
const { escapeForPrompt, scanInjection } = require("./injection");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 题目数量区间（与前端 utils/interview.ts 的 MIN/MAX_QUESTIONS 保持一致） */
const MIN_QUESTIONS = 15;
const MAX_QUESTIONS = 20;

const DIMENSION_KEYS = [
  "technicalDepth",
  "projectAuthenticity",
  "businessInsight",
  "problemSolving",
  "jobFit",
  "communication",
];
const TYPE_KEYS = ["project", "technical", "business", "scenario", "behavior"];
const DIFFICULTIES = ["简单", "中等", "困难"];

/**
 * LLM 输出字符清洗（与 analyzeJob/index.js 同款副本，云函数不能跨目录 require）：
 * DeepSeek 偶发夹带 emoji / 特殊符号，小程序端字体缺字形渲染成「�◆◆」豆腐块 → 归一化时统一剥离。
 * 保留：CJK、ASCII、CJK 标点、①②③ 等带圈序号、常规全角标点。
 */
const RE_EMOJI = /\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF]/g;
const RE_SYMBOL = /[\u2190-\u21FF\u2300-\u23FF\u2500-\u25FF\u2600-\u27BF\u2900-\u297F\u2B00-\u2BFF\u3000-\u3005\uFE0F\u200D\u20E3\uE000-\uF8FF]/g;
const RE_CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/g;
function sanitizeLlmText(s) {
  return String(s == null ? "" : s)
    .replace(RE_EMOJI, "")
    .replace(RE_SYMBOL, "")
    .replace(RE_CTRL, "")
    .replace(/[\uD800-\uDFFF]/g, "") // 清洗后残留的孤立代理对
    .trim();
}

const GEN_SYSTEM = `你是一位严格的技术面试官，正在基于候选人的**简历**和**目标岗位**出面试题。

要求：
1. 输出 18 道题（JSON 数组），每项结构：
   {
     "question": "面试题正文",
     "type": "project|technical|business|scenario|behavior",
     "difficulty": "简单|中等|困难",
     "competency": "technicalDepth|projectAuthenticity|businessInsight|problemSolving|jobFit|communication",
     "evidence": "该题对应的简历锚点：具体项目名/公司/数字/技术名",
     "followups": ["追问1","追问2"],
     "keyPoints": ["参考答案要点1","要点2","要点3"]
   }
2. **每道题都必须与简历内容强关联**：evidence 必须指向简历中真实出现的项目、经历、比赛或数字。
   禁止问「介绍一下你自己」「你的优缺点」这类与简历无关的通用题。
3. 五种类型要覆盖均衡：项目细节 4-5 道、技术理解 4-5 道、业务理解 3-4 道、场景问题 3-4 道、行为面试 2-3 道。
4. keyPoints 是**参考答案的得分点**（3-4 条），不是完整答案。
5. 优先攻击简历中最薄弱处：数据缺对比、结论缺依据、技术选型未说明理由、职责边界模糊。
6. 难度分布：简单 3-4 道、中等 8-10 道、困难 3-5 道。
7. 只输出 JSON 数组，不要任何额外说明文字。`;

/** 把结构化简历压成给 LLM 看的文本（控制长度，优先保留项目/经历/获奖/技能） */
function resumeToText(resume) {
  if (!resume || typeof resume !== "object") return "";
  const lines = [];
  if (resume.summary) lines.push(`概述：${resume.summary}`);
  (resume.education || []).forEach((e) => {
    lines.push(`教育：${[e.school, e.major, e.degree, e.period].filter(Boolean).join(" ")}`);
  });
  (resume.experiences || []).forEach((e) => {
    lines.push(
      `经历：${[e.org, e.role, e.period].filter(Boolean).join(" ")}` +
        (e.duties && e.duties.length ? ` 职责:${e.duties.join("、")}` : "") +
        (e.achievements && e.achievements.length ? ` 成果:${e.achievements.join("、")}` : "")
    );
  });
  (resume.projects || []).forEach((p) => {
    lines.push(
      `项目：${[p.name, p.role, p.period].filter(Boolean).join(" ")}` +
        (p.tech && p.tech.length ? ` 技术:${p.tech.join("、")}` : "") +
        (p.desc ? ` 描述:${p.desc}` : "") +
        (p.metrics && p.metrics.length ? ` 指标:${p.metrics.join("、")}` : "")
    );
  });
  (resume.awards || []).forEach((a) => {
    lines.push(`获奖：${[a.name, a.level, a.period, a.issuer].filter(Boolean).join(" ")}`);
  });
  const s = resume.skills || {};
  const skillLine = [
    ...(s.languages || []),
    ...(s.frameworks || []),
    ...(s.tools || []),
    ...(s.concepts || []),
  ];
  if (skillLine.length) lines.push(`技能：${skillLine.join("、")}`);
  return lines.join("\n");
}

/** 模板题：LLM 题目不足 MIN_QUESTIONS 时，用简历锚点补齐（保证用户永远拿到足量题） */
function templateQuestions(resume) {
  const out = [];
  const push = (q) => out.push(q);
  const projects = (resume && resume.projects) || [];
  const experiences = (resume && resume.experiences) || [];
  const awards = (resume && resume.awards) || [];
  const skills = (resume && resume.skills) || {};
  const allTech = [
    ...(skills.languages || []),
    ...(skills.frameworks || []),
    ...(skills.tools || []),
  ];

  projects.slice(0, 4).forEach((p) => {
    const name = p.name || "该项目";
    push({
      question: `请说明你在「${name}」中承担的具体职责边界：你独立负责的部分是什么，与其他成员如何分工？`,
      type: "project",
      difficulty: "简单",
      competency: "projectAuthenticity",
      evidence: `项目：${name}`,
      followups: ["如果去掉你的工作，这个项目会有什么不同？"],
      keyPoints: ["说清职责边界", "给出协作方式", "强调个人不可替代的产出"],
    });
    push({
      question: `「${name}」中最难的技术决策是什么？你比较过哪些方案，最终为什么选它？`,
      type: "technical",
      difficulty: "困难",
      competency: "technicalDepth",
      evidence: `项目：${name}${p.tech && p.tech.length ? `（技术：${p.tech.join("、")}）` : ""}`,
      followups: ["如果约束条件变了（规模/时间/成本），你的选择会改吗？"],
      keyPoints: ["给出至少两种候选方案", "说明选型判据", "承认方案的代价与局限"],
    });
  });

  experiences.slice(0, 3).forEach((e) => {
    const org = e.org || "该段经历";
    push({
      question: `在${org}期间，你遇到的最大一次线上或业务问题是什么？你是如何定位并解决的？`,
      type: "behavior",
      difficulty: "中等",
      competency: "problemSolving",
      evidence: `经历：${org}${e.role ? ` ${e.role}` : ""}`,
      followups: ["事后你做了什么机制来避免复发？"],
      keyPoints: ["结构：现象→定位→行动→结果", "说明定位手段", "给出可量化结果", "有复盘机制"],
    });
  });

  awards.slice(0, 2).forEach((a) => {
    push({
      question: `你在「${a.name || "该项竞赛"}」中负责的哪一部分？评委最终看重的关键点是什么，你做对了什么？`,
      type: "behavior",
      difficulty: "中等",
      competency: "jobFit",
      evidence: `获奖：${a.name || ""} ${a.level || ""}`,
      followups: ["如果重新参赛，你会改进什么？"],
      keyPoints: ["明确个人贡献", "说清评审偏好", "有复盘和改进点"],
    });
  });

  allTech.slice(0, 3).forEach((t) => {
    push({
      question: `你在简历中提到使用 ${t}。请说明你用它解决了什么具体问题，以及它的局限在哪里。`,
      type: "technical",
      difficulty: "中等",
      competency: "technicalDepth",
      evidence: `技能：${t}`,
      followups: ["有没有考虑过用其他方案？"],
      keyPoints: ["讲清具体使用场景", "说明收益", "指出局限与替代方案"],
    });
  });

  push({
    question: `如果让你用一周时间把「${projects[0] ? projects[0].name : "简历中第一个项目"}」从当前状态再提升一档，你优先做什么？为什么？`,
    type: "scenario",
    difficulty: "困难",
    competency: "businessInsight",
    evidence: projects[0] ? `项目：${projects[0].name}` : "简历整体",
    followups: ["你会如何衡量这次改进是否成功？"],
    keyPoints: ["先给判断标准", "说明优先级依据", "给出可衡量的指标"],
  });

  push({
    question: `你简历中这些经历之间，哪一段对目标岗位最有说服力？为什么？`,
    type: "behavior",
    difficulty: "简单",
    competency: "jobFit",
    evidence: "简历整体",
    followups: ["这段经历体现了岗位的哪项要求？"],
    keyPoints: ["与岗位要求直接挂钩", "举出具体证据", "不泛泛而谈"],
  });

  return out;
}

/** 归一化单题：字段缺失补默认、类型白名单过滤、题干去空格、剥离 emoji/特殊符号 */
function normalizeQuestion(q, index, fallbackEvidence) {
  if (!q || typeof q !== "object") return null;
  const question = typeof q.question === "string" ? sanitizeLlmText(q.question) : "";
  if (!question) return null;
  const strArr = (v) =>
    Array.isArray(v)
      ? v
          .filter((x) => typeof x === "string" && x.trim())
          .map((x) => sanitizeLlmText(x))
          .filter((x) => x)
      : [];
  const type = TYPE_KEYS.indexOf(q.type) >= 0 ? q.type : "project";
  const difficulty = DIFFICULTIES.indexOf(q.difficulty) >= 0 ? q.difficulty : "中等";
  const competency = DIMENSION_KEYS.indexOf(q.competency) >= 0 ? q.competency : "technicalDepth";
  const evidence = typeof q.evidence === "string" ? sanitizeLlmText(q.evidence) : "";
  return {
    id: `q${index + 1}`,
    question,
    type,
    difficulty,
    competency,
    evidence: evidence || fallbackEvidence || "简历内容",
    followups: strArr(q.followups).slice(0, 3),
    keyPoints: strArr(q.keyPoints).slice(0, 5),
    estimatedSec: 120,
  };
}

/** 频率限制：每用户每小时 8 次 */
async function rateLimited(openid, limit = 8, windowMs = 60 * 60 * 1000) {
  const db = cloud.database();
  try {
    const res = await db
      .collection("rate_limits")
      .where({ openid, ts: db.command.gte(Date.now() - windowMs) })
      .count();
    if (res && res.total >= limit) return true;
    await db.collection("rate_limits").add({ data: { openid, ts: Date.now(), action: "genDeepQuestions" } });
    return false;
  } catch (e) {
    console.warn("限流记录失败（不阻塞）:", e.message);
    return false;
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新登录" };

  const { resume, job, competency } = event;
  if (!resume || typeof resume !== "object") return { error: "缺少简历信息" };
  if (!job || !String(job.role || "").trim()) return { error: "缺少目标岗位信息" };

  const resumeText = resumeToText(resume);
  if (!resumeText || resumeText.length < 20) {
    return { error: "简历内容过少，无法生成针对性题目，请补充简历信息" };
  }

  // 用户修正后的简历仍是 UGC → 再过一次内容安全
  try {
    await checkText(resumeText, {
      openid: OPENID,
      scene: 2,
      rejectMessage: "简历内容包含违规信息，请修改后重新提交",
    });
  } catch (e) {
    return { error: (e && e.message) || "简历内容包含违规信息，请修改后重新提交" };
  }

  if (await rateLimited(OPENID)) {
    return { error: "出题过于频繁，请稍后再试" };
  }

  const jobDesc = [
    `岗位：${job.role}`,
    job.level ? `职级：${job.level}` : "",
    job.industry ? `行业：${job.industry}` : "",
    job.extra ? `补充：${job.extra}` : "",
  ]
    .filter(Boolean)
    .join("｜");

  const compDesc = (competency && Array.isArray(competency.competencies) ? competency.competencies : [])
    .map((c) => `${c.name}(权重${c.weight}) 考察点:${(c.focusPoints || []).join("、")}`)
    .join("\n");

  const injectionHits = scanInjection(resumeText);

  let rawQuestions = [];
  let source = "ai";
  if (injectionHits.length > 0) {
    console.warn("简历命中注入特征，降级模板出题:", injectionHits.slice(0, 3));
    source = "template";
  } else {
    try {
      const userPrompt =
        `【候选人简历】\n${escapeForPrompt(resumeText)}\n\n` +
        `【目标岗位】\n${escapeForPrompt(jobDesc)}\n\n` +
        `【岗位考察维度】\n${escapeForPrompt(compDesc || "（未提供维度，按通用技术岗出题）")}\n\n` +
        `请基于以上信息出 18 道面试题。`;
      const raw = await callLLM(GEN_SYSTEM, userPrompt, { json: true, temperature: 0.35 });
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("LLM 未返回数组");
      rawQuestions = parsed;
    } catch (e) {
      console.warn("LLM 出题失败，降级模板题:", e.message);
      source = "template";
    }
  }

  // 归一化 + 题干去重（LLM 可能重复出题）
  const seen = new Set();
  const normalized = [];
  const fallbackEvidence = (resume.projects && resume.projects[0] && resume.projects[0].name) || "简历内容";
  for (const q of rawQuestions) {
    const n = normalizeQuestion(q, normalized.length, fallbackEvidence);
    if (!n) continue;
    const key = n.question.replace(/\s+/g, "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(n);
  }

  // ★数量补齐：不足 MIN_QUESTIONS 时用模板题补，绝不返回少于下限的题量
  const templates = templateQuestions(resume);
  for (const t of templates) {
    if (normalized.length >= MIN_QUESTIONS) break;
    const key = t.question.replace(/\s+/g, "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(normalizeQuestion(t, normalized.length, fallbackEvidence));
  }

  // 极端情况：简历几乎没内容 → 模板题也不够，用「岗位通用题」兜底到下限
  if (normalized.length < MIN_QUESTIONS) {
    const generic = [
      ["请介绍一个最能代表你能力的项目，以及你在其中的角色。", "project", "projectAuthenticity"],
      ["你遇到过的最棘手的技术问题是什么？如何解决的？", "technical", "problemSolving"],
      ["讲一次你在团队中意见不一致的经历，最后怎么处理的？", "behavior", "communication"],
      ["如果让你从零设计一个同类系统，你会怎么开始？", "scenario", "technicalDepth"],
      ["你对这个岗位的理解是什么？入职前三个月你想做成什么？", "behavior", "jobFit"],
      ["你所在项目/业务的用户是谁？他们最关心什么？", "business", "businessInsight"],
      ["一次线上问题排查中，你用了什么方法快速缩小范围？", "technical", "problemSolving"],
      ["你如何判断一个技术方案是否值得做？", "business", "businessInsight"],
      ["讲一次你主动推动的改进，最终效果如何？", "behavior", "projectAuthenticity"],
      ["你最近在学习什么新技术？打算怎么用到工作里？", "project", "jobFit"],
      ["多线程/并发场景下你遇到过什么问题？", "technical", "technicalDepth"],
      ["你如何衡量自己工作的产出价值？", "business", "businessInsight"],
      ["团队里你承担过什么超出本职的工作？", "behavior", "communication"],
      ["描述一次需求变更带来的影响，你如何应对？", "scenario", "problemSolving"],
      ["你与不同角色（产品/测试/上级）协作时最大的挑战是什么？", "behavior", "communication"],
      ["如果让你负责这个岗位的第一个月，你会优先了解什么？", "scenario", "jobFit"],
      ["你怎么理解这个岗位的核心产出是什么？", "business", "businessInsight"],
      ["讲一次你被否掉意见的经历，后来怎么处理的？", "behavior", "communication"],
    ];
    for (const [q, t, c] of generic) {
      if (normalized.length >= MIN_QUESTIONS) break;
      const key = q.replace(/\s+/g, "").slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(
        normalizeQuestion(
          { question: q, type: t, competency: c, difficulty: "中等", evidence: "简历信息有限，题目偏通用", keyPoints: ["结合自己的真实经历回答", "给出具体细节", "有量化结果"] },
          normalized.length,
          fallbackEvidence
        )
      );
    }
  }

  // 截断到上限（保持题干顺序，LLM 出的前 N 道优先）
  const questions = normalized.slice(0, MAX_QUESTIONS);
  // 重排 id，保证连续
  questions.forEach((q, i) => {
    q.id = `q${i + 1}`;
  });

  // 覆盖度统计：让前端能展示「本题库覆盖了哪些能力维度、哪些题型」
  const coverage = { byType: {}, byCompetency: {}, byDifficulty: {} };
  for (const q of questions) {
    coverage.byType[q.type] = (coverage.byType[q.type] || 0) + 1;
    coverage.byCompetency[q.competency] = (coverage.byCompetency[q.competency] || 0) + 1;
    coverage.byDifficulty[q.difficulty] = (coverage.byDifficulty[q.difficulty] || 0) + 1;
  }

  return {
    questions,
    coverage,
    source,
    // 题目不足下限（极端兜底后仍不够）时如实告知前端，不静默
    countWarning: questions.length < MIN_QUESTIONS ? `题目数量偏少（${questions.length} 道），建议补充简历信息后重新生成` : "",
  };
};
