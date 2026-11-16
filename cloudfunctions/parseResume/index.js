// 简历解析（深度面试 · 第 1 步）：上传简历文件 → 结构化识别
// 输出：{ resume: ResumeProfile, rawText } 供前端展示并让用户确认/修正。
const cloud = require("wx-server-sdk");
const { checkText } = require("./sec-check");
const { callLLM } = require("./llm");
const { escapeForPrompt, scanInjection } = require("./injection");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/** 服务端真实可解析的格式白名单（与前端 chooseMessageFile 的 extension 保持一致） */
const ALLOWED_EXT_RE = /\.(txt|md|docx|pdf)$/i;
/** 简历文本上限：超长截断。6000→20000（2026-11-16 真机实测：用户完整简历超 6000 被
 *  截断丢项目经历；20000 字 ≈ 30+ 页，真实简历不可能触达，仅防异常文件打爆
 *  LLM 上下文与费用，保留防御性闸门而非完全取消） */
const MAX_RESUME_CHARS = 20000;

const PARSE_SYSTEM = `你是一个资深简历解析器。请把候选人简历解析成严格的 JSON。

要求：
1. 只输出 JSON 对象，字段如下：
   {
     "summary": "一段不超过 120 字的个人概述",
     "education": [{"school":"","major":"","degree":"","period":"","highlights":[""]}],
     "experiences": [{"org":"","role":"","period":"","duties":[""],"achievements":[""]}],
     "projects": [{"name":"","role":"","period":"","tech":[""],"desc":"","metrics":[""],"highlights":[""]}],
     "awards": [{"name":"","level":"","period":"","issuer":""}],
     "skills": {"languages":[],"frameworks":[],"tools":[],"concepts":[],"other":[]}
   }
2. 只写简历里**真实出现**的内容；原文没有的字段填空字符串或空数组，**严禁编造**。
3. metrics 抽取原文里的量化数字（如 QPS、准确率、用户量、时长），保留原始单位。
4. tech 只放原文出现过的技术名，不要扩展。`;

const PARSE_USER = (text) => `【简历原文】\n${text}`;

/** PDF 文本抽取（与 genQuestions 同款能力；扫描件 → 明确报错） */
async function extractPdfText(buf) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch (e) {
    throw new Error("服务端 PDF 解析组件未安装，请联系维护者重新部署");
  }
  const res = await pdfParse(buf);
  const text = (res && res.text) || "";
  // 扫描件/图片版 PDF 抽取结果为空或极短 → 可操作指引，而不是「解析失败」
  if (text.replace(/\s+/g, "").length < 30) {
    throw new Error("PDF 可能是扫描件或图片版，无法提取文字，请改用 docx / txt 格式重新上传");
  }
  // ⚠️ 嵌入字体子集缺 ToUnicode CMap 的 PDF：数字等字形全部映射为 U+0000
  // （2026-11-16 实测：简历「IoU ≥ 0.91」被提为「IoU ≥ \u0000.\u0000\u0000」，
  // LLM 据此出题依据写「≥ 0.00」——绝不静默产出错题，检测到 NUL 即 fail-fast）
  const nulCount = (text.match(/\u0000/g) || []).length;
  if (nulCount > 0) {
    throw new Error("该 PDF 的内嵌字体缺少文字编码表，数字等字符无法正确提取。请用 Word/WPS 打开原文档另存为 docx 格式上传，或重新导出 PDF");
  }
  return text;
}

/** 从云存储下载并提取文本（与 genQuestions 同款能力：docx 解包 / PDF / 纯文本） */
async function extractText(fileID) {
  const res = await cloud.downloadFile({ fileID });
  const buf = res.fileContent;
  const lower = String(fileID).toLowerCase();

  if (lower.endsWith(".docx")) {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("word/document.xml");
    // 缺 word/document.xml 说明不是合法 docx → 明确报错，不让上层报「解析失败」这种无信息文案
    if (!entry) throw new Error("docx 结构异常：缺少 word/document.xml");
    const xml = await entry.async("string");
    const texts = [];
    xml.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, t) => texts.push(t));
    return texts.join("");
  }
  if (lower.endsWith(".pdf")) {
    return extractPdfText(buf);
  }
  return buf.toString("utf-8");
}

