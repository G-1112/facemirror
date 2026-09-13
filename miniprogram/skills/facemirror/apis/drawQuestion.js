// apis/drawQuestion.js — 抽一道表达力练习题目（面试/答辩/课堂展示）
//
// 真实入口复刻：pages/question/question.ts loadRandom() → getQuestions({ scene, limit: 1 })。
// [ai-mode:static] 响应字段来源：cloudfunctions/getQuestions/index.js（见 analysis-apis.md）。
const { errorResult, successResult, callCloud } = require("../utils/util");

const SCENE_LABEL = { interview: "模拟面试", defense: "答辩预演", presentation: "课堂展示" };

async function drawQuestion(params = {}) {
  console.info("[ai-mode] drawQuestion 入口, params=", JSON.stringify(params));
  try {
    const scene = params.scene || "interview";
    if (!SCENE_LABEL[scene]) {
      return errorResult("scene 仅支持 interview（模拟面试）/ defense（答辩预演）/ presentation（课堂展示）");
    }

    const res = await callCloud("getQuestions", { scene, limit: 1 });
    const list = (res && res.questions) || [];
    if (!list.length) {
      // 题库未导入是合法空态（见 analysis-apis.md），不视为失败
      return successResult("题库暂时为空，请先在云数据库 questions 集合导入题目后再试。", { found: false });
    }

    const q = list[0];
    const label = SCENE_LABEL[scene];
    return {
      ...successResult(`为你抽到一道${label}题：${q.text}。想开口练习就点下方卡片进入小程序。`, {
        found: true,
        scene,
        sceneLabel: label,
        questionText: q.text,
        category: q.category || "",
        difficulty: q.difficulty || "",
      }),
      // 进小程序继续作答：question 页 onLoad 读取 query.scene / query.mode / query.question，
      // mode=retry 表示使用预设题目（与主包「同题重练」同一入口）
      handoff: {
        query: `scene=${scene}&mode=retry&question=${encodeURIComponent(q.text)}`,
      },
    };
  } catch (err) {
    console.error("[ai-mode] drawQuestion 出错:", err.message);
    return errorResult(`抽题失败: ${err.message}`);
  }
}

module.exports = { drawQuestion };
