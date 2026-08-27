// 历史记录（FR-12）：只返回本人已完成的分析
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { page = 1, pageSize = 10 } = event;

  const where = { openid: OPENID, status: "done" };
  const countRes = await db.collection("practices").where(where).count();
  const res = await db
    .collection("practices")
    .where(where)
    .orderBy("createdAt", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();

  return { list: res.data, total: countRes.total };
};
