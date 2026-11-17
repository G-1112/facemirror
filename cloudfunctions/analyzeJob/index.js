// 岗位分析（深度面试 · 第 2 步）：目标岗位 → 核心能力要求与考察维度
// 输出：{ competency: CompetencyModel }
const cloud = require("wx-server-sdk");
const { callLLM } = require("./llm");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 深度面试的 6 个评估维度（顺序与前端 utils/interview.ts 的 DEEP_DIMENSIONS 一致） */
const DIMENSION_KEYS = [
  "technicalDepth",
  "projectAuthenticity",
  "businessInsight",
  "problemSolving",
  "jobFit",
  "communication",
];

/**
 * LLM 输出字符清洗（2026-11-17）：DeepSeek 偶发夹带 emoji / 特殊符号，
 * 小程序端字体缺字形会渲染成「�◆◆」豆腐块 → 在归一化处统一剥离。
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

const JOB_SYSTEM = `你是一位资深技术面试官。根据目标岗位，推导该岗位的核心能力要求与考察维度。

要求：
1. 只输出 JSON 对象：
   {
     "role": "岗位名称",
     "level": "职级",
     "industry": "行业",
     "interviewerStyle": "面试官风格与提问偏好，一句话",
     "competencies": [
       {
         "key": "technicalDepth",
         "name": "技术深度",
         "weight": 0.25,
         "focusPoints": ["该岗位在此维度上具体考察什么，3-5 条"],
         "expectedLevel": "该职级应达到的具体水平，一句话"
       }
     ]
   }
2. competencies **必须且只能包含**这 6 个 key：${DIMENSION_KEYS.join(", ")}
3. weight 为 0-1 之间的数字，6 个维度权重之和应为 1
4. focusPoints 要贴合该岗位的**具体技术栈/业务场景**，不要写放之四海皆准的空话`;

/** 无 LLM 时的确定性兜底：按岗位名做关键词推断，保证功能不中断 */
function mockCompetency(job) {
  const role = String(job.role || "").trim();
  const isBackend = /后端|服务端|后台|后端开发|java|go|python/i.test(role);
  const isFrontend = /前端|web|客户端|android|ios|移动端/i.test(role);
  const isAlgo = /算法|机器学习|ai|大模型|nlp|数据/i.test(role);
  const isData = /数据|数仓|数据仓库|分析|bi/i.test(role);

  const stack = isBackend
    ? ["服务设计与接口定义", "数据库选型与索引优化", "缓存与一致性", "并发与消息队列", "线上问题排查"]
    : isFrontend
      ? ["组件化与状态管理", "首屏与包体积优化", "渲染性能与内存泄漏", "跨端兼容", "交互细节与可访问性"]
      : isAlgo
        ? ["特征工程与数据泄漏", "模型选型与调参", "离线/在线指标一致性", "工程化落地与推理成本", "实验设计"]
        : isData
          ? ["指标口径与数据质量", "数仓分层建模", "SQL 性能与调优", "BI 可视化表达", "业务归因分析"]
          : ["问题拆解与优先级判断", "跨部门协作", "数据驱动决策", "风险识别与预案", "复盘与迭代"];

  const weights = isAlgo
    ? [0.3, 0.2, 0.12, 0.2, 0.12, 0.06]
    : isBackend || isFrontend
      ? [0.25, 0.2, 0.12, 0.2, 0.13, 0.1]
      : [0.16, 0.18, 0.22, 0.2, 0.16, 0.08];

  const names = {
    technicalDepth: "技术深度",
    projectAuthenticity: "项目真实性",
    businessInsight: "业务理解",
    problemSolving: "问题解决",
    jobFit: "岗位匹配",
    communication: "表达沟通",
  };
  const generic = [
    "该维度的核心考察点，能结合岗位场景说明",
    "遇到复杂约束时的取舍逻辑",
    "方案的量化收益与验证方式",
    "与该职级期望水平的差距",
  ];

  return {
    role,
    level: String(job.level || "").trim(),
    industry: String(job.industry || "").trim(),
    interviewerStyle: "关注简历细节与数字口径，追问方案选型理由",
    competencies: DIMENSION_KEYS.map((key, i) => ({
      key,
      name: names[key],
      weight: weights[i],
      focusPoints: key === "technicalDepth" ? stack : generic,
      expectedLevel: `达到该岗位${job.level || "对应职级"}的预期水平，能独立讲清并给出依据`,
    })),
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新登录" };

  const job = event.job || {};
  const role = String(job.role || "").trim();
  if (!role) return { error: "请填写目标岗位名称" };
  if (role.length > 40) return { error: "岗位名称过长（限 40 字）" };

  const level = String(job.level || "").trim().slice(0, 30);
  const industry = String(job.industry || "").trim().slice(0, 30);
  const extra = String(job.extra || "").trim().slice(0, 300);

  const userPrompt = `【目标岗位】\n岗位名称：${role}\n职级：${level || "未填写"}\n行业方向：${industry || "未填写"}\n补充要求：${extra || "无"}`;

  let competency;
  try {
    const raw = await callLLM(JOB_SYSTEM, userPrompt, { json: true, temperature: 0.2 });
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed && parsed.competencies) ? parsed.competencies : [];
    // 归一化：只接受这 6 个合法 key，缺项用 mock 补齐 → 保证 6 维齐全（前端雷达图要求长度恒为 6）
    const byKey = {};
    for (const c of list) {
      if (!c || typeof c !== "object") continue;
      const k = String(c.key || "");
      if (DIMENSION_KEYS.indexOf(k) >= 0 && !byKey[k]) byKey[k] = c;
    }
    const fallback = mockCompetency({ role, level, industry });
    const competencies = DIMENSION_KEYS.map((k, i) => {
      const c = byKey[k];
      if (!c) return fallback.competencies[i];
      const weight = Number(c.weight);
      const name = typeof c.name === "string" ? sanitizeLlmText(c.name) : "";
      const expectedLevel = typeof c.expectedLevel === "string" ? sanitizeLlmText(c.expectedLevel) : "";
      return {
        key: k,
        name: name || fallback.competencies[i].name,
        weight: isFinite(weight) && weight > 0 ? Math.min(1, weight) : fallback.competencies[i].weight,
        focusPoints: Array.isArray(c.focusPoints)
          ? c.focusPoints
              .filter((x) => typeof x === "string" && x.trim())
              .map((x) => sanitizeLlmText(x))
              .filter((x) => x)
              .slice(0, 6)
          : fallback.competencies[i].focusPoints,
        expectedLevel: expectedLevel || fallback.competencies[i].expectedLevel,
      };
    });
    competency = {
      role: typeof parsed.role === "string" && parsed.role.trim() ? sanitizeLlmText(parsed.role) || role : role,
      level: typeof parsed.level === "string" ? sanitizeLlmText(parsed.level) : level,
      industry: typeof parsed.industry === "string" ? sanitizeLlmText(parsed.industry) : industry,
      interviewerStyle: (() => {
        const s = typeof parsed.interviewerStyle === "string" ? sanitizeLlmText(parsed.interviewerStyle) : "";
        return s || fallback.interviewerStyle;
      })(),
      competencies,
    };
  } catch (e) {
    console.warn("LLM 岗位分析失败，降级规则模板:", e.message);
    competency = mockCompetency({ role, level, industry });
  }

  return { competency };
};

exports.sanitizeLlmText = sanitizeLlmText;
