// 自定义出题（FR-03，★核心差异化）：上传简历/项目文档/论文摘要 → LLM 生成 5-8 个针对性追问
const cloud = require("wx-server-sdk");
const { checkText } = require("./sec-check");
const { callLLM } = require("./llm"); // 独立副本（云函数不能跨目录 require）
const { escapeForPrompt, scanInjection } = require("./injection"); // 独立副本，与 analyze 同源

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const GEN_SYSTEM = `你将扮演一位严格的面试官/答辩评委。基于候选人提供的材料，生成 5-8 个追问。

要求：
  1. 每个问题必须针对材料中的【具体内容】（项目名、数字、技术选型、结论），不得问通用问题
  2. 优先攻击材料中最薄弱或最可能被追问的点：数据缺乏对比、结论缺少依据、技术选型未说明理由
  3. 若材料中出现了数字指标，必须至少追问一次该指标的口径与基线
  4. 输出严格 JSON 数组，每项 {"question": "...", "target": "...", "difficulty": "简单|中等|困难"}`;

const GEN_USER = (text) => `【材料】\n${text}`;

// 服务端真实可解析的格式白名单（第十一轮审查 B-11，2026-10-27 新增 pdf）：
// docx 解包 + 纯文本 + PDF 文本抽取（pdf-parse，远端 npm 安装）。
// ⚠️ 两侧白名单必须一致：客户端 chooseMessageFile 的 extension 数组同步放行 pdf。
const ALLOWED_EXT_RE = /\.(txt|md|docx|pdf)$/i;

/** PDF 文本抽取（pdf-parse；扫描件/图片版 PDF 抽不出文字 → 明确报错） */
async function extractPdfText(buf) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch (e) {
    throw new Error("服务端 PDF 解析组件未安装，请联系维护者重新部署");
  }
  const res = await pdfParse(buf);
  const text = (res && res.text) || "";
  // 扫描件/图片版 PDF 抽取结果为空或极短 → 给可操作指引而非「材料解析失败」
  if (text.replace(/\s+/g, "").length < 30) {
    throw new Error("PDF 可能是扫描件或图片版，无法提取文字，请改用 docx / txt 格式重新上传");
  }
  // ⚠️ 嵌入字体子集缺 ToUnicode CMap 的 PDF：数字等字形全部映射为 U+0000
  // （2026-11-16 实测：简历「IoU ≥ 0.91」被提为「IoU ≥ \u0000.\u0000\u0000」，
  // 出题依据会写「≥ 0.00」——绝不静默产出错题，检测到 NUL 即 fail-fast）
  const nulCount = (text.match(/\u0000/g) || []).length;
  if (nulCount > 0) {
    throw new Error("该 PDF 的内嵌字体缺少文字编码表，数字等字符无法正确提取。请用 Word/WPS 打开原文档另存为 docx 格式上传，或重新导出 PDF");
  }
  return text;
}

/** 从云存储下载材料并提取文本 */
async function extractText(fileID) {
  const res = await cloud.downloadFile({ fileID });
  const buf = res.fileContent;
  const lower = fileID.toLowerCase();

  if (lower.endsWith(".docx")) {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("word/document.xml");
    // 修复：原实现直接 zip.file(...).async(...)，若文件不是合法 docx
    //（缺 word/document.xml），entry 为 null → 抛 "Cannot read property 'async' of null"，
    // 外层捕获后只能报「材料解析失败」，用户无法判断是格式问题还是内容问题。
    if (!entry) throw new Error("docx 结构异常：缺少 word/document.xml");
    const xml = await entry.async("string");
    // 提取 <w:t> 之间的文本
    const texts = [];
    xml.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, t) => texts.push(t));
    return texts.join("");
  }

  if (lower.endsWith(".pdf")) {
    return extractPdfText(buf);
  }

  // .txt / .md / 其他：按 UTF-8 文本处理
  return buf.toString("utf-8");
}

/** 无 LLM 时的确定性回退：从材料关键词生成通用追问 */
function mockQuestions(text) {
  const qs = [
    { question: "请介绍一下你在这个项目中的具体角色与贡献？", target: "项目角色", difficulty: "简单" },
    { question: "这个项目遇到的最大技术难点是什么，你是如何解决的？", target: "技术难点", difficulty: "中等" },
    { question: "如果重新做这个项目，你会在哪些地方做出不同的选择？", target: "复盘", difficulty: "中等" },
    { question: "材料中的关键结论是如何验证或评估的？", target: "结论验证", difficulty: "困难" },
    { question: "这项经历对你未来的职业规划有什么影响？", target: "职业规划", difficulty: "简单" },
  ];
  return qs;
}

