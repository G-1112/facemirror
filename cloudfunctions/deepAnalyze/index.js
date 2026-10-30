// 深度面试总结（深度面试 · 最后一步）：全部回答 + 简历 → 分项能力得分 / 雷达 / 优势短板 / 优化建议
// 输出：{ report: DeepReport }
const cloud = require("wx-server-sdk");
const { callLLM } = require("./llm");
const { escapeForPrompt, scanInjection } = require("./injection");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COL = "interviews";
const DIMENSION_KEYS = [
  "technicalDepth",
  "projectAuthenticity",
  "businessInsight",
  "problemSolving",
  "jobFit",
  "communication",
];
const DIMENSION_NAMES = {
  technicalDepth: "技术深度",
  projectAuthenticity: "项目真实性",
  businessInsight: "业务理解",
  problemSolving: "问题解决",
  jobFit: "岗位匹配",
  communication: "表达沟通",
};

/**
 * 从异常里提取错误码（errCode / errcode / errMsg 里的数字）。
 * ⚠️ 云函数之间不能跨目录 require，所以本文件内联一份与 deepSession 相同的副本
 *    （深链接云函数不能共享模块，只能靠"同源复制 + md5 校验"保持一致）。
 */
function extractCode(err) {
  if (!err) return "";
  const direct = err.errCode != null ? err.errCode : err.errcode;
  if (direct != null && direct !== "") return String(direct).trim();
  const raw = String(err.errMsg || err.message || "");
  const m = raw.match(/-?\d{6}/);
  return m ? m[1] : "";
}

/**
 * 把底层数据库异常翻译成**用户能据此行动**的文案。
 * 集合 `interviews` 未建时抛 -502005，原实现统一返回「面试记录不存在，请重新开始」，
 * 会让用户误以为自己操作错了 —— 实际是部署漏建集合（集合需手动建，不在部署脚本覆盖范围）。
 */
function describeDbError(err, fallback) {
  const code = extractCode(err);
  if (code === "-502005") {
    return "数据库集合 interviews 不存在，请先在云开发控制台创建该集合（权限选「仅创建者可读写」）";
  }
  if (code === "-502003") {
    return "数据库权限校验失败，请检查 interviews 集合的权限设置";
  }
  console.error("[deepAnalyze] 数据库异常 code=" + (code || "?"), err && (err.errMsg || err.message));
  // ★兜底文案必须携带真实错误码（2026-10-29 联调实测教训，与 deepSession 同源同步）：
  //   未识别的数据库错误码只会返回笼统「请重试」→ 用户无法定位、反复空重试。
  //   -502001 是通用包装码，真实原因在底层 errMsg → 一并透传。
  const detail = String((err && (err.errMsg || err.message)) || "").replace(/\s+/g, " ").trim().slice(0, 120);
  return (
    fallback +
    "（数据库错误码 " + (code || "未知") +
    (detail ? "：" + detail : "") +
    "）"
  );
}

const SUMMARY_SYSTEM = `你是资深面试评审。基于候选人的简历、目标岗位和**全部回答记录**，产出结构化面试总结。

要求：
1. 只输出 JSON 对象：
   {
     "dimensions": {"technicalDepth":1-5, "projectAuthenticity":1-5, "businessInsight":1-5, "problemSolving":1-5, "jobFit":1-5, "communication":1-5},
     "strengths": [{"dimension":"维度名","text":"表现好的具体点","evidence":"支撑证据（引用回答或简历细节）"}],
     "weaknesses": [{"dimension":"维度名","text":"明显短板","evidence":"短板证据"}],
     "knowledgeGaps": [{"topic":"需补强的知识/技能","reason":"为什么需要补","resource":"推荐的学习路径或资料方向"}],
     "resumeTips": ["简历优化点，3-5 条"],
     "expressionTips": ["面试表达改进方向，3-5 条"],
     "practiceSuggestions": ["推荐练习方向，2-4 条"],
     "overall": "150 字以内的综合评价"
   }
2. dimensions 必须包含这 6 个 key：${DIMENSION_KEYS.join(", ")}
3. strengths / weaknesses 各 2-4 条，必须**具体**，引用回答中的细节或简历中的项目/数字，禁止"沟通能力强"这类空话。
4. weaknesses 覆盖不同维度，不要都集中在同一个维度。`;

