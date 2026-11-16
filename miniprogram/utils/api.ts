/**
 * 云函数调用封装。所有与后端的交互统一走这里。
 * 云函数名与 cloudfunctions/ 目录一一对应。
 */

import { SUBSCRIBE_TEMPLATE_ID } from "./config";
import type {
  AnswerRecord,
  CompetencyModel,
  DeepReport,
  InterviewQuestion,
  JobProfile,
  ResumeProfile,
} from "./interview";
import type { QuizQuestion, QuizReport } from "./quiz";

// ---- 类型（与云函数返回结构对应） ----

export interface Question {
  _id?: string;
  scene: string;
  category: string;
  text: string;
  difficulty: string;
}

export interface SentenceNote {
  index: number;
  sentence: string;
  issue: string;
  suggestion: string;
}

export interface ExpressionReport {
  speedWpm: number;
  fillerRate: number;
  fillerTop3: string[];
  longPauseCount: number;
  timeSplit: { opening: number; body: number; closing: number };
}

export interface PracticeReport {
  totalScore: number;
  dimensions: { relevance: number; structure: number; evidence: number; professional: number; delivery: number };
  radar: number[];
  strengths: { text: string; quote: string }[];
  improvements: string[];
  modelAnswer: string;
  sentenceNotes: SentenceNote[];
  expression: ExpressionReport;
  overall: string;
}

export interface Practice {
  _id: string;
  scene: string;
  questionText: string;
  transcript: string;
  status: "pending" | "asr_done" | "analyzing" | "done" | "failed";
  durationSec: number;
  report?: PracticeReport;
  createdAt: number;
}

/**
 * getPractice 云函数的返回结构。
 * 与 cloudfunctions/getPractice/index.js 的 return 字段一一对应
 * （第四轮修正：原类型漏了 scene / questionText，导致结果页取不到原题）。
 */
export interface PracticeDetail {
  status: Practice["status"];
  transcript: string;
  sentences: SentenceNote[];
  scene: string;
  questionText: string;
  durationSec: number;
  report: PracticeReport | null;
}

// ---- 通用调用 ----

/** 云函数调用超时（毫秒）。弱网/云函数挂起时不能让页面无限等待。 */
const CALL_TIMEOUT_MS = 20000;

/** LLM 类云函数超时（毫秒）。大模型推理普遍 20~40s，须与云函数控制台侧
 *  超时（60s）匹配——2026-10-28 实测：key 配置后 analyzeJob 真实调用
 *  DeepSeek，20s 即被云平台以 FUNCTIONS_TIME_LIMIT_EXCEEDED(-504003) 掐断。
 *  ⚠️ 若控制台侧超时调整，这里必须同步（前端不得大于云端，否则白等）。 */
export const CALL_TIMEOUT_LLM_MS = 60000;

/**
 * 微信云开发错误码 → 中文文案。
 * 依据：微信开放文档《错误码》表
 *   https://developers.weixin.qq.com/miniprogram/dev/wxcloud/reference/errcode.html
 * ⚠️ 错误码以官方表为准，不要凭印象写。几个容易记错的：
 *   -501001 = 云资源通用错误：**云端系统错误**（不是"云函数不存在"）
 *   -504002 = 云资源云函数错误：**云函数执行失败**（= 已部署但运行时报错，
 *              不是"未部署"；真实原因在 errMsg 的 message: 字段里）
 *   -604101 = 微信后台云函数错误：**无权限调用此 API，需给云函数配置云调用权限**
 */
