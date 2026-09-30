// utils/util.js — 面镜技能分包工具层（独立分包自包含，不依赖主包任何模块）
//
// [ai-mode:static] 本分包由静态分析生成，未经真机验证（无开发者工具 + AppID 未开通
// 小程序 AI 开发模式）；响应字段来源见 .ai-mode-skills/analysis-apis.md。

// ---- 返回值工厂 ----

function errorResult(msg) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

function successResult(msg, structuredContent) {
  const result = { isError: false, content: [{ type: "text", text: msg }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

// ---- 云开发初始化（独立分包不共享主包 app.ts 的 wx.cloud.init） ----

// 与主包 miniprogram/utils/config.ts 的 CLOUD_ENV 保持一致；空串 = 默认环境。
const CLOUD_ENV = "cloudbase-d1g6atosn49a1b532";

let _cloudInited = false;
function ensureCloudInit() {
  if (_cloudInited) return;
  wx.cloud.init({ env: CLOUD_ENV || undefined, traceUser: true });
  _cloudInited = true;
}

// ---- 云函数调用封装（对齐主包 miniprogram/utils/api.ts 的 call()：
//      云函数约定以 { error } 返回失败，封装层统一抛出） ----

async function callCloud(name, data) {
  ensureCloudInit();
  console.info("[ai-mode] callCloud 请求:", name, JSON.stringify(data || {}));
  const res = await wx.cloud.callFunction({ name, data: data || {} });
  const result = res && res.result;
  console.info("[ai-mode] callCloud 响应:", name, result && result.error ? "error=" + result.error : "ok");
  if (result && result.error) throw new Error(result.error);
  return result;
}

module.exports = { errorResult, successResult, ensureCloudInit, callCloud };