/** 频率限制（防 LLM 配额被刷）：默认每用户每小时 10 次 */
async function rateLimited(openid, limit = 10, windowMs = 60 * 60 * 1000) {
  const db = cloud.database();
  try {
    const res = await db
      .collection("rate_limits")
      .where({ openid, ts: db.command.gte(Date.now() - windowMs) })
      .count();
    if (res && res.total >= limit) return true;
    await db.collection("rate_limits").add({
      data: { openid, ts: Date.now(), action: "genQuestions" },
    });
    return false;
  } catch (e) {
    // 限流记录失败不阻塞主流程（集合首次写入会自动创建）
    console.warn("限流记录失败（不阻塞）:", e.message);
    return false;
  }
}

exports.main = async (event) => {
  // 1) 身份校验：云函数必须绑定登录态，杜绝匿名调用刷 LLM 配额
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新登录" };

  const { fileID, scene } = event;
  if (!fileID) return { error: "缺少 fileID" };

  // 2) 格式白名单：只接受服务端真实可解析的格式（B-11，与服务端 extractText 能力对齐）
  if (!ALLOWED_EXT_RE.test(String(fileID))) {
    return { error: "仅支持 .txt / .md / .docx / .pdf 文件" };
  }

  // 3) 归属校验：材料必须由当前用户上传（cloudPath 约定含 /{openid}/）。
  //    否则任何拿到 fileID 的人都能下载他人简历/项目材料（越权读取）。
  if (!String(fileID).includes(`/${OPENID}/`)) {
    console.warn("越权下载被拒:", fileID, OPENID);
    return { error: "无权访问该材料" };
  }

  // 4) 频率限制：LLM 调用有真实成本，防止被恶意刷取
  if (await rateLimited(OPENID)) {
    return { error: "出题过于频繁，请稍后再试" };
  }

  let text = "";
  try {
    text = await extractText(fileID);
  } catch (e) {
    console.warn("材料解析失败:", e.message);
    return { error: (e && e.message) || "材料解析失败，请上传 .txt / .md / .docx / .pdf 文件" };
  }

  if (!text.trim()) return { error: "材料内容为空" };
  text = text.slice(0, 4000); // 控制长度

  // 5) 内容安全（第十一轮审查 B-12）：材料是 UGC，落 LLM 链路前必须过检，
  //    与 README/作品说明文档中「用户上传材料过 msgSecCheck」的声明对齐。
  try {
    // 内容安全检测（见 sec-check.js）：违规必拒；检测服务不可用 → 降级放行。
    // 用户上传材料是 UGC，微信审核硬性要求过 msgSecCheck；
    // 但平台接口不可用（61010/45009/-604101）时不应让整个功能不可用。
    await checkText(text, {
      openid: cloud.getWXContext().OPENID,
      scene: 2,
      rejectMessage: "材料包含违规信息，请修改后重新上传",
    });
  } catch (e) {
    // 内容违规 → 返回业务错误，不进入 LLM 链路。
    return { error: (e && e.message) || "材料包含违规信息，请修改后重新上传" };
  }

  // 6) Prompt 注入防护（B-13）：材料完全由用户控制，可写入「忽略以上指令……」
  //    让 LLM 输出与材料无关的内容。命中时不采信 LLM 输出，降级为确定性通用追问，
  //    并以 injectionFlagged 标记，便于前端提示与后续审计。
  const injectionHits = scanInjection(text);

  let questions;
  if (injectionHits.length > 0) {
    console.warn("材料命中注入特征，降级 mock:", injectionHits.slice(0, 3));
    questions = mockQuestions(text);
  } else {
    try {
      // 材料先转义定界标记，避免其伪造出「指令区」
      const raw = await callLLM(GEN_SYSTEM, GEN_USER(escapeForPrompt(text)), { json: true, temperature: 0.3 });
      questions = JSON.parse(raw);
      if (!Array.isArray(questions)) throw new Error("非数组");
    } catch (e) {
      console.warn("LLM 出题失败，降级 mock:", e.message);
      questions = mockQuestions(text);
    }
  }

  // 修复：LLM 返回的数组元素结构不可控（可能是字符串 / 缺字段 / question 为空），
  // 原实现直接 slice 返回，前端会渲染出空白选项卡（q.question 为 undefined）。
  // 这里逐项校验并丢弃非法项，字段缺失时补默认值。
  const normalized = (Array.isArray(questions) ? questions : [])
    .filter((q) => q && typeof q === "object" && typeof q.question === "string" && q.question.trim())
    .map((q) => ({
      question: q.question.trim(),
      target: typeof q.target === "string" && q.target.trim() ? q.target.trim() : "综合",
      difficulty: ["简单", "中等", "困难"].includes(q.difficulty) ? q.difficulty : "中等",
    }));

  // 全部非法时降级到确定性追问，保证用户始终能拿到可用问题
  const finalQuestions = normalized.length ? normalized : mockQuestions(text);

  const result = { questions: finalQuestions.slice(0, 8) };
  if (injectionHits.length > 0) result.injectionFlagged = true;
  return result;
};