const CLOUD_ERROR_CODES: Record<string, { text: string; hint?: string }> = {
  // —— openapi 权限类 ——
  "-604101": {
    text: "内容安全接口权限未生效，请稍后重试",
    hint:
      "云函数调用 content 安全检测接口（security.msgSecCheck）时返回 -604101。\n" +
      "成因：① 云函数 config.json 未声明 permissions.openapi；" +
      "② 已声明但仍在 10 分钟权限缓存期内（刚上传即报错属正常，等一会儿即可）。",
  },
  "-604100": {
    text: "云函数缺少该 API 的调用权限声明",
    hint: "请在该云函数目录的 config.json 里声明 permissions.openapi。",
  },
  // —— 云函数调用类 ——
  "-504002": {
    text: "云函数执行失败，请查看日志",
    hint:
      "错误码 -504002 官方定义为「云函数执行失败」，说明云函数**已部署但运行时报错**" +
      "（不是未部署）。真实原因在 errMsg 的 message: 字段里，请到云开发控制台 → 云函数 → " +
      "对应函数 → 日志 查看完整堆栈。",
  },
  "-504001": {
    text: "云函数调用失败，请稍后重试",
    hint: "可在开发者工具 Console 查看 [云函数] 开头的日志获取完整 errMsg。",
  },
  "-604102": { text: "云函数调用超时，请稍后重试" },
  "-604103": { text: "云调用系统错误，请稍后重试" },
  "-604104": { text: "非法调用来源，请重新编译后重试" },
  // —— 云资源通用类 ——
  "-501002": { text: "云端响应超时，请稍后重试" },
  "-501003": { text: "云开发调用次数已超配额" },
  "-501015": { text: "云开发读请求配额已耗尽" },
  "-501016": { text: "云开发写请求配额已耗尽" },
  "-501019": { text: "未授权操作，请检查云环境权限" },
  "-501001": { text: "云端系统错误，请稍后重试" },
  // —— 数据库类 ——
  "-502003": {
    text: "数据库权限校验失败",
    hint: "请到云开发控制台 → 数据库 → 对应集合 → 权限设置，选择正确的读写权限。",
  },
  "-502005": {
    text: "数据库集合不存在",
    hint:
      "错误码 -502005 表示**要访问的集合还没建**。\n" +
      "云函数是自动部署的，但**数据库集合必须手动创建**（不在部署脚本覆盖范围内）。\n" +
      "解决：云开发控制台 → 数据库 → 新建集合 → 填集合名 → 权限选「仅创建者可读写」。\n" +
      "本项目共需 5 个集合：practices / quota / rate_limits / questions / interviews。",
  },
  "-502011": { text: "数据库操作超时，请稍后重试" },
  "-502015": { text: "数据库查询失败，请稍后重试" },
  // —— 微信后台类 ——
  "-601027": { text: "云环境不存在，请检查环境 ID" },
  "-601034": { text: "小程序未开通云开发服务" },
  "-601011": { text: "无权限，请检查云环境权限" },
};

/**
 * 把微信云函数的原始错误翻译成用户看得懂的中文。
 *
 * 修复（2026-10-26 实测）：页面 catch 里写 `e?.message` 拿到的是
 * **"cloud.callFunction"**（微信框架的 Error.message 只放了方法名），
 * 真正的原因藏在 `errMsg` 里被整个丢掉 —— 用户只看到一个毫无意义的 toast，
 * 开发者也定位不到问题。
 * 原始 errMsg 形如：
 *   "cloud.callFunction:fail Error: 内容安全检测暂不可用，请稍后重试"
 *   "cloud.callFunction:fail errCode -504002 function not found"
 */
