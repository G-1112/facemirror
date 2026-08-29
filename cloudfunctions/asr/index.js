// 语音识别（FR-05）：云存储音频 → 腾讯云 ASR 录音文件识别 → 带时间戳的转写文本
// 未配置腾讯云凭证时进入 mock 模式，返回空转写，由用户手动输入（FR-06 兜底）。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 fileID 转为临时可访问 URL */
async function getFileUrl(fileID) {
  const res = await cloud.getTempFileURL({ fileList: [fileID] });
  const item = res.fileList && res.fileList[0];
  return item && item.tempFileURL;
}

/** 腾讯云 ASR 录音文件识别：创建任务 → 轮询 → 取结果 */
async function tencentAsr(url) {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) return null;

  const tencentcloud = require("tencentcloud-sdk-nodejs-asr");
  const AsrClient = tencentcloud.asr.v20190614.Client;
  const client = new AsrClient({
    credential: { secretId, secretKey },
    region: "ap-guangzhou",
    profile: { httpProfile: { endpoint: "asr.tencentcloudapi.com" } },
  });

  const createRes = await client.CreateRecTask({
    EngineModelType: "16k_zh",
    ChannelNum: 1,
    ResTextFormat: 3, // 词级别时间戳
    SourceType: 1, // URL
    Url: url,
  });
  const taskId = createRes.Data && createRes.Data.TaskId;
  if (!taskId) throw new Error("ASR 创建任务失败");

  // 轮询结果，最多约 25s
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const statusRes = await client.DescribeTaskStatus({ TaskId: taskId });
    const status = statusRes.Data && statusRes.Data.Status;
    if (status === 2) return statusRes.Data.Result; // 成功
    if (status === 3) throw new Error("ASR 识别失败");
  }
  throw new Error("ASR 识别超时");
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
  const { recordId } = event;
  if (!recordId) return { error: "缺少 recordId" };

  const doc = await db.collection("practices").doc(recordId).get();
  const p = doc.data;
  if (!p.audioFileID) return { error: "缺少音频文件" };

  let transcript = "";
  let sentences = [];
  let needManual = false;

  try {
    const url = await getFileUrl(p.audioFileID);
    const result = await tencentAsr(url);
    if (result) {
      const parsed = parseAsrResult(result);
      transcript = parsed.transcript;
      sentences = parsed.sentences;
    } else {
      // 未配置腾讯云凭证 → mock：空转写，走人工输入
      needManual = true;
    }
  } catch (e) {
    console.warn("ASR failed:", e.message);
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
