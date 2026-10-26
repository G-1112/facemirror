// 内容安全检测模块回归测试（sec-check.js）
//
// 背景（2026-10-26 -504002 排障）：
//   updateTranscript 报 errCode -504002，云函数日志里真实原因是
//   msgSecCheck 调用失败。原实现是「catch 里吞异常 → 一律 fail-close 抛错」，
//   导致平台接口一挂（61010 / 45009 / -604101），用户输入一段正常作答
//   也被拒 → 「录音 → 人工转写 → 评估 → 报告」主链路整条断裂。
//
// 本测试验证 sec-check.js 的核心契约：
//   ① 判定为 risky（违规）→ **必须抛错**，绝不放行（微信 UGC 审核硬要求）
//   ② 检测服务不可用且错误码可降级 → 放行 + degraded=true + 带原因
//   ③ 检测服务不可用且错误码不可降级 → 仍应放行但记录原因（不阻断用户）
//   ④ strict 模式 → 一律抛错（fail-close）
//   ⑤ 空文本 → 直接放行，不调接口
//   ⑥ 自己抛的「违规」错误不得被误判成「服务不可用」而降级
//
// ⚠️ 断言必须有牙齿：反向验证过 —— 把 checkText 里的
//    「if (e && e.message === rejectMessage) throw e;」删掉，
//    场景 ① 立刻 FAIL（违规会被当成不可用而放行）。
//
// 运行：node cloudfunctions/__tests__/sec_check.test.js

const path = require("path");
const Module = require("module");

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log("  [PASS] " + name);
  } else {
    console.log("  [FAIL] " + name + (detail ? " -> " + detail : ""));
    failed++;
  }
};

/**
 * 加载真实的 sec-check.js，注入可控的 wx-server-sdk 桩。
 * @param {object} opts
 *   - mode: "risky" | "pass" | "throw" | "throwNonDegradable"
 *   - errCode: 抛异常时携带的错误码
 */
function loadSecCheck(opts) {
  const options = Object.assign({ mode: "pass", errCode: "61010" }, opts || {});
  // __dirname = cloudfunctions/__tests__ → 上两级是 cloudfunctions 的父目录，
  // 再进 cloudfunctions/<name>/sec-check.js
  const SEC_CHECK_PATH = path.join(
    __dirname,
    "..",
    "updateTranscript",
    "sec-check.js"
  );

  const calls = [];
  const cloudStub = {
    getWXContext: () => ({ OPENID: "openid-test" }),
    openapi: {
      security: {
        msgSecCheck: async (p) => {
          calls.push(p);
          if (options.mode === "risky") {
            return { errcode: 0, result: { suggest: "risky", label: 20002 } };
          }
          if (options.mode === "pass") {
            return { errcode: 0, result: { suggest: "pass", label: 100 } };
          }
          if (options.mode === "throwNonDegradable") {
            const e = new Error("unexpected: internal data format error");
            e.errCode = 47001;
            e.errMsg = "openapi.security.msgSecCheck:fail data format error errCode: 47001";
            throw e;
          }
          // mode === "throw"
          const e = new Error("service unavailable");
          e.errCode = options.errCode;
          e.errMsg =
            "openapi.security.msgSecCheck:fail system error: error code: " + options.errCode;
          throw e;
        },
      },
    },
  };

  // 用 Module._load 拦截 require("wx-server-sdk")
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "wx-server-sdk") return cloudStub;
    return origLoad.call(this, request, parent, isMain);
  };
  let mod;
  try {
    delete require.cache[require.resolve(SEC_CHECK_PATH)];
    mod = require(SEC_CHECK_PATH);
  } finally {
    Module._load = origLoad;
  }
  return { mod, calls };
}

