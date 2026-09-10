// 报告完成通知（FR-13）：发送订阅消息，避免用户空等
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { recordId } = event;
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: "未获取用户身份" };
  if (!recordId || typeof recordId !== "string") {
    return { ok: false, error: "缺少 recordId" };
  }

  // 归属校验（第三轮 B-08）：原实现直接用客户端 recordId 拼 page 路径发通知，
  // 可被反复调用刷订阅消息，也能探测他人 recordId 是否存在。先校验记录归属。
  const owned = await db
    .collection("practices")
    .where({ _id: recordId, openid: OPENID })
    .limit(1)
    .get();
  if (!owned.data.length) {
    return { ok: false, error: "记录不存在或无访问权限" };
  }

  const templateId = process.env.SUBSCRIBE_TEMPLATE_ID || "";
  if (!templateId) {
    return { ok: false, error: "未配置 SUBSCRIBE_TEMPLATE_ID" };
  }

  // page 路径只允许安全字符，防止 recordId 注入路径/查询串（B-08）
  const safeId = encodeURIComponent(String(recordId).replace(/[^A-Za-z0-9_-]/g, ""));

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: OPENID,
      templateId,
      page: `pages/result/result?recordId=${safeId}`,
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

