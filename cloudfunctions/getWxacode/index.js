// 分享海报小程序码（FR-11）：wxacode.getUnlimited 生成小程序码并转存云存储
// 返回：{ ok: true, fileID, tempFileURL } 或 { ok: false, errMsg }
// 任何失败（含小程序未发布时 invalid page / 40001 类错误）都捕获后返回 ok:false，
// 由前端静默降级为无码海报，不阻塞海报生成。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * scene 仅允许官方字符集（数字/英文与 !#$&'()*+,/:;=?@-._~），且 ≤32 字符。
 * recordId（数据库 _id，字母数字）与时间戳均在白名单内；其余字符剔除防止调用报错。
 */
function sanitizeScene(raw) {
  const s = String(raw == null ? "" : raw).replace(/[^0-9a-zA-Z!#$&'()*+,/:;=?@-._~]/g, "");
  return s.slice(0, 32);
}

exports.main = async (event) => {
  try {
    // scene 取值优先级：显式 scene → recordId → 时间戳兜底
    const scene = sanitizeScene(event && (event.scene || event.recordId)) || String(Date.now());
    const res = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page: "pages/index/index",
      checkPath: false,
      envVersion: "trial",
    });
    const buffer = res && res.buffer;
    if (!buffer) {
      return { ok: false, errMsg: "getUnlimited 未返回图片数据" };
    }
    const upload = await cloud.uploadFile({
      cloudPath: `wxacode/${scene}-${Date.now()}.png`,
      fileContent: buffer,
    });
    let tempFileURL = "";
    try {
      const urls = await cloud.getTempFileURL({ fileList: [upload.fileID] });
      tempFileURL = (urls.fileList && urls.fileList[0] && urls.fileList[0].tempFileURL) || "";
    } catch (_) {
      // 拿不到临时链接不影响主结果，前端可凭 fileID 走 wx.cloud.downloadFile
    }
    return { ok: true, fileID: upload.fileID, tempFileURL };
  } catch (e) {
    console.error(
      "[getWxacode] 生成失败:",
      e && (e.errMsg || e.errCode || e.message) || e
    );
    return {
      ok: false,
      errMsg: String((e && (e.errMsg || e.message)) || e).slice(0, 200),
    };
  }
};
