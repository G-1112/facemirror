// 转写人工修正（FR-06）：ASR 误差兜底 + 体验加分项
//
// 安全（审计修复 B-01 / B-02）：
//   B-01 原实现未校验归属，任何登录用户可篡改他人记录（IDOR 写）；
//   B-02 转写文本直接入库，未过内容安全，违反微信 UGC 审核要求。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_TRANSCRIPT_LEN = 5000;

/** 服务端内容安全检测：未通过或接口异常一律拒绝写入（fail-close） */
async function assertSafe(text) {
  if (!text || !text.trim()) return;
  let risky = false;
  let unavailable = false;
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: text.slice(0, 2500),
      version: 2,
      scene: 2,
      openid: cloud.getWXContext().OPENID,
    });
    const suggest = res && res.result && res.result.suggest;
    risky = suggest === "risky";
  } catch (e) {
    unavailable = true;
  }
  if (risky) throw new Error("内容包含违规信息，请修改后重试");
  if (unavailable) throw new Error("内容安全检测暂不可用，请稍后重试");
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { recordId, transcript } = event;
  if (!recordId || typeof recordId !== "string") return { error: "缺少 recordId" };

  // 归属校验：只能修改自己的记录
  const owned = await db
    .collection("practices")
    .where({ _id: recordId, openid: OPENID })
    .limit(1)
    .get();
  if (!owned.data.length) return { error: "记录不存在或无访问权限" };

  let text = typeof transcript === "string" ? transcript : "";
  if (text.length > MAX_TRANSCRIPT_LEN) text = text.slice(0, MAX_TRANSCRIPT_LEN);

  await assertSafe(text);

  await db.collection("practices").doc(recordId).update({
    data: {
      transcript: text,
      status: "asr_done", // 修正后进入待分析态
    },
  });
  return { ok: true };
};
