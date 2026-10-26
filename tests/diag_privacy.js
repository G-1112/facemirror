// 隐私协议 / 麦克风权限诊断（排查用，保留供后续复现）
//
// 📍 存放位置：仓库根 tests/ —— **不在 miniprogramRoot 内，不进小程序包**。
//
// 用法（开发者工具 Console 无法直接加载本文件，需挂载到运行中的代码里）：
//   方式 A：临时在 miniprogram/pages/record/record.ts 的 onLoad 开头加一行
//           require("../../../tests/diag_privacy.js");
//           编译后 Console 会自动打印诊断结论，用完删掉这一行。
//   方式 B：临时在 miniprogram/app.ts 的 onLaunch 开头加一行
//           require("../../tests/diag_privacy.js");
//
// 目的：区分三种「录不了音」的原因：
//   ① mp 后台未声明「访问你的麦克风」隐私类型 → errno 112（接口被平台禁用，代码救不了）
//   ② 用户未同意隐私保护指引                  → 官方隐私弹窗可解决
//   ③ 用户拒绝过麦克风授权                    → 引导去设置页重新开启
//
// 注意：第 3 项探测会调用 wx.requirePrivacyAuthorize —— 官方文档明确它
//       「可用于模拟隐私接口调用」。若后台声明正常，它会弹出官方隐私授权弹窗，
//       这是预期行为，不影响代码。

const APPID = "wx5f84fd45875f4924";
const ENV = "cloudbase-d1g6atosn49a1b532";

function line(s) {
  console.log(s);
}

async function probePrivacySetting() {
  const w = wx;
  if (typeof w.getPrivacySetting !== "function") {
    line("[SKIP] 基础库不支持 wx.getPrivacySetting（需 >= 2.32.3）");
    return { available: false, needAuthorization: false, privacyContractName: "" };
  }
  return new Promise((resolve) => {
    w.getPrivacySetting({
      success: (res) => {
        line("[OK] wx.getPrivacySetting ->");
        line("     needAuthorization = " + res.needAuthorization);
        line("     privacyContractName = " + (res.privacyContractName || "(空，说明后台可能还没配/没通过审核)"));
        resolve({
          available: true,
          needAuthorization: !!res.needAuthorization,
          privacyContractName: res.privacyContractName || "",
        });
      },
      fail: (err) => {
        line("[FAIL] wx.getPrivacySetting -> " + (err && (err.errMsg || err.message)));
        resolve({ available: true, needAuthorization: false, privacyContractName: "" });
      },
    });
  });
}

async function probeRecordAuth() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const v = res.authSetting && res.authSetting["scope.record"];
        line("[OK] wx.getSetting -> scope.record = " + v);
        line(
          "     " +
            (v === true
              ? "已授权"
              : v === false
                ? "用户曾明确拒绝：wx.authorize 不会再弹窗，需引导去设置页"
                : "从未询问：start() 时系统会自动弹权限框")
        );
        resolve(v === true ? "granted" : v === false ? "denied" : "notAsked");
      },
      fail: (err) => {
        line("[FAIL] wx.getSetting -> " + (err && (err.errMsg || err.message)));
        resolve("notAsked");
      },
    });
  });
}

/** 直接探测 errno 112：官方文档说 requirePrivacyAuthorize「可用于模拟隐私接口调用」 */
function probePrivacyAuthorize() {
  const w = wx;
  if (typeof w.requirePrivacyAuthorize !== "function") {
    line("[SKIP] 基础库不支持 wx.requirePrivacyAuthorize（需 >= 2.32.3）");
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    w.requirePrivacyAuthorize({
      success: () => {
        line("[OK] wx.requirePrivacyAuthorize 成功 → 后台隐私类型声明已生效");
        resolve({ ok: true });
      },
      fail: (err) => {
        const msg = (err && (err.errMsg || err.message)) || "";
        const errno = err && err.errno;
        line("[FAIL] wx.requirePrivacyAuthorize -> " + msg + " (errno=" + errno + ")");
        if (String(msg).indexOf("api scope is not declared") >= 0) {
          line("     ★ 这就是 errno 112：后台《用户隐私保护指引》未声明该隐私类型");
        }
        resolve({ ok: false, err: msg, errno: errno });
      },
    });
  });
}

async function diagnose() {
  line("=== 面镜 · 隐私协议 / 麦克风权限诊断 ===");
  line("AppID = " + APPID + " | 云环境 = " + ENV);
  line("");

  const privacy = await probePrivacySetting();
  line("");
  const auth = await probeRecordAuth();
  line("");
  const authz = await probePrivacyAuthorize();
  line("");

  line("=== 结论 ===");
  if (authz && authz.ok === false && String(authz.err).indexOf("api scope is not declared") >= 0) {
    line("→ 【原因①】mp 后台未声明「访问你的麦克风」隐私类型，微信已直接禁用录音接口。");
    line("  修复路径（平台配置项，代码改不了）：");
    line("    mp.weixin.qq.com → 设置 → 服务内容声明 → 用户隐私保护指引 → 更新");
    line("    勾选「访问你的麦克风」并填写用途 → 提交审核 → 通过后约 5 分钟生效");
    line("    开发者工具：清缓存 → 清除授权数据，重新编译");
  } else if (privacy.needAuthorization) {
    line("→ 【原因②】用户尚未同意《用户隐私保护指引》。");
    line("  修复路径：调用隐私接口时微信会弹官方隐私弹窗，点「同意」即可；");
    line("  或小程序右上角菜单 → 关于本小程序 → 隐私保护指引。");
  } else if (auth === "denied") {
    line("→ 【原因③】用户拒绝过麦克风授权，系统不再弹窗。");
    line("  修复路径：wx.openSetting() 引导用户去设置页手动开启「录音」权限。");
  } else if (authz && authz.ok === true) {
    line("→ 后台隐私声明与授权状态均正常。若点「开始作答」仍报 112，");
    line("  多半是后台声明刚提交、尚未生效（需约 5 分钟）或尚未通过审核。");
  } else {
    line("→ 状态不明确，请把上面完整输出贴给开发者排查。");
  }
  return { privacy, auth, authz };
}

module.exports = { diagnose, probePrivacySetting, probeRecordAuth, probePrivacyAuthorize };

diagnose();