/** 无 LLM 时的确定性总结：直接按单题得分聚合，保证功能不中断 */
function mockReport(questions, answers, competency) {
  const dims = {};
  for (const k of DIMENSION_KEYS) dims[k] = [];
  for (const a of answers || []) {
    const q = (questions || []).find((x) => x && x.id === a.questionId);
    const key = q && DIMENSION_KEYS.indexOf(q.competency) >= 0 ? q.competency : "technicalDepth";
    dims[key].push(a.score || 3);
  }
  const dimensions = {};
  for (const k of DIMENSION_KEYS) {
    const arr = dims[k];
    dimensions[k] = arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 3;
  }
  const radar = DIMENSION_KEYS.map((k) => dimensions[k]);
  const totalScore = Math.round((radar.reduce((a, b) => a + b, 0) / 6) * 20);

  const sorted = DIMENSION_KEYS.map((k) => ({ k, v: dimensions[k] })).sort((a, b) => b.v - a.v);
  const strengths = sorted.slice(0, 2).map((s) => ({
    dimension: DIMENSION_NAMES[s.k],
    text: `在「${DIMENSION_NAMES[s.k]}」维度表现较好`,
    evidence: "基于本次回答的聚合得分",
  }));
  const weaknesses = sorted.slice(-2).reverse().map((s) => ({
    dimension: DIMENSION_NAMES[s.k],
    text: `「${DIMENSION_NAMES[s.k]}」是当前相对薄弱项`,
    evidence: "基于本次回答的聚合得分",
  }));

  const total = answers || [];
  const totalDurationSec = total.reduce((a, b) => a + (b.durationSec || 0), 0);
  return {
    totalScore,
    radar,
    dimensions,
    strengths,
    weaknesses,
    knowledgeGaps: [
      { topic: "答题框架（结论先行 + 证据支撑）", reason: "结构化表达直接影响面试官的追问路径", resource: "按 STAR 原则准备 3 个项目故事并复述录音" },
      { topic: "简历中量化指标的口径", reason: "指标口径不清是技术面最常见的追问点", resource: "为简历中每个数字补充基线、测量方法与对比对象" },
    ],
    resumeTips: ["为每个项目补充「个人职责 + 量化结果」", "技术栈按岗位相关性排序", "删除与岗位无关的内容，控制在 2 页内"],
    expressionTips: ["先给结论再讲过程，减少铺垫", "用具体数字替代模糊形容词", "讲完后用一句话收束结论"],
    practiceSuggestions: ["针对薄弱维度做专项题组练习", "用同一道题连续练习 3 次并对比录音"],
    overall: "（未配置 LLM，本报告基于单题得分的确定性聚合生成，维度点评粒度较粗。）",
    perQuestion: (questions || []).map((q) => {
      const a = (answers || []).find((x) => x && x.questionId === q.id);
      return {
        questionId: q.id,
        question: q.question,
        score: a ? a.score : 0,
        feedback: a ? a.feedback : "未作答",
        hit: a ? a.hit : [],
        missed: a ? a.missed : [],
      };
    }),
    stats: {
      answered: total.length,
      total: (questions || []).length,
      avgDurationSec: total.length ? Math.round(totalDurationSec / total.length) : 0,
      totalDurationSec,
    },
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新登录" };

  const { interviewId } = event;
  if (!interviewId || typeof interviewId !== "string") return { error: "缺少 interviewId" };

  let doc = null;
  try {
    const res = await db.collection(COL).doc(interviewId).get();
    doc = res && res.data;
  } catch (e) {
    // ⚠️ 必须区分「集合不存在(-502005)」与「文档不存在」：
    //    前者是部署漏建集合，必须明确告知，否则用户只看到
    //    「面试记录不存在，请重新开始」，会误以为自己操作错了。
    const code = extractCode(e);
    if (code === "-502005") {
      console.error("[deepAnalyze] 集合不存在 code=-502005");
      return { error: describeDbError(e, "面试记录不存在，请重新开始") };
    }
    return { error: "面试记录不存在，请重新开始" };
  }
  if (!doc) return { error: "面试记录不存在，请重新开始" };
  if (doc.openid !== OPENID) return { error: "无权访问该面试记录" };

  const questions = doc.questions || [];
  const answers = doc.answers || [];
  if (!questions.length) return { error: "尚未生成题目，无法总结" };
  if (!answers.length) return { error: "尚未作答，无法总结" };

  // 构造答题摘要（控制长度：最多取 40 题，每题答案截断 300 字）
  const answerSummary = answers
    .slice(0, 40)
    .map((a) => {
      const q = questions.find((x) => x && x.id === a.questionId);
      return (
        `【题】${q ? q.question : a.questionId}（维度:${q ? DIMENSION_NAMES[q.competency] || q.competency : "未知"}｜满分5｜得分${a.score}）\n` +
        `【答】${String(a.answer || "").slice(0, 300)}\n` +
        `【漏】${(a.missed || []).join("、") || "无"}`
      );
    })
    .join("\n\n");

  const resumeBrief = doc.resume
    ? JSON.stringify({
        summary: doc.resume.summary,
        projects: (doc.resume.projects || []).slice(0, 5).map((p) => `${p.name}/${p.tech || []}`),
        experiences: (doc.resume.experiences || []).slice(0, 4).map((e) => `${e.org}${e.role}`),
        awards: (doc.resume.awards || []).slice(0, 4).map((a) => a.name),
        skills: doc.resume.skills,
      })
    : "";
  const jobBrief = doc.job
    ? `${doc.job.role || ""}${doc.job.level ? " / " + doc.job.level : ""}${doc.job.industry ? " / " + doc.job.industry : ""}`
    : "";

  // 注入防护：所有用户内容都可能被写入指令
  const injectionHits = scanInjection(answerSummary);

  let report;
  if (injectionHits.length > 0) {
    console.warn("答题内容命中注入特征，使用确定性总结:", injectionHits.slice(0, 3));
    report = mockReport(questions, answers, doc.competency);
    report.injectionFlagged = true;
  } else {
    try {
      const userPrompt =
        `【简历】\n${escapeForPrompt(resumeBrief)}\n\n` +
        `【目标岗位】\n${escapeForPrompt(jobBrief)}\n\n` +
        `【全部回答】\n${escapeForPrompt(answerSummary)}\n\n` +
        `请产出面试总结。`;
      const raw = await callLLM(SUMMARY_SYSTEM, userPrompt, { json: true, temperature: 0.25 });
      const parsed = JSON.parse(raw) || {};

      // 维度分归一化：LLM 少给维度时用单题聚合分补齐 → 雷达长度恒为 6
      const base = mockReport(questions, answers, doc.competency);
      const dimensions = {};
      for (const k of DIMENSION_KEYS) {
        const n = Math.round(Number(parsed.dimensions && parsed.dimensions[k]));
        dimensions[k] = isFinite(n) ? Math.max(1, Math.min(5, n)) : base.dimensions[k];
      }
      const radar = DIMENSION_KEYS.map((k) => dimensions[k]);
      const totalScore = Math.round((radar.reduce((a, b) => a + b, 0) / 6) * 20);

      const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
      const objArr = (v) =>
        Array.isArray(v)
          ? v
              .filter((x) => x && typeof x === "object")
              .map((x) => ({
                dimension: typeof x.dimension === "string" ? x.dimension : "综合",
                text: typeof x.text === "string" ? x.text : "",
                evidence: typeof x.evidence === "string" ? x.evidence : "",
              }))
              .filter((x) => x.text)
          : [];

      report = {
        totalScore,
        radar,
        dimensions,
        strengths: objArr(parsed.strengths).slice(0, 4),
        weaknesses: objArr(parsed.weaknesses).slice(0, 4),
        knowledgeGaps: (Array.isArray(parsed.knowledgeGaps) ? parsed.knowledgeGaps : [])
          .filter((g) => g && typeof g === "object" && typeof g.topic === "string" && g.topic.trim())
          .slice(0, 5)
          .map((g) => ({
            topic: g.topic.trim(),
            reason: typeof g.reason === "string" ? g.reason : "",
            resource: typeof g.resource === "string" ? g.resource : "",
          })),
        resumeTips: strArr(parsed.resumeTips).slice(0, 5),
        expressionTips: strArr(parsed.expressionTips).slice(0, 5),
        practiceSuggestions: strArr(parsed.practiceSuggestions).slice(0, 4),
        overall: typeof parsed.overall === "string" && parsed.overall.trim() ? parsed.overall.trim() : base.overall,
        perQuestion: base.perQuestion,
        stats: base.stats,
      };

      // strengths/weaknesses 都为空 → 用确定性结果兜底，保证前端不出现空白区
      if (!report.strengths.length) report.strengths = base.strengths;
      if (!report.weaknesses.length) report.weaknesses = base.weaknesses;
      if (!report.knowledgeGaps.length) report.knowledgeGaps = base.knowledgeGaps;
      if (!report.resumeTips.length) report.resumeTips = base.resumeTips;
      if (!report.expressionTips.length) report.expressionTips = base.expressionTips;
      if (!report.practiceSuggestions.length) report.practiceSuggestions = base.practiceSuggestions;
    } catch (e) {
      console.warn("LLM 总结失败，使用确定性总结:", e.message);
      report = mockReport(questions, answers, doc.competency);
    }
  }

  // 幂等：已有报告直接返回，避免重复计费
  if (doc.status === "done" && doc.report) {
    return { report: doc.report };
  }

  try {
    await db.collection(COL).doc(interviewId).update({
      // ★report 必须用 _.set 整体覆盖（与 deepSession update 同根因，2026-10-30）：
      //   create 把 report 初始化为 null，云开发 update 深度合并会把对象展开成
      //   点路径 $set → 撞 null 父字段报「Cannot create field」→ -502001。
      data: { report: _.set(report), status: "done", updatedAt: Date.now() },
    });
  } catch (e) {
    console.error("保存总结失败:", e.message);
    return { error: describeDbError(e, "保存总结失败，请重试") };
  }

  return { report };
};
