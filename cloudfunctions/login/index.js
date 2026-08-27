// 登录：返回 openid（FR-01，wx.login 静默登录，不强制手机号授权）
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  return { openid: OPENID };
};