// ---------------------------------------------------------------- 规则兜底解析
// 目标：LLM 未配置 / 调用失败 / 输出不可用时，**仍能给出结构化草稿**，
// 让用户可以在前端确认修正，而不是功能直接不可用。

const SECTION_ALIASES = {
  education: ["教育背景", "教育经历", "education"],
  experiences: ["工作经历", "实习经历", "工作与实习", "experience", "work experience", "实习"],
  projects: ["项目经历", "项目经验", "projects", "project experience"],
  awards: ["获奖情况", "荣誉奖项", "竞赛获奖", "awards", "honors"],
  skills: ["技能", "专业技能", "skills", "technical skills"],
};

const TECH_KEYWORDS = [
  "Java", "Python", "Go", "C++", "C", "JavaScript", "TypeScript", "Rust", "SQL", "Shell",
  "Spring", "SpringBoot", "Spring Boot", "MyBatis", "Django", "Flask", "FastAPI", "React", "Vue", "Angular",
  "MySQL", "PostgreSQL", "Redis", "MongoDB", "Elasticsearch", "Kafka", "RabbitMQ", "RocketMQ", "Docker", "K8s",
  "Kubernetes", "Linux", "Git", "Spark", "Flink", "Hadoop", "PyTorch", "TensorFlow", "Pandas", "NumPy",
  "Vue3", "uni-app", "微信小程序", "Node.js", "Express", "Nginx", "Flutter", "Swift", "Kotlin", "Android", "iOS",
];

const splitLines = (t) =>
  t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** 按「小节标题」切块：标题行通常是「教育背景：」或「教育背景」独占一行 */
function splitSections(text) {
  const lines = splitLines(text);
  const sections = {};
  let current = "其他";
  sections[current] = [];
  for (const line of lines) {
    const bare = line.replace(/[:：]\s*$/, "").trim();
    const norm = bare.toLowerCase();
    let matched = null;
    for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
      if (aliases.some((a) => norm === a.toLowerCase() || norm.startsWith(a.toLowerCase()))) {
        matched = key;
        break;
      }
    }
    if (matched) {
      current = matched;
      if (!sections[current]) sections[current] = [];
      continue;
    }
    sections[current].push(line);
  }
  return sections;
}

