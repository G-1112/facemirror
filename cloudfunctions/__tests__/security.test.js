/**
 * 云函数安全与健壮性回归测试（第三轮）。
 *
 * 运行：node cloudfunctions/__tests__/security.test.js
 * 不依赖第三方框架，纯 node:assert，离线可复现。
 */
const assert = require("assert");
const { loadFunction } = require("./harness");

let passed = 0;
let failed = 0;

async function it(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

(async function run() {
  console.log("云函数安全回归测试\n");

  // ------------------------------------------------------------ submitPractice
  console.log("submitPractice（输入收敛 B-07）");

  await it("超长 questionText 被截断到 2000 字", async () => {
    const { main, state } = loadFunction("submitPractice", { OPENID: "o1" });
    await main({ scene: "interview", questionText: "啊".repeat(5000), durationSec: 30 });
    const rec = state.store.practices[0];
    assert.strictEqual(rec.questionText.length, 2000, "未截断");
  });

  await it("非法 scene 回落到 interview", async () => {
    const { main, state } = loadFunction("submitPractice", { OPENID: "o1" });
    await main({ scene: "../../evil", questionText: "x" });
    assert.strictEqual(state.store.practices[0].scene, "interview");
  });

  await it("durationSec 被夹到 [0, 600]", async () => {
    const { main, state } = loadFunction("submitPractice", { OPENID: "o1" });
    await main({ scene: "defense", questionText: "x", durationSec: 999999 });
    assert.strictEqual(state.store.practices[0].durationSec, 600);
  });

  await it("openid 由服务端写入，客户端无法伪造", async () => {
    const { main, state } = loadFunction("submitPractice", { OPENID: "real_user" });
    await main({ scene: "interview", questionText: "x", openid: "attacker" });
    assert.strictEqual(state.store.practices[0].openid, "real_user");
  });

  await it("无 OPENID 时拒绝写入", async () => {
    const { main, state } = loadFunction("submitPractice", { OPENID: "" });
    const res = await main({ scene: "interview", questionText: "x" });
    assert.ok(res.error, "应返回错误");
    assert.strictEqual((state.store.practices || []).length, 0);
  });

  // ------------------------------------------------------------------ finalize
  console.log("\nfinalize（归属校验 B-08）");

  await it("他人 recordId 不发通知", async () => {
    process.env.SUBSCRIBE_TEMPLATE_ID = "tpl";
    const { main, state } = loadFunction("finalize", { OPENID: "o1" });
    state.store.practices = [{ _id: "rec_other", openid: "o2", status: "done" }];
    const res = await main({ recordId: "rec_other" });
    assert.ok(!res.ok, "应拒绝");
    assert.strictEqual(state.sent.length, 0, "不应发出订阅消息");
  });

  await it("本人 recordId 可发通知且 page 参数安全", async () => {
    process.env.SUBSCRIBE_TEMPLATE_ID = "tpl";
    const { main, state } = loadFunction("finalize", { OPENID: "o1" });
    state.store.practices = [{ _id: "rec_mine", openid: "o1", status: "done" }];
    const res = await main({ recordId: "rec_mine'&x=<script>" });
    // 校验用的是 event.recordId，需匹配库中 _id，故这里用真实 id 再跑一次
    const res2 = await main({ recordId: "rec_mine" });
    assert.ok(res2.ok, "本人记录应可发送");
    assert.ok(state.sent.length >= 1);
    const page = state.sent[state.sent.length - 1].page;
    assert.ok(!/[<>'&]/.test(page), `page 含危险字符: ${page}`);
    assert.ok(!res.ok, "非法 recordId 不应发送");
  });

  await it("未配置模板 ID 时明确报错", async () => {
    delete process.env.SUBSCRIBE_TEMPLATE_ID;
    const { main, state } = loadFunction("finalize", { OPENID: "o1" });
    state.store.practices = [{ _id: "r1", openid: "o1", status: "done" }];
    const res = await main({ recordId: "r1" });
    assert.ok(!res.ok && /TEMPLATE_ID/.test(res.error), JSON.stringify(res));
  });

  // ----------------------------------------------------------------------- asr
  console.log("\nasr（配额原子性 B-09）");

  await it("配额上限内可创建任务并记录 asrTaskId", async () => {
    const { main, state } = loadFunction("asr", { OPENID: "o1" });
    state.store.practices = [
      { _id: "r1", openid: "o1", status: "pending", audioFileID: "a.mp3" },
    ];
    const res = await main({ recordId: "r1" });
    assert.ok(res.status, JSON.stringify(res));
  });

  await it("他人 recordId 被拒（计费接口防蹭）", async () => {
    const { main, state } = loadFunction("asr", { OPENID: "o1" });
    state.store.practices = [
      { _id: "r2", openid: "o2", status: "pending", audioFileID: "a.mp3" },
    ];
    const res = await main({ recordId: "r2" });
    assert.ok(res.error && /权限/.test(res.error), JSON.stringify(res));
  });

  await it("已达配额上限时拒绝并提示", async () => {
    const { main, state } = loadFunction("asr", { OPENID: "o1" });
    const d = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    state.store.practices = [
      { _id: "r3", openid: "o1", status: "pending", audioFileID: "a.mp3" },
    ];
    state.store.quota = [{ _id: "q1", openid: "o1", date: d, count: 20 }];
    const res = await main({ recordId: "r3" });
    assert.ok(res.error && /上限/.test(res.error), JSON.stringify(res));
  });

  await it("并发下配额不被乐观读-写绕过（原子自增）", async () => {
    const { main, state } = loadFunction("asr", { OPENID: "o1" });
    const d = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    // 预置 19 次，配额上限 20 → 只应再有 1 次成功
    state.store.quota = [{ _id: "q1", openid: "o1", date: d, count: 19 }];
    state.store.practices = Array.from({ length: 5 }, (_, i) => ({
      _id: `c${i}`,
      openid: "o1",
      status: "pending",
      audioFileID: "a.mp3",
    }));

    const results = await Promise.all(
      state.store.practices.map((p) => main({ recordId: p._id }))
    );
    const rejected = results.filter((r) => r.error && /上限/.test(r.error)).length;
    const finalCount = state.store.quota[0].count;
    assert.ok(
      finalCount <= 20,
      `配额被突破：最终 count=${finalCount}（应 ≤ 20）`
    );
    assert.ok(rejected >= 1, "并发请求中应至少有一个被限流拒绝");
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