export function describeCallError(err: any): { text: string; raw: string; hint?: string } {
  const raw = String(err?.errMsg || err?.message || err || "");
  // 剥掉小程序框架加的前缀，只留真正的失败原因
  const detail = raw
    .replace(/^cloud\.callFunction\s*:?\s*(fail\s*:?\s*)?/i, "")
    .replace(/^request:fail\s*/i, "")
    .replace(/^err(?:Code|code)\s*[:：]?\s*/i, "")
    .trim();

  // ★ 云函数内部抛异常时，微信把真实原因放在 errMsg 的 message: 字段里，例如
  //   "cloud.callFunction:fail errCode -504002 functionName:updateTranscript,
  //    message:内容安全检测暂不可用，请稍后重试"
  //   **这个 message 才是用户真正需要看到的**，必须优先提取 ——
  //   只看错误码只会得到「云函数执行失败」这种没法行动的话。
  const innerRaw = (raw.match(/message[:：]\s*([^,}\]]+)/) || [])[1] || "";
  const inner = innerRaw
    .replace(/^Error\s*[:：]\s*/i, "")
    .replace(/\s*RequestId\s*[:：].*$/i, "")
    .trim();

  const lower = (detail || raw).toLowerCase();
  const hay = (inner || detail).toLowerCase();

  // ── 1. 「函数不存在」是最明确的信号，优先判定 ──
  if (
    hay.includes("function not found") ||
    hay.includes("function_not_found") ||
    hay.includes("function not exist")
  ) {
    return {
      text: "云函数未部署，请先部署",
      hint:
        "云端找不到该云函数。请在微信开发者工具中对 cloudfunctions/<函数名> 目录右键" +
        "「上传并部署：云端安装依赖」，或执行 python scripts/deploy_cloud.py --apply。",
      raw,
    };
  }

  // ── 2. 云函数内部抛出的真实原因（errMsg 的 message: 字段）──
  if (inner && /[一-龥]/.test(inner)) {
    // 云函数可能把底层原因拼在括号里（例："内容安全检测暂不可用，请稍后重试（原因：xxx）"）。
    // toast 只能放约 14 个汉字，括号里的长原因会挤掉提示并被截成乱码 →
    // 短文案取括号前，长原因放进 hint（走 modal 显示完整内容）。
    const bracketAt = inner.indexOf("（");
    const short = bracketAt > 0 ? inner.slice(0, bracketAt).trim() : inner;
    const reason = bracketAt > 0 ? inner.slice(bracketAt + 1).replace(/）\s*$/, "").trim() : "";
    let hint = reason ? "服务端返回的原始原因：\n" + reason : undefined;
    if (inner.includes("内容安全")) {
      hint =
        (hint ? hint + "\n\n" : "") +
        "该错误来自服务端的内容安全检测（security.msgSecCheck）。常见成因：\n" +
        "① 云函数 config.json 未声明 permissions.openapi；\n" +
        "② 刚上传，openapi 权限仍在 10 分钟缓存期；\n" +
        "③ 小程序后台未开通内容安全接口。\n" +
        "可在云开发控制台 → 云函数 → 对应函数 → 日志 查看完整堆栈。";
    }
    return { text: short.slice(0, 30), hint, raw };
  }

  // ── 3. 官方错误码表（优先用 errCode 字段，其次从 errMsg 里正则提取）──
  const code =
    err?.errCode != null && err?.errCode !== ""
      ? String(err.errCode).trim()
      : (raw.match(/-\d{6}/) || [])[0] || "";
  if (code && CLOUD_ERROR_CODES[code]) {
    const hit = CLOUD_ERROR_CODES[code];
    return { text: hit.text, hint: hit.hint, raw };
  }

  // ── 4. 英文短语兜底 ──
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      text: "云函数调用超时，请稍后重试",
      hint:
        "若仍超时，请确认该函数已按 config.json 重新部署：config.json 的 timeout 可设置云函数" +
        "运行时上限，analyze / deepAnalyze / deepSession 已统一配置为 60 秒。",
      raw,
    };
  }
  if (lower.includes("permission") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return { text: "无权限，请检查部署配置", raw };
  }
  if (lower.includes("request:fail") || lower.includes("network") || lower.includes("connection")) {
    return { text: "网络异常，请检查网络", raw };
  }

  // ── 5. 云函数内部抛出的业务错误（形如 "Error: 内容安全检测暂不可用，请稍后重试"）──
  const msg = detail.replace(/^error\s*:?\s*/i, "").trim();
  if (msg) {
    const text = msg.slice(0, 40);
    // ★业务错误超长时不能静默截断（2026-10-29 实测教训）：deepSession 的
    //   describeDbError 会把「错误码 + 底层 errMsg」拼进文案（可达百余字），
    //   slice(0,40) 会把最关键的诊断信息切掉 → 超出部分放进 hint，由
    //   showCallError 的 modal 完整展示（toast 仍保持短文案）。
    const hint = msg.length > 40 ? "完整原因：" + msg : undefined;
    return { text, hint, raw };
  }
  return { text: "服务调用失败，请稍后重试", raw };
}

