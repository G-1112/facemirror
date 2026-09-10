// 历史记录（FR-12）：只返回本人已完成的分析
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 分页上限，防止 pageSize 被构造为超大值导致 skip 过深
const MAX_PAGE_SIZE = 20;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  let { page = 1, pageSize = 10 } = event;

  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || 10));

  const where = { openid: OPENID, status: "done" };

  // 性能（第三轮 B-10）：count 与 get 相互独立，原先串行 await 导致
  // 两次网络往返叠加。改为 Promise.all 并行，历史列表响应时间约减半。
  const [countRes, res] = await Promise.all([
    db.collection("practices").where(where).count(),
    db
      .collection("practices")
      .where(where)
      .orderBy("createdAt", "desc")
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
  ]);

  return { list: res.data, total: countRes.total, page, pageSize };
};
