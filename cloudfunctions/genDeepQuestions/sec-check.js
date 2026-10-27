/**
 * 服务端内容安全检测（security.msgSecCheck）封装。
 *
 * ⚠️ 本文件是**独立副本**：云函数不能跨目录 require，
 *    所以 cloudfunctions/{asr,genQuestions,updateTranscript}/sec-check.js
 *    三份内容必须保持一致（与 injection.js / llm.js 的既有模式一致）。
 *
 * ── 设计要点（2026-10-26 排障沉淀）────────────────────────────────
 *
 * 1. **区分两种失败，处置完全不同**：
 *    ① 内容违规（suggest === "risky"）→ **必须拒绝**（微信 UGC 审核硬要求）
 *    ② 检测服务不可用（接口报错）→ **不应让整条主链路断掉**
 *
 * 2. ② 为什么不能一律 fail-close：
 *    msgSecCheck 是**平台侧**接口，会因下列与本项目代码无关的原因失败：
 *      · 61010  用户访问记录超时（未在近两小时访问过小程序）
 *              → 开发者工具模拟器的 openid 访问记录不刷新，**必现**
 *      · 45009  超出每日调用配额（**未上架小程序仅 100 次/天**）
 *              → 反复调试极易触发
 *      · -604101 云调用权限未生效（声明后有约 10 分钟缓存期）
 *      · -1     系统繁忙
 *    这些都会让「用户输入一段正常作答 → 转写提交被拒 → 整条主链路断裂」，
 *    而实际上内容本身没有任何问题。
 *
 * 3. 降级策略（fail-open，但**留痕 + 可审计**）：
 *    检测服务不可用时 → 放行写入，但在记录上打 `seccheck: "unavailable"` 标记，
 *    并把原始 errMsg 写进 `seccheckReason` 字段。
 *    ⇒ 事后可在云数据库里筛出所有未经检测的记录做人工复核；
 *    ⇒ 违规内容若真被写入，也能在标记记录里被追溯发现。
 *    而「检测服务正常且判定违规」→ 一律拒绝，绝不放行。
 *
 * 4. ⚠️ 与微信审核的关系（重要，不要误删本文件）：
 *    微信审核要求「用户生成的内容经过安全检测」。
 *    本模块在**检测服务正常时**严格执行检测（违规必拒）；
 *    仅在**平台接口本身不可用**时降级放行，且留痕可审计。
 *    降级不是「跳过检测」，而是「检测服务挂了时的可用性兜底」。
 *
 * 5. 频率限制（官方）：单个 AppId 4000 次/分钟、200 万次/天；
 *    **未上架小程序仅 100 次/天** —— 调试期务必注意。
 */

const cloud = require("wx-server-sdk");

/** 官方限制：content 文本字数上限 2500 字（UTF-8） */
const MAX_CONTENT_LEN = 2500;

/**
 * 可安全降级（fail-open）的错误码白名单。
 * 这些错误码说明「检测服务不可用」，而非「内容违规」。
 * -1      系统繁忙
 * 61010   用户访问记录超时（用户未在近两小时访问小程序）
 * 45009   超出每日调用配额（未上架小程序 100 次/天）
 * 44991   超出每分钟调用限制
 * -604101 云调用无权限（声明后有约 10 分钟缓存期）
 * -501001 云端系统错误
 */
const DEGRADABLE_CODES = [
  "-1",
  "61010",
  "45009",
  "44991",
  "-604101",
  "-501001",
];

/** 从异常里提取错误码（errCode / errcode / errMsg 中的数字） */
function extractCode(err) {
  if (!err) return "";
  const direct = err.errCode != null ? err.errCode : err.errcode;
  if (direct != null && direct !== "") return String(direct);
  const raw = String(err.errMsg || err.message || "");
  const m = raw.match(/(?:errCode|errcode|error code)\s*[:：]?\s*(-?\d+)/i);
  if (m) return m[1];
  const m2 = raw.match(/\b(-604101|-501001|61010|45009|44991|-1)\b/);
  return m2 ? m2[1] : "";
}

/** 清洗错误文本：剥掉框架前缀，只留人能看懂的原因 */
function cleanReason(err) {
  const raw = String((err && (err.errMsg || err.message)) || err || "unknown");
  return (
    raw
      .replace(/^cloud\.callFunction\s*:?\s*(fail\s*:?\s*)?/i, "")
      .replace(/^request:fail\s*/i, "")
      .replace(/^err(?:Code|code)\s*[:：]?\s*/i, "")
      .trim() || "unknown"
  );
}

/**
 * 内容安全检测。
 *
 * @param {string} text 待检测文本
 * @param {object} [opts]
 *   - openid   用户 openid（缺省取当前调用者）
 *   - scene    场景：1 资料 / 2 评论 / 3 论坛 / 4 社交日志（默认 2 评论）
 *   - rejectMessage   判定为违规时抛出的错误文案
 *   - unavailableMessage 检测服务不可用时抛出的错误文案（仅严格模式使用）
 *   - strict   true = fail-close（检测不可用也拒绝）；
 *               false（默认）= fail-open 降级放行 + 留痕
 * @returns {Promise<{ok:boolean, degraded:boolean, suggest:string, reason:string}>}
 * @throws  {Error} 判定为违规时（strict 模式下检测不可用时也抛）
 */
async function checkText(text, opts) {
  const options = opts || {};
  const rejectMessage = options.rejectMessage || "内容包含违规信息，请修改后重试";
  const unavailableMessage = options.unavailableMessage || "内容安全检测暂不可用，请稍后重试";

  if (!text || !String(text).trim()) {
    return { ok: true, degraded: false, suggest: "", reason: "" };
  }

  let openid = options.openid;
  if (!openid) {
    try {
      openid = cloud.getWXContext().OPENID;
    } catch (_) {
      openid = "";
    }
  }

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: String(text).slice(0, MAX_CONTENT_LEN),
      version: 2,
      scene: options.scene || 2,
      openid: openid || "",
    });
    const suggest = (res && res.result && res.result.suggest) || "pass";
    if (suggest === "risky") {
      throw new Error(rejectMessage);
    }
    return { ok: true, degraded: false, suggest, reason: "" };
  } catch (e) {
    // ① 判定为违规：这是我们**自己**抛出的（rejectMessage），必须拒绝，不得降级
    if (e && e.message === rejectMessage) throw e;

    const code = extractCode(e);
    const reason = cleanReason(e);
    const degradable = DEGRADABLE_CODES.indexOf(code) >= 0;

    // 原始原因写进云函数日志（客户端只看到精简文案）
    console.error(
      "[sec-check] msgSecCheck 失败 code=" + (code || "?") + " degradable=" + degradable + " reason=" + reason
    );

    // ② 检测服务不可用
    if (options.strict) {
      throw new Error(unavailableMessage + "（原因：" + reason.slice(0, 120) + "）");
    }

    // ③ 降级放行（默认）：由调用方决定是否留痕
    return {
      ok: true,
      degraded: true,
      suggest: "unavailable",
      reason: "code=" + (code || "?") + " " + reason.slice(0, 200),
    };
  }
}

/**
 * 兼容旧调用点的包装：违规/不可用都抛错。
 * 保留给需要严格 fail-close 的场景。
 */
async function assertSafeStrict(text, opts) {
  const options = Object.assign({}, opts || {}, { strict: true });
  await checkText(text, options);
}

module.exports = { checkText, assertSafeStrict, MAX_CONTENT_LEN, DEGRADABLE_CODES };