async function main() {
  console.log("=== 内容安全检测模块回归测试（sec-check.js）===");

  // ── 场景 1：★判定违规必须抛错，绝不放行 ─────────────────────────────
  console.log("\n场景 1：★suggest=risky → 必须拒绝（UGC 审核硬要求）");
  {
    const { mod, calls } = loadSecCheck({ mode: "risky" });
    let threw = null;
    try {
      await mod.checkText("违规内容", { openid: "o1", rejectMessage: "内容包含违规信息，请修改后重试" });
    } catch (e) {
      threw = e;
    }
    check("抛出了错误", !!threw, "未抛错");
    check(
      "错误文案是「内容包含违规信息」",
      threw && threw.message === "内容包含违规信息，请修改后重试",
      threw && threw.message
    );
    check("确实调用了接口", calls.length === 1, String(calls.length));
  }

  // ── 场景 2：★自己抛的违规错误不得被当成「服务不可用」而降级 ──────────
  console.log("\n场景 2：★违规错误不被误判为不可用（降级路径不能吞掉违规）");
  {
    const { mod } = loadSecCheck({ mode: "risky" });
    let threw = null;
    try {
      await mod.checkText("违规", { openid: "o1", rejectMessage: "内容包含违规信息，请修改后重试" });
    } catch (e) {
      threw = e;
    }
    check("仍然抛出（未被降级放行）", !!threw, "被放行了");
    check(
      "抛的是违规文案而非「暂不可用」",
      threw && threw.message.indexOf("违规") >= 0 && threw.message.indexOf("暂不可用") < 0,
      threw && threw.message
    );
  }

  // ── 场景 3：检测通过 → 正常放行 ────────────────────────────────────
  console.log("\n场景 3：suggest=pass → 正常放行");
  {
    const { mod, calls } = loadSecCheck({ mode: "pass" });
    const r = await mod.checkText("正常作答内容", { openid: "o1" });
    check("返回 ok=true", r.ok === true, JSON.stringify(r));
    check("未降级", r.degraded === false, JSON.stringify(r));
    check("suggest=pass", r.suggest === "pass", r.suggest);
    check("调用了接口", calls.length === 1, String(calls.length));
    check("传了 openid", calls[0] && calls[0].openid === "o1", JSON.stringify(calls[0]));
    check("version 固定为 2", calls[0] && calls[0].version === 2, JSON.stringify(calls[0]));
  }

  // ── 场景 4：★可降级错误（61010）→ 放行 + 留痕 ──────────────────────
  console.log("\n场景 4：★61010（用户访问记录超时）→ 降级放行并带原因");
  {
    const { mod } = loadSecCheck({ mode: "throw", errCode: "61010" });
    let threw = null;
    let r = null;
    try {
      r = await mod.checkText("正常作答", { openid: "o1" });
    } catch (e) {
      threw = e;
    }
    check("没有抛错（主链路不被阻断）", !threw, threw && threw.message);
    check("返回 ok=true", r && r.ok === true, JSON.stringify(r));
    check("标记 degraded=true", r && r.degraded === true, JSON.stringify(r));
    check("suggest=unavailable", r && r.suggest === "unavailable", r && r.suggest);
    check("reason 里带上了错误码", r && r.reason.indexOf("61010") >= 0, r && r.reason);
  }

  // ── 场景 5：其余可降级错误码同样放行 ──────────────────────────────
  console.log("\n场景 5：其余可降级错误码（45009 / -604101 / -1 / 44991）");
  {
    for (const code of ["45009", "-604101", "-1", "44991", "-501001"]) {
      const { mod } = loadSecCheck({ mode: "throw", errCode: code });
      let threw = null;
      try {
        await mod.checkText("正常作答", { openid: "o1" });
      } catch (e) {
        threw = e;
      }
      check("错误码 " + code + " → 不抛错", !threw, threw && threw.message);
    }
  }

  // ── 场景 6：★strict 模式 → 一律抛错（fail-close 保留） ──────────────
  console.log("\n场景 6：★strict 模式 → 检测不可用也抛错");
  {
    const { mod } = loadSecCheck({ mode: "throw", errCode: "61010" });
    let threw = null;
    try {
      await mod.checkText("正常作答", {
        openid: "o1",
        strict: true,
        unavailableMessage: "内容安全检测暂不可用，请稍后重试",
      });
    } catch (e) {
      threw = e;
    }
    check("抛出了错误", !!threw, "未抛错");
    check(
      "文案含「暂不可用」",
      threw && threw.message.indexOf("暂不可用") >= 0,
      threw && threw.message
    );
    check(
      "★错误消息里带上了真实原因（61010）",
      threw && threw.message.indexOf("61010") >= 0,
      threw && threw.message
    );
  }

  // ── 场景 7：空文本不调接口 ─────────────────────────────────────────
  console.log("\n场景 7：空文本 → 直接放行，不调接口");
  {
    for (const t of ["", "   ", null, undefined]) {
      const { mod, calls } = loadSecCheck({ mode: "pass" });
      const r = await mod.checkText(t, { openid: "o1" });
      check(
        "空文本 " + JSON.stringify(t) + " 放行且不调接口",
        r.ok === true && calls.length === 0,
        "calls=" + calls.length
      );
    }
  }

  // ── 场景 8：不可降级错误码也放行（但记录原因） ──────────────────────
  console.log("\n场景 8：未知错误码（如 47001）→ 放行但记录原因");
  {
    const { mod } = loadSecCheck({ mode: "throwNonDegradable" });
    let threw = null;
    let r = null;
    try {
      r = await mod.checkText("正常作答", { openid: "o1" });
    } catch (e) {
      threw = e;
    }
    check("不抛错", !threw, threw && threw.message);
    check("标记 degraded=true", r && r.degraded === true, JSON.stringify(r));
    check("reason 里带上了 47001", r && r.reason.indexOf("47001") >= 0, r && r.reason);
  }

  // ── 场景 9：content 长度截断到 2500 ────────────────────────────────
  console.log("\n场景 9：超长文本截断到 2500 字");
  {
    const { mod, calls } = loadSecCheck({ mode: "pass" });
    await mod.checkText("x".repeat(9000), { openid: "o1" });
    check("传给接口的 content 长度 = 2500", calls[0] && calls[0].content.length === 2500, String(calls[0] && calls[0].content.length));
  }

  // ── 场景 10：三份副本必须一致（云函数不能跨目录 require） ──────────
  console.log("\n场景 10：★三份 sec-check.js 副本必须完全一致");
  {
    const fs = require("fs");
    const files = ["asr", "genQuestions", "updateTranscript"].map(
      (d) => path.join(__dirname, "..", d, "sec-check.js")
    );
    const contents = files.map((f) => fs.readFileSync(f, "utf8"));
    const same = contents.every((c) => c === contents[0]);
    check("asr / genQuestions / updateTranscript 三份副本内容一致", same, "副本已漂移");
    check("三份文件都存在", contents.length === 3, String(contents.length));
  }

  console.log("\n" + "=".repeat(52));
  if (failed === 0) {
    console.log("全部通过：10 个场景均符合预期");
  } else {
    console.log("失败 " + failed + " 项");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试运行异常：", e);
  process.exit(1);
});