/** 规则解析：把简历切成 education/experiences/projects/awards/skills 五类 */
function ruleParse(text) {
  const warnings = [];
  const sections = splitSections(text);

  const education = (sections.education || [])
    .filter((l) => /大学|学院|学校|University|College/i.test(l) || /\d{4}\s*[-~到至]/.test(l))
    .slice(0, 6)
    .map((l) => ({
      school: (l.match(/([\u4e00-\u9fa5A-Za-z]{2,20}(?:大学|学院|学校|University|College))/) || [, ""])[1],
      major: (l.match(/([\u4e00-\u9fa5A-Za-z]{2,20}(?:专业|工程|科学|技术|方向))/) || [, ""])[1],
      degree: (/硕士|研究生|博士|本科|大专|Master|PhD|Bachelor/i.exec(l) || [""])[0],
      period: (l.match(/(\d{4}\s*[-~到至]\s*\d{4}(?:\.\d{1,2})?|\d{4}\s*[-~到至]\s*(?:至今|现在))/) || [""])[0],
      highlights: [],
    }))
    .filter((e) => e.school || e.major);

  const experiences = (sections.experiences || [])
    .filter((l) => /公司|集团|科技|有限|银行|研究院|实习|Intern/i.test(l))
    .slice(0, 6)
    .map((l) => ({
      org: (l.match(/([\u4e00-\u9fa5A-Za-z0-9（）()]{2,20}(?:公司|集团|科技|有限|银行|研究院|工作室))/) || [, ""])[1],
      role: (l.match(/([\u4e00-\u9fa5A-Za-z]{2,12}(?:工程师|实习生|开发|架构师|研究员|设计师|经理|分析师|负责人))/) || [, ""])[1],
      period: (l.match(/(\d{4}\s*[-~到至]\s*\d{4}(?:\.\d{1,2})?|\d{4}\s*[-~到至]\s*(?:至今|现在))/) || [""])[0],
      duties: [],
      achievements: [],
    }))
    .filter((e) => e.org || e.role);

  const projects = (sections.projects || [])
    .filter((l) => l.length > 6)
    .slice(0, 8)
    .map((l) => ({
      name: l.slice(0, 40),
      role: "",
      period: (l.match(/(\d{4}\s*[-~到至]\s*\d{4}(?:\.\d{1,2})?|\d{4}\s*[-~到至]\s*(?:至今|现在))/) || [""])[0],
      tech: TECH_KEYWORDS.filter((k) => l.toLowerCase().includes(k.toLowerCase())),
      desc: l.slice(0, 120),
      metrics: (l.match(/\d+(?:\.\d+)?\s*(?:%|ms|s|QPS|qps|万|亿|倍|人|条|次|GB|MB|K)/g) || []),
      highlights: [],
    }));

  const awards = (sections.awards || [])
    .filter((l) => /奖|比赛|竞赛|冠军|亚军|一等|二等|三等|奖牌/i.test(l))
    .slice(0, 8)
    .map((l) => ({
      name: l.slice(0, 50),
      level: (/国家级|省级|市级|校级|国家级一等奖|一等奖|二等奖|三等奖/.exec(l) || [""])[0],
      period: (l.match(/\d{4}/) || [""])[0],
      issuer: "",
    }));

  const allText = text;
  const skills = {
    languages: TECH_KEYWORDS.filter((k) => /^(Java|Python|Go|C\+\+|C|JavaScript|TypeScript|Rust|SQL|Shell)$/i.test(k) && allText.toLowerCase().includes(k.toLowerCase())),
    frameworks: TECH_KEYWORDS.filter((k) => /Spring|Django|Flask|FastAPI|React|Vue|Angular|Node|Express|uni-app/i.test(k) && allText.toLowerCase().includes(k.toLowerCase())),
    tools: TECH_KEYWORDS.filter((k) => /MySQL|PostgreSQL|Redis|MongoDB|Elasticsearch|Kafka|Docker|Kubernetes|Linux|Git|Nginx|Flutter|Swift|Kotlin|Android/i.test(k) && allText.toLowerCase().includes(k.toLowerCase())),
    concepts: ["数据结构", "算法", "操作系统", "计算机网络", "数据库", "系统设计", "分布式", "并发编程", "机器学习", "深度学习"].filter((c) => allText.includes(c)),
    other: [],
  };

  if (!education.length) warnings.push("未识别到教育经历，请手动补充");
  if (!experiences.length) warnings.push("未识别到工作/实习经历，请手动补充");
  if (!projects.length) warnings.push("未识别到项目经历，请手动补充");
  if (!awards.length) warnings.push("未识别到获奖信息（没有可留空）");

  return {
    summary: "",
    education,
    experiences,
    projects,
    awards,
    skills,
    parseMode: "rule",
    parseWarnings: warnings,
  };
}

/** 归一化 LLM 输出的结构，丢弃非法项、填默认值 —— 绝不把畸形数据交给前端 */
function normalizeResume(raw, warnings) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const strArr = (v) => arr(v).map(str).filter(Boolean);
  const objArr = (v) => arr(v).filter((x) => x && typeof x === "object");

  return {
    summary: str(obj.summary),
    education: objArr(obj.education).map((e) => ({
      school: str(e.school),
      major: str(e.major),
      degree: str(e.degree),
      period: str(e.period),
      highlights: strArr(e.highlights),
    })),
    experiences: objArr(obj.experiences).map((e) => ({
      org: str(e.org),
      role: str(e.role),
      period: str(e.period),
      duties: strArr(e.duties),
      achievements: strArr(e.achievements),
    })),
    projects: objArr(obj.projects).map((p) => ({
      name: str(p.name),
      role: str(p.role),
      period: str(p.period),
      tech: strArr(p.tech),
      desc: str(p.desc),
      metrics: strArr(p.metrics),
      highlights: strArr(p.highlights),
    })),
    awards: objArr(obj.awards).map((a) => ({
      name: str(a.name),
      level: str(a.level),
      period: str(a.period),
      issuer: str(a.issuer),
    })),
    skills: {
      languages: strArr(obj.skills && obj.skills.languages),
      frameworks: strArr(obj.skills && obj.skills.frameworks),
      tools: strArr(obj.skills && obj.skills.tools),
      concepts: strArr(obj.skills && obj.skills.concepts),
      other: strArr(obj.skills && obj.skills.other),
    },
    parseMode: "ai",
    parseWarnings: warnings,
  };
}

