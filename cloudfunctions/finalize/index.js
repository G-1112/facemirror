// 报告完成通知（FR-13）：发送订阅消息，避免用户空等
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { recordId } = event;
  const { OPENID } = cloud.getWXContext();

  const templateId = process.env.SUBSCRIBE_TEMPLATE_ID || "";
  if (!templateId) {
    return { ok: false, error: "未配置 SUBSCRIBE_TEMPLATE_ID" };
  }

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: OPENID,
      templateId,
      page: `pages/result/result?recordId=${recordId}`,
      // 字段名（thing1/thing2/...）需与你在公众平台申请的模板字段一致
      data: {
        thing1: { value: "表达练习评估报告已生成" },
        thing2: { value: "点击查看你的能力雷达与改进建议" },
      },
    });
    return { ok: true };
  } catch (e) {
    console.warn("订阅消息发送失败:", e.errMsg || e.message);
    return { ok: false, error: e.errMsg || "发送失败" };
  }
};
