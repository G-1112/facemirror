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

exports.main = async (event) => {
  const { fileID, scene } = event;
  if (!fileID) return { error: "缺少 fileID" };

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
