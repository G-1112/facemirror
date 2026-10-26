// 转写人工修正（FR-06）：ASR 误差兜底 + 体验加分项
//
// 安全（审计修复 B-01 / B-02）：
//   B-01 原实现未校验归属，任何登录用户可篡改他人记录（IDOR 写）；
//   B-02 转写文本直接入库，未过内容安全，违反微信 UGC 审核要求。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_TRANSCRIPT_LEN = 5000;

/**
 * 服务端内容安全检测：未通过或接口异常一律拒绝写入（fail-close）。
 *
 * 排障增强（2026-10-26）：原先 catch 把异常整个吞掉，只抛一句
 * "内容安全检测暂不可用"，导致**底层真实原因永久丢失**——
 * 云函数日志里看不到任何东西，客户端只看到一个笼统的 toast。
 * 现在把原始 errMsg 拼进错误消息，日志里一眼可辨：
 *   -604101 → 缺 permissions.openapi / 10 分钟权限缓存期
 *   -502005 → 集合不存在
 *   其他     → 原始 errMsg 原样带出
 */
async function assertSafe(text) {
  if (!text || !text.trim()) return;
  let risky = false;
  let unavailable = false;
  let rawErr = "";
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
    rawErr = String((e && (e.errMsg || e.message)) || e || "unknown");
    // 原始原因写进云函数日志（客户端只看到精简后的文案）
    console.error("[updateTranscript] msgSecCheck 失败:", rawErr);
  }
  if (risky) throw new Error("内容包含违规信息，请修改后重试");
  if (unavailable) {
    // 保留原始原因的后半段（去掉 "cloud.callFunction:fail" 之类前缀）
    const reason = rawErr.replace(/^.*?fail\s*:?\s*/i, "").trim() || rawErr;
    throw new Error(
      "内容安全检测暂不可用，请稍后重试（原因：" + reason.slice(0, 120) + "）"
    );
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { recordId, transcript } = event;
  // 第九轮加固：OPENID 缺失时 where({openid: undefined}) 可能被引擎忽略 → 改到他人记录
  if (!OPENID) return { error: "未登录" };
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
      // 数据一致性（第十一轮审查 B-16）：转写变更后旧报告即失效，
      // 必须清除，否则结果页会继续展示基于旧文本的报告（文不对题）。
      report: _.remove(),
    },
  });
  return { ok: true };
};