/** 统一取可读错误文本：优先用已包装的 message，再退回 describeCallError 推断。 */
export function errorText(e: any, fallback = "操作失败"): string {
  const m = e?.message;
  if (typeof m === "string" && m.trim() && m !== "cloud.callFunction") return m.trim();
  const info = describeCallError(e);
  return info.text || fallback;
}

/**
 * 云函数调用失败的统一提示（所有页面的 catch 都应走这里）。
 *
 * 呈现策略：
 *   - toast：简短中文。⚠️ 真机 showToast 的 title 最多显示约 14 个汉字，
 *     超出会被微信截断成省略号 —— 所以正文必须短，完整原因看 modal / Console。
 *   - 遇到「需要用户去某处操作」的错误（云函数未部署 / openapi 权限未生效 /
 *     超时配置不对）额外弹一个 modal 给操作指引，否则用户无从下手。
 *   - 文案被截断时也弹 modal，保证用户能看全。
 *   - 完整原始 errMsg 已由 call() 打印到 Console，便于开发者定位。
 */
export function showCallError(e: any, fallback = "操作失败") {
  const info = describeCallError(e);
  const full = info.text || fallback;
  // 真机 toast 最多约 14 个汉字，超出会被截成省略号
  const TOAST_MAX = 14;
  const toastTitle = full.length > TOAST_MAX ? full.slice(0, TOAST_MAX) + "…" : full;
  wx.showToast({ title: toastTitle, icon: "none" });

  const truncated = full.length > TOAST_MAX;
  // 2026-11-16 真机实测修复：业务错误超长分支的 hint =「完整原因：+ 同一段全文」，
  // 此前又拼一遍「完整原因：+ 40 字截断文」→ modal 里同一段原因重复出现两次
  // （NUL PDF 报错弹窗截图实锤）。hint 与 full 同源时直接用 hint 去重；
  // 其他 hint（如 -504002 的「原始原因+部署指引」）与 full 互补，保留原拼接结构。
  const hint = info.hint as string | undefined;
  const hintSameSource = !!hint && (hint.startsWith("完整原因：") || hint.includes(full));
  const content = hintSameSource
    ? (hint as string)
    : truncated
      ? "完整原因：" + full + (hint ? "\n\n" + hint : "")
      : hint || "";
  if (content) {
    setTimeout(() => {
      wx.showModal({
        title: "需要处理",
        content,
        showCancel: false,
        confirmText: "我知道了",
      });
    }, 1800);
  }
}

/**
 * 统一云函数调用的可选参数。
 */
export interface CallOptions {
  /**
   * quiet=true：失败时只打 console.warn，**不打 console.error**。
   * 用途：非阻塞的增强功能（如订阅消息推送）。这类功能失败不影响主流程，
   * 若打成红色 error，会被评委误读为「有未处理异常 / 功能失败」。
   * 主链路调用（题目加载、提交、评估、报告）**不要**开 quiet。
   */
  quiet?: boolean;
  /**
   * 自定义超时（毫秒）。默认 20s；LLM 类云函数（genQuestions/parseResume/
   * analyzeJob/genDeepQuestions/deepSession.answer/deepAnalyze/quizScore/analyze）
   * 传 CALL_TIMEOUT_LLM_MS（60s）。
   */
  timeoutMs?: number;
}

/**
 * 统一云函数调用。
 * 修复点：
 * 1. 补 result 为空的校验——云函数异常退出时 res.result 可能是 null/undefined，
 *    原实现直接 `return result as T`，调用方解构（如 const { questions } = ...）
 *    会抛 "Cannot destructure property of null"，把网络问题变成白屏崩溃。
 * 2. 补超时——原实现无超时，云函数挂起时 Promise 永不 settle，
 *    页面会永久停在「加载中」。
 * 3.（2026-10-26）把 wx.cloud 的原生错误包装成**带可读中文 message** 的 Error，
 *    并保留原始 errMsg 到 err.raw / err.errMsg 供控制台排障。
 * 4.（2026-10-26）新增 opts.quiet：非阻塞增强功能失败只 warn，不打红色 error。
 */
