// 内容安全过滤（FR-14，微信审核硬性要求）：security.msgSecCheck
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 未登录仅告警：内容安全是微信审核硬性要求，
  // 不能因为鉴权失败就让检测失效（否则违规内容会绕过审核直接入库）
  if (!OPENID) console.warn("checkContent: 匿名调用（内容检测仍执行）");

  const { text } = event;
  if (!text || !text.trim()) return { safe: true };
  // 微信 security 接口上限 2500 字：超长截断检测（不阻断提交）
  if (text.length > 2500) {
    console.warn("checkContent: 文本超 2500 字，仅检测前 2500 字");
  }

  try {
    const params = { content: text.slice(0, 2500), version: 2, scene: 2 };
    // openid 用于用户安全信用，可选；缺失时不传以免影响调用
    if (OPENID) params.openid = OPENID;
    const res = await cloud.openapi.security.msgSecCheck(params);
    const suggest = res && res.result && res.result.suggest;
    return { safe: suggest !== "risky" };
  } catch (e) {
    // 检测接口异常时放行，避免阻塞主流程；但需在日志中记录
    console.warn("msgSecCheck failed", e);
    return { safe: true };
  }
};
