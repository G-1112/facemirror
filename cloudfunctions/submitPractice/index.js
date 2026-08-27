// 提交练习：写入 record(status=pending)，立即返回（<1s，绕开超时）
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { scene, questionText, audioFileID, durationSec } = event;

  const res = await db.collection("practices").add({
    data: {
      openid: OPENID,
      scene: scene || "interview",
      questionText: questionText || "",
      audioFileID: audioFileID || "",
      durationSec: durationSec || 0,
      transcript: "",
      sentences: [],
      status: "pending",
      createdAt: Date.now(),
    },
  });

  return { recordId: res._id };
};
