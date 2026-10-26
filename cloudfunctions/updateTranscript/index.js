// 转写人工修正（FR-06）：ASR 误差兜底 + 体验加分项
//
// 安全（审计修复 B-01 / B-02）：
//   B-01 原实现未校验归属，任何登录用户可篡改他人记录（IDOR 写）；
//   B-02 转写文本直接入库，未过内容安全，违反微信 UGC 审核要求。
const cloud = require("wx-server-sdk");
const { checkText } = require("./sec-check");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const MAX_TRANSCRIPT_LEN = 5000;

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

  // 内容安全检测（见 sec-check.js 的设计说明）：
  //   ① 判定违规 → 直接抛错，拒绝写入（微信 UGC 审核硬要求）
  //   ② 检测服务不可用（61010 / 45009 / -604101 等平台侧原因）→ 降级放行，
  //      但在记录上留痕（seccheck / seccheckReason），可事后审计复核。
  //   原实现是 catch 里吞掉异常只抛一句「暂不可用」，导致：
  //     - 用户输入正常内容也被拒 → 整条「录音 → 人工转写 → 评估 → 报告」主链路断裂
  //     - 且真实原因永远丢失（云函数日志里什么都没有）
  let sec;
  try {
    sec = await checkText(text, {
      openid: OPENID,
      scene: 2,
      rejectMessage: "内容包含违规信息，请修改后重试",
    });
  } catch (e) {
    // 内容违规：返回业务错误而不是抛异常。
    // 抛异常会被微信包装成 errCode -504002「云函数执行失败」，
    // 客户端虽能靠 errMsg 的 message: 字段还原文案，但语义上不准确；
    // 返回 { error } 则是明确的业务失败，客户端 callChecked 会直接抛出可读文案。
    return { error: (e && e.message) || "内容包含违规信息，请修改后重试" };
  }

  await db.collection("practices").doc(recordId).update({
    data: {
      transcript: text,
      status: "asr_done", // 修正后进入待分析态
      // 数据一致性（第十一轮审查 B-16）：转写变更后旧报告即失效，
      // 必须清除，否则结果页会继续展示基于旧文本的报告（文不对题）。
      report: _.remove(),
      // 留痕：内容安全检测未生效（平台接口不可用）时标记，供事后人工复核。
      // seccheck = "pass" 表示已检测通过；"unavailable" 表示检测服务不可用而降级放行。
      seccheck: sec.degraded ? "unavailable" : "pass",
      seccheckReason: sec.degraded ? sec.reason : "",
    },
  });
  return { ok: true };
};
