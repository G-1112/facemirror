// 语音识别（FR-05）：云存储音频 → 腾讯云 ASR 录音文件识别 → 带时间戳的转写文本
// 未配置腾讯云凭证时进入 mock 模式，返回空转写，由用户手动输入（FR-06 兜底）。
const cloud = require("wx-server-sdk");
const { checkText } = require("./sec-check");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
// 原子更新指令（_.inc 等），用于并发安全的配额自增（第三轮 B-09）
const _ = db.command;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每日配额（审计修复 B-03）：ASR 与 LLM 都是计费接口，必须按 openid 限流
const DAILY_LIMIT = 20;

function todayKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 按东八区计日
  return d.toISOString().slice(0, 10);
}

/**
 * 检查并占用一次配额。
 *
 * 并发加固（第十一轮审查 B-14）：旧实现按 {openid, date} 查询文档，首次使用时
 * 并发请求会各自 add 出**多条同键文档**，后续计数被拆散，每日上限可被突破。
 * 改为确定性文档 ID（openid_date_action）+ doc().set() 原子 upsert，
 * 同键永远只有一条文档；_.inc 原子自增后读回校验，超额原子回滚。
 */
async function checkQuota(openid) {
  try {
    const date = todayKey();
    const id = `${openid}_${date}_asr`;
    await db.collection("quota").doc(id).set({
      data: { openid, date, action: "asr", count: _.inc(1) },
    });
    const after = await db.collection("quota").doc(id).get();
    if ((after.data.count || 0) > DAILY_LIMIT) {
      await db.collection("quota").doc(id).update({ data: { count: _.inc(-1) } });
      return { ok: false, reason: `今日练习次数已达上限（${DAILY_LIMIT} 次），明天再来吧` };
    }
    return { ok: true };
  } catch (e) {
    // 配额异常时保守放行（避免表未创建导致主流程完全不可用），但记日志
    console.warn("quota check failed:", e.message);
    return { ok: true };
  }
}

/**
 * 只读检查配额（不占用）。
 *
 * 性能修复（B-05）：ASR 是两段式，客户端每 3s 轮询续查，原实现每次 re-entry 都
 * 通过 checkQuota 扣一次配额，一段 30s 录音可把每日 20 次额度耗尽。
 * 正确语义是「每次识别任务占一次」，因此：
 *   - 需要创建新任务时才真正扣减（checkQuota）；
 *   - 续查（复用已有 asrTaskId）与读取已完成记录只做只读检查。
 */
async function peekQuota(openid) {
  try {
    const date = todayKey();
    const id = `${openid}_${date}_asr`;
    const doc = await db.collection("quota").doc(id).get();
    const used = (doc.data && doc.data.count) || 0;
    if (used >= DAILY_LIMIT) {
      return { ok: false, reason: `今日练习次数已达上限（${DAILY_LIMIT} 次），明天再来吧` };
    }
    return { ok: true };
  } catch (e) {
    // 文档不存在（今日还未练习）时 get 会报错，视为未使用
    if (/not exist|not found/i.test(e.message || "")) return { ok: true };
    console.warn("quota peek failed:", e.message);
    return { ok: true };
  }
}

/** 把 fileID 转为临时可访问 URL */
async function getFileUrl(fileID) {
  const res = await cloud.getTempFileURL({ fileList: [fileID] });
  const item = res.fileList && res.fileList[0];
  return item && item.tempFileURL;
}

/**
 * 腾讯云 ASR 录音文件识别。
 *
 * 修复（审计 B-04）：原实现在单次云函数调用内轮询最多 25s，而云函数默认超时 20s，
 * 长音频必然被强杀、结果丢失。改为两段式：
 *   1. 首次调用：创建任务，把 TaskId 存进记录，只做短轮询（≤ POLL_BUDGET_MS）；
 *   2. 未完成时返回 asr_running，客户端轮询再次进入本函数，复用已有 TaskId 续查，
 *      不会重复创建任务（避免重复计费）。
 * 同时在 config.json 声明 60s 超时兜底。
 */
const POLL_INTERVAL_MS = 2000;
const POLL_BUDGET_MS = 12000; // 预留时间给创建任务与写库，避免撞 20s 默认超时

// 热容器内复用的 ASR SDK client（性能修复 B-06）
let _asrClientCache = null;

function asrClient() {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) return null;
  // 性能修复（B-06）：SDK client 在热容器内复用，避免每次轮询都 require + new
  if (_asrClientCache) return _asrClientCache;
  const tencentcloud = require("tencentcloud-sdk-nodejs-asr");
  const AsrClient = tencentcloud.asr.v20190614.Client;
  _asrClientCache = new AsrClient({
    credential: { secretId, secretKey },
    region: "ap-guangzhou",
    profile: { httpProfile: { endpoint: "asr.tencentcloudapi.com" } },
  });
  return _asrClientCache;
}

/** 创建识别任务，返回 TaskId */
async function createAsrTask(url) {
  const client = asrClient();
  if (!client) return null;
  const createRes = await client.CreateRecTask({
    EngineModelType: "16k_zh",
    ChannelNum: 1,
    ResTextFormat: 3, // 词级别时间戳
    SourceType: 1, // URL
    Url: url,
  });
  const taskId = createRes.Data && createRes.Data.TaskId;
  if (!taskId) throw new Error("ASR 创建任务失败");
  return taskId;
}

