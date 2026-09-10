// 自定义出题（FR-03，★核心差异化）：上传简历/项目文档/论文摘要 → LLM 生成 5-8 个针对性追问
const cloud = require("wx-server-sdk");
const { callLLM } = require("./llm"); // 独立副本（云函数不能跨目录 require）

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const GEN_SYSTEM = `你将扮演一位严格的面试官/答辩评委。基于候选人提供的材料，生成 5-8 个追问。

要求：
  1. 每个问题必须针对材料中的【具体内容】（项目名、数字、技术选型、结论），不得问通用问题
  2. 优先攻击材料中最薄弱或最可能被追问的点：数据缺乏对比、结论缺少依据、技术选型未说明理由
  3. 若材料中出现了数字指标，必须至少追问一次该指标的口径与基线
  4. 输出严格 JSON 数组，每项 {"question": "...", "target": "...", "difficulty": "简单|中等|困难"}`;

const GEN_USER = (text) => `【材料】\n${text}`;

/** 从云存储下载材料并提取文本 */
async function extractText(fileID) {
  const res = await cloud.downloadFile({ fileID });
  const buf = res.fileContent;
  const lower = fileID.toLowerCase();

  if (lower.endsWith(".docx")) {
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("word/document.xml").async("string");
    // 提取 <w:t> 之间的文本
    const texts = [];
    xml.replace(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g, (_, t) => texts.push(t));
    return texts.join("");
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

  // 2) 归属校验：材料必须由当前用户上传（cloudPath 约定含 /{openid}/）。
  //    否则任何拿到 fileID 的人都能下载他人简历/项目材料（越权读取）。
  if (!String(fileID).includes(`/${OPENID}/`)) {
    console.warn("越权下载被拒:", fileID, OPENID);
    return { error: "无权访问该材料" };
  }

  // 3) 频率限制：LLM 调用有真实成本，防止被恶意刷取
  if (await rateLimited(OPENID)) {
    return { error: "出题过于频繁，请稍后再试" };
  }

  let text = "";
  try {
    text = await extractText(fileID);
  } catch (e) {
    console.warn("材料解析失败:", e.message);
    return { error: "材料解析失败，请上传 .txt / .md / .docx 文件" };
  }

  if (!text.trim()) return { error: "材料内容为空" };
  text = text.slice(0, 4000); // 控制长度

  let questions;
  try {
    const raw = await callLLM(GEN_SYSTEM, GEN_USER(text), { json: true, temperature: 0.3 });
    questions = JSON.parse(raw);
    if (!Array.isArray(questions)) throw new Error("非数组");
  } catch (e) {
    console.warn("LLM 出题失败，降级 mock:", e.message);
    questions = mockQuestions(text);
  }

  return { questions: questions.slice(0, 8) };
};