/** 频率限制：默认每用户每小时 6 次（简历解析比出题更贵） */
async function rateLimited(openid, limit = 6, windowMs = 60 * 60 * 1000) {
  const db = cloud.database();
  try {
    const res = await db
      .collection("rate_limits")
      .where({ openid, ts: db.command.gte(Date.now() - windowMs) })
      .count();
    if (res && res.total >= limit) return true;
    await db.collection("rate_limits").add({ data: { openid, ts: Date.now(), action: "parseResume" } });
    return false;
  } catch (e) {
    console.warn("限流记录失败（不阻塞）:", e.message);
    return false;
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新登录" };

  const { fileID } = event;
  if (!fileID) return { error: "缺少简历文件" };

  // 格式白名单：txt/md 纯文本、docx（xml 解压）、pdf（服务端 pdf-parse 提取；扫描件提取不到文字会明确报错）
  if (!ALLOWED_EXT_RE.test(String(fileID))) {
    return { error: "仅支持 .txt / .md / .docx / .pdf 格式的简历" };
  }

  // 归属校验：材料必须由当前用户上传（cloudPath 含 /{openid}/），否则可下载他人简历
  if (!String(fileID).includes(`/${OPENID}/`)) {
    console.warn("越权下载被拒:", fileID, OPENID);
    return { error: "无权访问该简历文件" };
  }

  if (await rateLimited(OPENID)) {
    return { error: "简历解析过于频繁，请稍后再试" };
  }

  let text = "";
  try {
    text = await extractText(fileID);
  } catch (e) {
    console.warn("简历文本提取失败:", e.message);
    // 透传可操作的原始原因（扫描件指引 / 内嵌字体缺编码表 / PDF 组件未安装），未知异常才用兜底文案
    const msg = (e && e.message) || "";
    if (msg.includes("扫描件") || msg.includes("文字编码表") || msg.includes("组件未安装")) {
      return { error: `简历解析失败：${msg}` };
    }
    // 区分「文件坏了」和「格式不对」，让用户知道该换文件还是改格式
    return { error: "简历解析失败：文件无法读取，请确认是有效的 .txt/.md/.docx/.pdf 文件" };
  }

  if (!text || !text.trim()) {
    return { error: "简历内容为空，请检查文件是否正常" };
  }
  if (text.trim().length < 20) {
    return { error: "简历内容过短（不足 20 字），请上传完整简历" };
  }
  const truncated = text.length > MAX_RESUME_CHARS;
  text = text.slice(0, MAX_RESUME_CHARS);

  // 内容安全：简历是 UGC，落 LLM 链路前必须过检
  try {
    await checkText(text, {
      openid: OPENID,
      scene: 2,
      rejectMessage: "简历内容包含违规信息，请修改后重新上传",
    });
  } catch (e) {
    return { error: (e && e.message) || "简历内容包含违规信息，请修改后重新上传" };
  }

  // 注入防护：简历完全由用户控制，可写「忽略以上指令…」
  const injectionHits = scanInjection(text);
  if (injectionHits.length > 0) {
    console.warn("简历命中注入特征，降级规则解析:", injectionHits.slice(0, 3));
  }

  let resume;
  if (injectionHits.length > 0) {
    resume = ruleParse(text);
    resume.parseWarnings.unshift("简历中检测到可疑指令，已跳过 AI 解析，请仔细核对以下内容");
  } else {
    try {
      const raw = await callLLM(PARSE_SYSTEM, PARSE_USER(escapeForPrompt(text)), {
        json: true,
        temperature: 0.1,
      });
      resume = normalizeResume(JSON.parse(raw), []);
    } catch (e) {
      console.warn("LLM 简历解析失败，降级规则解析:", e.message);
      resume = ruleParse(text);
      resume.parseWarnings.unshift("AI 解析暂不可用，已用规则识别，请仔细核对并修正");
    }
  }

  // 结构完整度检查：解析成功但什么都没识别出来 → 明确告知用户手动补充
  const empty =
    !resume.education.length &&
    !resume.experiences.length &&
    !resume.projects.length &&
    !resume.awards.length;
  if (empty) {
    resume.parseWarnings.unshift("未能从简历中识别出结构化信息，请在下方手动补充或更换文件");
  }
  if (truncated) {
    resume.parseWarnings.push(`简历过长，已截取前 ${MAX_RESUME_CHARS} 字参与解析`);
  }

  return { resume, rawText: text };
};
