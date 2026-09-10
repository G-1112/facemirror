// 抽题（FR-02）：按场景/分类随机抽题，同一次调用不重复
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  // 鉴权：题库虽公开，但云函数不应允许匿名调用（防被脚本刷取）
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新登录" };

  let { scene = "interview", category, limit = 1 } = event;
  // limit 上限：防止一次拉取整库
  limit = Math.max(1, Math.min(20, Number(limit) || 1));
  // 课堂展示（presentation）复用通用面试题库
  if (scene === "presentation") {
    scene = "interview";
    category = category || "通用";
  }
  const where = { scene };
  if (category) where.category = category;

  const col = db.collection("questions").where(where);
  const countRes = await col.count();
  const total = countRes.total;
  if (!total) return { questions: [] };

  const skip = Math.floor(Math.random() * Math.max(0, total - limit));
  const res = await col.skip(skip).limit(limit).get();
  return { questions: res.data };
};
