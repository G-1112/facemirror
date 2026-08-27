// 内容安全过滤（FR-14，微信审核硬性要求）：security.msgSecCheck
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { text } = event;
  if (!text || !text.trim()) return { safe: true };

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: text.slice(0, 2500),
      version: 2,
      scene: 2,
      openid: cloud.getWXContext().OPENID,
    });
    const suggest = res && res.result && res.result.suggest;
    return { safe: suggest !== "risky" };
  } catch (e) {
    // 检测接口异常时放行，避免阻塞主流程；但需在日志中记录
    console.warn("msgSecCheck failed", e);
    return { safe: true };
  }
};