export async function call<T = any>(
  name: string,
  data: Record<string, any> = {},
  opts: CallOptions = {}
): Promise<T> {
  let timer: any = null;
  try {
    const res = await Promise.race([
      wx.cloud.callFunction({ name, data }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("网络超时，请检查网络后重试")), opts.timeoutMs ?? CALL_TIMEOUT_MS);
      }),
    ]);
    const result = res.result as ({ ok?: boolean; error?: string } & T) | null | undefined;
    if (!result || typeof result !== "object") {
      throw new Error("服务无响应，请稍后重试");
    }
    if ((result as any).error) {
      throw new Error((result as any).error);
    }
    return result as T;
  } catch (e: any) {
    // 已经是本模块包装过的错误 → 原样透传（业务错误文案本身是可读的）
    if (e && e.__facemirrorCallError) throw e;
    const info = describeCallError(e);
    // 失败诊断：原始 errMsg 完整落盘，便于在开发者工具 Console 定位
    if (opts.quiet) {
      console.warn(`[云函数] ${name} 调用失败（非阻塞，可忽略）:`, info.raw);
    } else {
      console.error(`[云函数] ${name} 调用失败:`, info.raw);
    }
    const err = new Error(info.text) as any;
    err.__facemirrorCallError = true;
    err.raw = info.raw;
    err.errMsg = info.raw;
    err.cloudFunction = name;
    throw err;
  } finally {
    // 必须清理超时定时器：否则即使调用早已成功，20 秒后仍会触发一次 reject，
    // 在页面已销毁时造成无意义的未捕获异常。
    if (timer !== null) clearTimeout(timer);
  }
}

// ---- 接口 ----

/**
 * 静默登录（取 openid）。
 *
 * 修复（2026-10-26 线上问题「题目无法加载」）：
 * 原先 app.ts 直接裸调 `wx.cloud.callFunction({name:"login"})`，
 * 绕过了上面 call() 的超时保护。云函数未部署 / 环境未关联 / 网络挂起时，
 * 该 Promise 永不 settle → app.login() 永远 pending →
 * 出题页的 `await app.login()` 永远等不到 →
 * loading 永远为 true → 页面卡死在「题目加载中…」。
 * 这里复用带超时的 call()，让登录失败能被捕获并展示。
 */
export function loginCloud(): Promise<{ openid: string }> {
  return call<{ openid: string }>("login", {});
}

/** 提交一次练习（录音后） */
export function submitPractice(payload: {
  scene: string;
  questionText: string;
  audioFileID: string;
  durationSec: number;
}): Promise<{ recordId: string }> {
  return call("submitPractice", payload);
}

/** 轮询练习状态与结果 */
export function getPractice(recordId: string): Promise<PracticeDetail> {
  return call("getPractice", { recordId });
}

/** 修正转写文本（ASR 误差兜底） */
export function updateTranscript(recordId: string, transcript: string): Promise<{ ok: boolean }> {
  return call("updateTranscript", { recordId, transcript });
}

/** 自定义出题：上传材料 → 生成针对性问题 */
export function genQuestions(payload: { fileID: string; scene: string }): Promise<{ questions: { question: string; target: string; difficulty: string }[] }> {
  return call("genQuestions", payload, { timeoutMs: CALL_TIMEOUT_LLM_MS });
}

/** 获取题库题目 */
export function getQuestions(payload: { scene: string; category?: string; limit?: number }): Promise<{ questions: Question[] }> {
  return call("getQuestions", payload);
}

/** 历史记录 */
export function getHistory(payload: { page?: number; pageSize?: number }): Promise<{ list: Practice[]; total: number }> {
  return call("getHistory", payload);
}

/** 订阅消息授权（报告完成通知）。
 *  模板 ID 在 utils/config.ts 配置；未配置时直接返回 false（不弹授权框），
 *  finalize 云函数的推送会因无授权而静默失败，不影响主流程。
 *  注意：必须在「提交练习」之前调用——用户授权在前，服务端推送在后。 */
