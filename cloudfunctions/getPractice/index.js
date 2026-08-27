// 查询单次练习的状态与结果（客户端每 3s 轮询）
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { recordId } = event;
  if (!recordId) return { error: "缺少 recordId" };

  const res = await db.collection("practices").doc(recordId).get();
  const p = res.data;
  return {
    status: p.status,
    transcript: p.transcript || "",
    sentences: p.sentences || [],
    scene: p.scene,
    questionText: p.questionText,
    durationSec: p.durationSec,
    report: p.report || null,
  };
};