/** 在预算时间内轮询任务状态：返回 { done, result } */
async function pollAsrTask(taskId, budgetMs = POLL_BUDGET_MS) {
  const client = asrClient();
  if (!client) throw new Error("ASR 客户端不可用");
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const statusRes = await client.DescribeTaskStatus({ TaskId: taskId });
    const status = statusRes.Data && statusRes.Data.Status;
    if (status === 2) return { done: true, result: statusRes.Data.Result }; // 成功
    if (status === 3) throw new Error("ASR 识别失败");
  }
  return { done: false, result: null }; // 尚未完成，交给客户端下次续查
}

/** 解析 ASR 结果 → { transcript, sentences } */
function parseAsrResult(result) {
  if (!result) return { transcript: "", sentences: [] };
  let parsed = result;
  if (typeof result === "string") {
    try {
      parsed = JSON.parse(result);
    } catch (e) {
      return { transcript: result, sentences: [] };
    }
  }
  const transcript = parsed.Result || parsed.result || "";
  // 词级别时间戳 → 组装句子（按标点切句）
  const wordList = parsed.WordList || parsed.word_list || [];
  const sentences = [];
  let buf = "";
  let start = null;
  let end = null;
  for (const w of wordList) {
    const word = w.word || w.Word || "";
    const wStart = (w.start_time || w.startTime || 0) / 1000;
    const wEnd = (w.end_time || w.endTime || 0) / 1000;
    buf += word;
    if (start === null) start = wStart;
    end = wEnd;
    if (/[。！？!?]/.test(word)) {
      sentences.push({ text: buf, start, end });
      buf = "";
      start = null;
      end = null;
    }
  }
  if (buf.trim()) sentences.push({ text: buf, start: start || 0, end: end || 0 });
  return { transcript, sentences };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { recordId } = event;
  // 第九轮加固：OPENID 缺失时 where({openid: undefined}) 可能被引擎忽略，
  // 导致归属校验形同虚设（可读他人转写、消耗他人配额）。显式拒绝更安全。
  if (!OPENID) return { error: "未登录" };
  if (!recordId || typeof recordId !== "string") return { error: "缺少 recordId" };

  // 归属校验（审计修复 B-01）：ASR 是计费接口，未校验归属会被用来刷别人的记录烧钱
  const owned = await db
    .collection("practices")
    .where({ _id: recordId, openid: OPENID })
    .limit(1)
    .get();
  if (!owned.data.length) return { error: "记录不存在或无访问权限" };

  const p = owned.data[0];
  if (!p.audioFileID) return { error: "缺少音频文件" };

  // 已完成识别的记录直接返回结果，避免重复创建任务（重复计费）。
  // 性能修复（B-05）：此分支必须先于配额判断——读取已有结果不应消耗任何配额。
  if (p.status === "asr_done" || p.status === "done" || p.status === "analyzing") {
    return { status: p.status, transcript: p.transcript || "", needManual: !!p.needManual };
  }

  let transcript = "";
  let sentences = [];
  let needManual = false;

  try {
    // 复用已有任务 ID（续查），否则创建新任务
    let taskId = p.asrTaskId;
    if (!taskId) {
      // 仅「创建新任务」才真正占用一次配额（B-05：续查不再重复扣减）
      const quota = await checkQuota(OPENID);
      if (!quota.ok) return { error: quota.reason };
      const url = await getFileUrl(p.audioFileID);
      taskId = await createAsrTask(url);
      if (!taskId) {
        // 未配置腾讯云凭证 → mock：空转写，走人工输入
        needManual = true;
      } else {
        await db.collection("practices").doc(recordId).update({ data: { asrTaskId: taskId } });
      }
    } else {
      // 续查路径：只读检查上限，不扣配额
      const quota = await peekQuota(OPENID);
      if (!quota.ok) return { error: quota.reason };
    }

    if (taskId) {
      const { done, result } = await pollAsrTask(taskId);
      if (!done) {
        // 本轮预算用尽，保持 pending，由客户端轮询续查（不重复计费）
        return { status: "asr_running", needManual: false };
      }
      const parsed = parseAsrResult(result);
      transcript = parsed.transcript;
      sentences = parsed.sentences;
      // 内容安全（审计修复 B-02）：ASR 结果落库前必须过检测
      // 违规必拒；检测服务不可用（61010/45009/-604101）→ 降级放行并留痕。
      // 原实现 fail-close：平台接口一挂，用户正常录音也会被拒
      // → 「录音 → ASR → 报告」主链路直接断裂。
      let sec;
      try {
        sec = await checkText(transcript, {
          openid: cloud.getWXContext().OPENID,
          scene: 2,
          rejectMessage: "内容包含违规信息，请修改后重试",
        });
      } catch (e) {
        // 内容违规 → 返回业务错误，不落库。
        // （抛异常会被包装成 errCode -504002「云函数执行失败」，语义不准确）
        return { error: (e && e.message) || "内容包含违规信息，请修改后重试" };
      }
      if (sec.degraded) {
        // 留痕：供事后审计复核
        try {
          await db.collection("practices").doc(recordId).update({
            data: { seccheck: "unavailable", seccheckReason: sec.reason },
          });
        } catch (_) {
          // 留痕失败不阻断主流程
        }
      }
    }
  } catch (e) {
    console.warn("ASR failed:", e.message);
    // 内容违规：不落库，直接回传原因。
    // （内容安全检测**不可用**已在上方降级放行，不再走这个分支）
    if (/违规/.test(e.message || "")) return { error: e.message };
    needManual = true;
  }

  await db.collection("practices").doc(recordId).update({
    data: {
      transcript,
      sentences,
      status: "asr_done",
      needManual,
    },
  });

  return { status: "asr_done", transcript, needManual };
};
