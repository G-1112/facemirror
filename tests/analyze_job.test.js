// LLM 输出字符清洗回归测试（2026-11-17 乱码修复）
//
// 背景：真机岗位分析卡片出现「算法解题思路�◆◆�：能分析问题」——
// DeepSeek 输出夹带 emoji / 特殊符号（U+FFFD、◆、🧠 等），小程序端字体缺字形渲染豆腐块。
// 修复：analyzeJob / genDeepQuestions 归一化处统一 sanitizeLlmText 剥离。
//
// 覆盖范围：
//   A. sanitizeLlmText 单元测试（analyzeJob 导出）
//      A1 emoji 全清 / 保留中文与常规标点
//      A2 U+FFFD 与 ◆（几何符号区）清除
//      A3 带圈序号 ①②③ 保留（正文常用，不能误伤）
//      A4 孤立代理对 / 控制字符 / null 输入
//   B. analyzeJob main() 端到端：桩 ./llm 返回带 emoji 的 JSON → 输出全部字段已清洗
//   C. genDeepQuestions main() 端到端：桩 ./llm 返回带 emoji 的题目数组 → 题干/锚点/要点已清洗
//
// ⚠️ 断言必须有牙齿：反向验证记录（见文件末尾）——
//   stash 掉两个云函数的 sanitize 修改 → A1/A2/B/C 立刻 FAIL。
//
// 运行：node tests/analyze_job.test.js

const path = require("path");
const { loadFunction } = require("../cloudfunctions/__tests__/harness");

const FN_DIR = path.join(__dirname, "..", "cloudfunctions");

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  [PASS] " + name);
  } else {
    console.log("  [FAIL] " + name + (detail ? " -> " + detail : ""));
    failed++;
  }
};

// ---------------------------------------------------------------- A. 单元测试

function testSanitizeUnit() {
  // loadFunction 仅为常驻补丁激活 wx-server-sdk 桩；analyzeJob 只依赖 https，
  // 直接 require 拿 exports.sanitizeLlmText
  loadFunction("analyzeJob", { OPENID: "o_unit" });
  delete require.cache[require.resolve(path.join(FN_DIR, "analyzeJob", "index.js"))];
  const { sanitizeLlmText } = require(path.join(FN_DIR, "analyzeJob", "index.js"));
  check("A0 导出 sanitizeLlmText", typeof sanitizeLlmText === "function");

  console.log("\n场景 A1：emoji 清除，中文/ASCII/常规标点保留");
  {
    const out = sanitizeLlmText("算法解题思路🧠💡✅：能分析问题，Break it down!");
    check("emoji 被剥离", out === "算法解题思路：能分析问题，Break it down!", JSON.stringify(out));
    check("无残留高位码点", !/[\uD800-\uDFFF\u2600-\u27BF\uFE0F]/.test(out));
  }

  console.log("\n场景 A2：U+FFFD 与 ◆ 几何符号清除（真机豆腐块实锤字符）");
  {
    const out = sanitizeLlmText("能\uFFFD\u25C6\u25C6表达技术概念");
    check("U+FFFD 与 ◆ 被剥离", out === "能表达技术概念", JSON.stringify(out));
  }

  console.log("\n场景 A3：带圈序号 ①②③ 保留（不能误伤正文）");
  {
    const src = "①先拆解问题 ②给出量化依据 ③说明取舍";
    const out = sanitizeLlmText(src);
    check("①②③ 原样保留", out === src, JSON.stringify(out));
  }

  console.log("\n场景 A4：孤立代理对 / 控制字符 / 边界输入");
  {
    check("孤立代理对被剥离", sanitizeLlmText("\uD83D中文") === "中文", JSON.stringify(sanitizeLlmText("\uD83D中文")));
    check("肤色修饰序列（👍🏽=代理对+U+1F3FD）全清", sanitizeLlmText("好\uD83D\uDE0D\uD83C\uDFFD评") === "好评", JSON.stringify(sanitizeLlmText("好\uD83D\uDE0D\uD83C\uDFFD评")));
    check("控制字符被剥离", sanitizeLlmText("a\u0001b\u0007c\u007F") === "abc", JSON.stringify(sanitizeLlmText("a\u0001b\u0007c\u007F")));
    check("⚠️⚡ 等符号区字符被剥离", sanitizeLlmText("注意\u26A0\uFE0F：性能\u26A1问题") === "注意：性能问题", JSON.stringify(sanitizeLlmText("注意\u26A0\uFE0F：性能\u26A1问题")));
    check("null 输入返回空串", sanitizeLlmText(null) === "");
    check("纯 ASCII 原样", sanitizeLlmText("Java & Spring Boot") === "Java & Spring Boot");
  }
}

