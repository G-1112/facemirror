/**
 * 第九轮回归：OPENID 缺失时云函数必须显式拒绝。
 *
 * 背景：这些函数用 `where({ _id, openid: OPENID })` 做归属校验。若 OPENID 为
 * undefined（控制台调试、定时触发器、非微信上下文调用），查询条件可能被引擎
 * 忽略，导致读到/改到他人记录。已在 analyze / asr / getPractice /
 * updateTranscript / getHistory 五处补显式守卫。
 *
 * 注意：本地 mock 的 where 用 === 比较，即使无守卫也会因 `doc.openid === undefined`
 * 不匹配而返回空 —— 因此本测试断言的是**显式拒绝**（error 字段），
 * 而不是依赖 mock 的偶然行为。
 */
const { loadFunction } = require("./harness");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? "  → " + extra : ""}`);
  }
}

const CASES = [
  ["analyze", { recordId: "r1" }],
  ["asr", { recordId: "r1" }],
  ["getPractice", { recordId: "r1" }],
  ["updateTranscript", { recordId: "r1", transcript: "x" }],
  ["getHistory", {}],
  ["genQuestions", { fileID: "cloud://x", scene: "interview" }],
  ["getQuestions", { scene: "interview" }],
];

(async () => {
  console.log("=== OPENID 缺失 → 必须显式拒绝 ===");
  for (const [fnName, event] of CASES) {
    let res;
    try {
      const { main } = loadFunction(fnName, { OPENID: "" });
      res = await main(event);
    } catch (e) {
      res = { throws: e.message };
    }
    const rejected = res && (res.error || res.ok === false || res.throws);
    check(
      `${fnName} 无 OPENID 时拒绝`,
      !!rejected,
      `实际: ${JSON.stringify(res).slice(0, 100)}`,
    );
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
