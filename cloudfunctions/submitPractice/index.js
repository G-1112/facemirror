// 提交练习：写入 record(status=pending)，立即返回（<1s，绕开超时）
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 字段上限（第三轮 B-07）：questionText 后续会被 analyze 拼进 LLM prompt，
// 超长文本会导致存储膨胀与 LLM 成本失控；scene 也需收敛到白名单。
const MAX_QUESTION_LEN = 2000;
const ALLOWED_SCENES = ["interview", "defense", "presentation"];
// 单次录音时长上限（秒）：防止构造超长值影响评估
const MAX_DURATION_SEC = 600;

function clampQuestion(text) {
  const s = typeof text === "string" ? text : String(text == null ? "" : text);
  return s.length > MAX_QUESTION_LEN ? s.slice(0, MAX_QUESTION_LEN) : s;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新进入小程序" };

  const { scene, questionText, audioFileID, durationSec } = event;

  const safeScene = ALLOWED_SCENES.includes(scene) ? scene : "interview";
  const safeDuration = Math.max(0, Math.min(MAX_DURATION_SEC, Number(durationSec) || 0));

  const res = await db.collection("practices").add({
    data: {
      openid: OPENID,
      scene: safeScene,
      questionText: clampQuestion(questionText),
      audioFileID: typeof audioFileID === "string" ? audioFileID : "",
      durationSec: safeDuration,
      transcript: "",
      sentences: [],
      status: "pending",
      createdAt: Date.now(),
    },
  });

  return { recordId: res._id };
};

