// 云函数连通性 + 部署完整性诊断（排查用，保留供后续复现）
//
// 📍 存放位置：仓库根 tests/ —— **不在 miniprogramRoot 内，不进小程序包**。
//
// 用法（开发者工具 Console 无法直接加载本文件，需挂载到运行中的代码里）：
//   方式 A：临时在 miniprogram/pages/question/question.ts 的 onLoad 开头加一行
//           require("../../../tests/diag_cloud.js");
//           编译后 Console 会自动打印诊断结论，用完删掉这一行。
//   方式 B：临时在 miniprogram/app.ts 的 onLaunch 开头加一行
//           require("../../tests/diag_cloud.js");
//
// 目的：一次性回答两个问题
//   ① 云开发通不通（环境是否关联 / 网络）
//   ② 云端到底缺哪个云函数（这是「点提交只弹 cloud.callFunction」最常见的原因）
//
// 探测原理：
//   用一个必然不存在的 recordId 调云函数 ——
//     · 函数已部署 → 归属校验失败，返回 { error: "记录不存在或无访问权限" }（result 有值）
//     · 函数未部署 → wx.cloud.callFunction 直接 reject（function not found / -501001）
//   两者可区分。
//
// ⚠️ 安全：探测清单里的函数全部「归属校验在前」，不会写库、不推送、不调 LLM。
//    submitPractice（写库）与 genQuestions（调 LLM）**故意排除**，避免副作用。

const CLOUD_ENV = "cloudbase-d1g6atosn49a1b532";

/** 只读探测清单 */
const PROBE_FUNCTIONS = [
  { name: "login", data: {} },
  { name: "getQuestions", data: { scene: "interview", limit: 1 } },
  { name: "getPractice", data: { recordId: "__probe_not_exist__" } },
  { name: "getHistory", data: { page: 1, pageSize: 1 } },
  { name: "updateTranscript", data: { recordId: "__probe_not_exist__", transcript: "probe" } },
  { name: "asr", data: { recordId: "__probe_not_exist__" } },
  { name: "analyze", data: { recordId: "__probe_not_exist__" } },
  { name: "finalize", data: { recordId: "__probe_not_exist__" } },
];

/** 有副作用、故意不探测的函数 */
const SKIPPED_FUNCTIONS = [
  { name: "submitPractice", why: "会写入 practices 集合" },
  { name: "genQuestions", why: "会调用大模型（产生费用）" },
];

function pad(s, n) {
  let out = String(s);
  while (out.length < n) out += " ";
  return out;
}

/** 探测单个云函数是否已部署 */
async function probeFunction(name, data) {
  const t0 = Date.now();
  try {
    const res = await Promise.race([
      wx.cloud.callFunction({ name, data }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_10S")), 10000)),
    ]);
    const ms = Date.now() - t0;
    const result = res && res.result;
    // result 有值（含 { error: ... }）→ 函数确实在跑，只是业务层拒绝
    return { name, state: "deployed", ms, detail: JSON.stringify(result).slice(0, 80) };
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = String((e && (e.errMsg || e.message)) || e);
    const lower = msg.toLowerCase();
    if (
      lower.includes("function not found") ||
      lower.includes("function_not_found") ||
      lower.includes("-501001") ||
      lower.includes("FUNCTION_NOT_FOUND")
    ) {
      return { name, state: "missing", ms, detail: msg };
    }
    if (lower.includes("timeout")) {
      return { name, state: "timeout", ms, detail: "10 秒未返回（网络/环境问题，非部署问题）" };
    }
    return { name, state: "error", ms, detail: msg };
  }
}

async function probeAllFunctions() {
  const rows = [];
  for (const f of PROBE_FUNCTIONS) {
    const r = await probeFunction(f.name, f.data);
    rows.push(r);
    const tag =
      r.state === "deployed" ? "[已部署]" : r.state === "missing" ? "[未部署]" : "[" + r.state + "]";
    console.log("  " + tag + " " + pad(r.name, 20) + r.ms + "ms  " + r.detail);
  }
  return rows;
}

async function diagnose() {
  console.log("=== 面镜 · 云函数部署与连通性诊断 ===");
  console.log("云环境 = " + CLOUD_ENV);
  console.log("");

  try {
    console.log("当前环境 = " + (wx.cloud.getCurrentCloudEnv ? wx.cloud.getCurrentCloudEnv() : "(API 不可用)"));
  } catch (e) {
    console.log("getCurrentCloudEnv 抛错:", e);
  }
  console.log("");

  console.log("--- 逐个探测云函数是否已部署 ---");
  const rows = await probeAllFunctions();
  console.log("");

  const missing = rows.filter((r) => r.state === "missing");
  const broken = rows.filter((r) => r.state === "timeout" || r.state === "error");

  console.log("--- 故意不探测的函数（有副作用）---");
  for (const s of SKIPPED_FUNCTIONS) {
    console.log("  " + pad(s.name, 20) + s.why);
  }
  console.log("");

  console.log("=== 结论 ===");
  if (missing.length) {
    console.log("→ ★以下云函数未部署：" + missing.map((r) => r.name).join(", "));
    console.log("  修复：开发者工具里对 cloudfunctions/<函数名> 目录右键「上传并部署：云端安装依赖」；");
    console.log("  或执行  python scripts/deploy_cloud.py --apply  （需先在 IDE 设置→安全设置里开启服务端口）");
  }
  if (broken.length) {
    console.log("→ 以下函数无法判定（网络/环境问题，不是部署问题）：" + broken.map((r) => r.name).join(", "));
    console.log("  检查：云环境是否关联、AppID 是否开通云开发、网络是否正常。");
  }
  if (!missing.length && !broken.length) {
    console.log("→ 全部已部署且可连通。若页面仍报 cloud.callFunction，");
    console.log("  请到开发者工具 Console 看 [云函数] 开头的那行日志（含完整 errMsg）。");
  }
  console.log("");
  console.log("提示：若刚上传过云函数，openapi 权限有 10 分钟缓存期，期间报 -604101 属正常。");
  return { rows, missing, broken };
}

module.exports = { diagnose, probeFunction, probeAllFunctions, PROBE_FUNCTIONS, SKIPPED_FUNCTIONS };

diagnose();
