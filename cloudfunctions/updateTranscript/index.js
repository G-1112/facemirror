// 转写人工修正（FR-06）：ASR 误差兜底 + 体验加分项
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { recordId, transcript } = event;
  if (!recordId) return { error: "缺少 recordId" };

  await db.collection("practices").doc(recordId).update({
    data: {
      transcript: transcript || "",
      status: "asr_done", // 修正后进入待分析态
    },
  });
  return { ok: true };
};
