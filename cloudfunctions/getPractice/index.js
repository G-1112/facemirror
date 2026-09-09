// 查询单次练习的状态与结果（客户端每 3s 轮询）
//
// 安全（审计修复 B-01）：原实现直接 doc(recordId).get()，未校验归属，
// 任何登录用户传他人 recordId 即可读取其转写与评估报告（IDOR）。
// 云函数走管理员权限，客户端侧的数据库权限规则不生效，必须在函数内显式校验 openid。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { recordId } = event;
  if (!recordId || typeof recordId !== "string") return { error: "缺少 recordId" };

  const res = await db
    .collection("practices")
    .where({ _id: recordId, openid: OPENID })
    .limit(1)
    .get();
  if (!res.data.length) return { error: "记录不存在或无访问权限" };

  const p = res.data[0];
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