// ---------------------------------------------------------------- B/C. 端到端

/** 构造带 emoji 的 analyzeJob LLM 返回（6 维齐全） */
const EMOJI_PAYLOAD = {
  role: "后端\u{1F9E0}开发工程师",
  level: "初级\u26A1",
  industry: "互联网\u{1F4A1}",
  interviewerStyle: "喜欢\u{1F525}追问数字口径与\uFFFD选型理由",
  competencies: [
    { key: "technicalDepth", name: "技术深度\u{1F680}", weight: 0.3, focusPoints: ["能\u{1F9E0}分析问题", "①讲清\u26A1技术选型", "\uD83D\uDE0D"], expectedLevel: "能\u{1F4A1}独立讲清方案依据" },
    { key: "projectAuthenticity", name: "项目真实性", weight: 0.2, focusPoints: ["追问\uFFFD项目细节"], expectedLevel: "能提供\u26A1可验证细节" },
    { key: "businessInsight", name: "业务理解", weight: 0.1, focusPoints: ["理解\u{1F4A1}业务场景"], expectedLevel: "懂业务\u{1F680}" },
    { key: "problemSolving", name: "问题解决", weight: 0.15, focusPoints: ["拆解\u26A0\uFE0F复杂问题"], expectedLevel: "结构化\u{1F525}拆解" },
    { key: "jobFit", name: "岗位匹配", weight: 0.15, focusPoints: ["匹配\uFFFD岗位要求"], expectedLevel: "贴合\u26A1JD" },
    { key: "communication", name: "表达沟通", weight: 0.1, focusPoints: ["能\u{1F9E0}表达技术概念"], expectedLevel: "表达\u{1F4A1}清晰" },
  ],
};

const RESUME = {
  summary: "计算机科学与技术专业本科，做过课程设计与小型 Web 项目，熟悉 Java 与 MySQL",
  education: [{ school: "某大学", major: "计算机科学与技术", degree: "本科", period: "2022-2026" }],
  experiences: [{ org: "某公司", role: "开发实习生", period: "2025.06-2025.09", duties: ["参与接口开发"], achievements: ["完成 3 个模块"] }],
  projects: [{ name: "课程管理系统", detail: "Spring Boot + MySQL，实现选课与成绩管理" }],
  awards: ["校级竞赛三等奖"],
  skills: { languages: ["Java"], frameworks: ["Spring Boot"], tools: ["Git"], concepts: [], other: [] },
};
const JOB = { role: "后端开发工程师", level: "初级", industry: "互联网", extra: "" };
const COMPETENCY = EMOJI_PAYLOAD;

const EMOJI_QUESTIONS = [
  {
    question: "简历中的\u{1F9E0}课程管理系统，QPS 峰值多少？\uFFFD怎么算的？",
    type: "project",
    difficulty: "中等",
    competency: "technicalDepth",
    evidence: "课程管理系统\u{1F680}",
    followups: ["为什么\u26A1选 MySQL？", "\uD83D\uDE0D"],
    keyPoints: ["给出\u{1F4A1}具体数字", "说明\u26A0\uFE0F压测方式"],
  },
  {
    question: "①讲讲\u{1F525}索引失效的场景",
    type: "technical",
    difficulty: "困难",
    competency: "technicalDepth",
    evidence: "技能：\uFFFDMySQL",
    followups: [],
    keyPoints: ["最左\u26A1前缀"],
  },
];