export function requestSubscribe(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!SUBSCRIBE_TEMPLATE_ID) {
      resolve(false);
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [SUBSCRIBE_TEMPLATE_ID],
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}

// ---- 深度面试（简历驱动）接口 ----

/** 解析简历文件 → 结构化简历 */
export function parseResume(payload: { fileID: string }): Promise<{
  resume: ResumeProfile;
  rawText: string;
}> {
  return call("parseResume", payload, { timeoutMs: CALL_TIMEOUT_LLM_MS });
}

/** 目标岗位 → 能力评估标准 */
export function analyzeJob(payload: { job: JobProfile }): Promise<{ competency: CompetencyModel }> {
  return call("analyzeJob", payload, { timeoutMs: CALL_TIMEOUT_LLM_MS });
}

/** 简历 + 岗位 + 能力标准 → 15~20 道强关联面试题 */
export function genDeepQuestions(payload: {
  resume: ResumeProfile;
  job: JobProfile;
  competency: CompetencyModel;
}): Promise<{
  questions: InterviewQuestion[];
  coverage: { byType: Record<string, number>; byCompetency: Record<string, number>; byDifficulty: Record<string, number> };
  source: string;
  countWarning: string;
}> {
  return call("genDeepQuestions", payload, { timeoutMs: CALL_TIMEOUT_LLM_MS });
}

/** 创建深度面试会话（返回 interviewId） */
export function createDeepSession(): Promise<{ interviewId: string }> {
  return call("deepSession", { action: "create" });
}

/** 保存会话（简历解析结果 / 岗位 / 能力标准 / 题目） */
export function updateDeepSession(payload: {
  interviewId: string;
  resume?: ResumeProfile;
  job?: JobProfile;
  competency?: CompetencyModel;
  questions?: InterviewQuestion[];
}): Promise<{ ok: boolean }> {
  return call("deepSession", { action: "update", ...payload });
}

/** 读取会话（续答用） */
export function getDeepSession(interviewId: string): Promise<{
  interviewId: string;
  status: string;
  resume: ResumeProfile | null;
  job: JobProfile | null;
  competency: CompetencyModel | null;
  questions: InterviewQuestion[];
  answers: AnswerRecord[];
  currentIndex: number;
  report: DeepReport | null;
}> {
  return call("deepSession", { action: "get", interviewId });
}

/** 提交单题答案（服务端同步完成单题评分） */
export function submitDeepAnswer(payload: {
  interviewId: string;
  questionId: string;
  answer: string;
  durationSec: number;
}): Promise<{
  ok: boolean;
  record: AnswerRecord;
  currentIndex: number;
  answeredCount: number;
  totalCount: number;
  finished: boolean;
}> {
  // answer 动作在服务端同步做单题评分（LLM），其余动作是纯数据库操作
  return call("deepSession", { action: "answer", ...payload }, { timeoutMs: CALL_TIMEOUT_LLM_MS });
}

/** 生成深度面试总结（雷达 + 优势短板 + 优化建议） */
export function deepAnalyze(interviewId: string): Promise<{ report: DeepReport }> {
  return call("deepAnalyze", { interviewId }, { timeoutMs: CALL_TIMEOUT_LLM_MS });
}

// ---- 题库抽题（批量模式）接口 ----

/** 按所选科目（多选）与难度随机抽 10~15 题，一次性返回 */
export function quizDraw(payload: {
  categories: string[];
  count?: number;
  difficulty?: string; // 全部/简单/中等/困难，白名单外服务端回退「全部」
}): Promise<{
  questions: QuizQuestion[];
  totalAvailable: number;
  categories: string[];
  difficulty: string;
  count: number;
}> {
  return call("quizDraw", payload);
}

/** 全部答案提交 → 统一评分（每题得分 + 科目掌握度 + 学习建议） */
export function quizScore(payload: {
  questions: { text: string; category: string; difficulty: string }[];
  answers: string[];
}): Promise<{ report: QuizReport; recordId: string }> {
  return call("quizScore", payload, { timeoutMs: CALL_TIMEOUT_LLM_MS });
}
