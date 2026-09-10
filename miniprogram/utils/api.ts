/**
 * 云函数调用封装。所有与后端的交互统一走这里。
 * 云函数名与 cloudfunctions/ 目录一一对应。
 */

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

async function call<T = any>(name: string, data: Record<string, any> = {}): Promise<T> {
  const res = await wx.cloud.callFunction({ name, data });
  const result = res.result as { ok?: boolean; error?: string } & T;
  if (result && (result as any).error) {
    throw new Error((result as any).error);
  }
  return result as T;
}

// ---- 接口 ----

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
  return call("genQuestions", payload);
}

/** 获取题库题目 */
export function getQuestions(payload: { scene: string; category?: string; limit?: number }): Promise<{ questions: Question[] }> {
  return call("getQuestions", payload);
}

/** 历史记录 */
export function getHistory(payload: { page?: number; pageSize?: number }): Promise<{ list: Practice[]; total: number }> {
  return call("getHistory", payload);
}

/** 订阅消息授权（报告完成通知） */
export function requestSubscribe(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: ["REPLACE_WITH_TEMPLATE_ID"], // 替换为你在公众平台申请的模板 ID
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}

/** 内容安全检测（用户上传材料文本，审核硬性要求） */
export async function checkContentSafe(text: string): Promise<boolean> {
  try {
    const res = await wx.cloud.callFunction({ name: "checkContent", data: { text } });
    const r = res.result as { safe: boolean };
    return !!r.safe;
  } catch {
    return true; // 检测失败时放行，避免阻塞主流程
  }
}