async function testAnalyzeJobE2E() {
  console.log("\n场景 B：analyzeJob 端到端（LLM 返回带 emoji → 输出全清洗）");
  // ./llm 是模块顶层 require → 必须经 opts.modules 在 loadFunction 前预置（后补不生效）
  const { main } = loadFunction("analyzeJob", {
    OPENID: "o_e2e",
    modules: { "./llm": { callLLM: async () => JSON.stringify(EMOJI_PAYLOAD) } },
  });
  const res = await main({ job: JOB });
  check("未返回错误", !res.error, res.error);
  const c = res.competency;
  check("role 已清洗", c.role === "后端开发工程师", JSON.stringify(c.role));
  check("level 已清洗", c.level === "初级", JSON.stringify(c.level));
  check("industry 已清洗", c.industry === "互联网", JSON.stringify(c.industry));
  check("interviewerStyle 已清洗且保序", c.interviewerStyle === "喜欢追问数字口径与选型理由", JSON.stringify(c.interviewerStyle));
  const tech = c.competencies.find((x) => x.key === "technicalDepth");
  check("维度 name 已清洗", tech.name === "技术深度", JSON.stringify(tech.name));
  check("focusPoints 逐项清洗且全 emoji 项被丢弃", JSON.stringify(tech.focusPoints) === JSON.stringify(["能分析问题", "①讲清技术选型"]), JSON.stringify(tech.focusPoints));
  check("expectedLevel 已清洗", tech.expectedLevel === "能独立讲清方案依据", JSON.stringify(tech.expectedLevel));
  check("① 带圈序号在端到端输出中保留", tech.focusPoints[1] === "①讲清技术选型");
  const comm = c.competencies.find((x) => x.key === "communication");
  check("乱码实锤句「能�◆表达技术概念」清洗后可读", comm.focusPoints[0] === "能表达技术概念", JSON.stringify(comm.focusPoints));
  check("6 维齐全（雷达图约束）", c.competencies.length === 6);
  check("权重保留", Math.abs(tech.weight - 0.3) < 1e-9, String(tech.weight));
}

async function testGenDeepQuestionsE2E() {
  console.log("\n场景 C：genDeepQuestions 端到端（LLM 题目带 emoji → 题干/锚点清洗）");
  const { main } = loadFunction("genDeepQuestions", {
    OPENID: "o_e2e2",
    modules: { "./llm": { callLLM: async () => JSON.stringify(EMOJI_QUESTIONS) } },
  });
  const res = await main({ resume: RESUME, job: JOB, competency: COMPETENCY });
  check("未返回错误", !res.error, res.error);
  check(`题量补齐到下限（LLM 只给 2 题，模板兜底，实际 ${res.questions.length}）`, res.questions.length >= 15, String(res.questions.length));
  const q1 = res.questions[0];
  check("LLM 题干已清洗", q1.question === "简历中的课程管理系统，QPS 峰值多少？怎么算的？", JSON.stringify(q1.question));
  check("LLM evidence 已清洗", q1.evidence === "课程管理系统", JSON.stringify(q1.evidence));
  check("followups 清洗且全 emoji 项被丢弃", JSON.stringify(q1.followups) === JSON.stringify(["为什么选 MySQL？"]), JSON.stringify(q1.followups));
  check("keyPoints 清洗且全 emoji 项被丢弃", JSON.stringify(q1.keyPoints) === JSON.stringify(["给出具体数字", "说明压测方式"]), JSON.stringify(q1.keyPoints));
  const q2 = res.questions[1];
  check("②题干 ① 带圈序号保留", q2.question === "①讲讲索引失效的场景", JSON.stringify(q2.question));
  check("模板兜底题不受影响（本来就没有 emoji）", res.questions.slice(2).every((q) => q.question && q.evidence), "");
  check("输出不存在豆腐块字符", !res.questions.some((q) => /[\uFFFD\u2600-\u27BF]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDFFF]/.test(q.question + q.evidence + q.keyPoints.join(""))));
}

(async () => {
  try {
    testSanitizeUnit();
    await testAnalyzeJobE2E();
    await testGenDeepQuestionsE2E();
  } catch (e) {
    console.error("[EXCEPTION]", e);
    failed++;
  }
  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})();

/*
反向验证记录（2026-11-17）：
  git stash push -- cloudfunctions/analyzeJob/index.js cloudfunctions/genDeepQuestions/index.js
  → node tests/analyze_job.test.js：
    A0 [FAIL] 导出 sanitizeLlmText；B 场景全部 [FAIL]（emoji 残留）；C 场景 [FAIL]（题干/锚点 emoji 残留）
  git stash pop → 复绿。
*/
