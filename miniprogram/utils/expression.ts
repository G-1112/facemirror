/**
 * 规则化表达分析（FR-08，技术亮点）。
 *
 * 「能确定性计算的，绝不交给模型」——语速、填充词、口头禅、停顿、时长分配
 * 全部由确定性规则计算，与 LLM 的文字点评互补，共同构成 delivery/表达 维度。
 *
 * 注：本文件为纯函数模块，供结果页做轻量展示；权威结果由 analyze 云函数
 * 以相同公式计算（见 cloudfunctions/analyze/expression.js，两处逻辑保持一致）。
 */

export interface SentenceTiming {
  text: string;
  start: number; // 秒
  end: number; // 秒
}

export interface ExpressionResult {
  /** 语速：字/分钟 */
  speedWpm: number;
  /** 填充词密度：% */
  fillerRate: number;
  /** 高频口头禅 Top3（2-gram） */
  fillerTop3: string[];
  /** 长停顿次数（相邻句间隔 > 2s） */
  longPauseCount: number;
  /** 时长分配：开场/主体/结尾 占比（%） */
  timeSplit: { opening: number; body: number; closing: number };
  /** 表达维度评分（由以上指标加权映射，1-5 分） */
  deliveryScore: number;
}

// 填充词表（可扩展）
const FILLERS = ["然后", "那个", "就是", "嗯", "啊", "对吧", "比如说", "然后呢", "这个"];

/** 语速：180-240 正常，<150 偏慢，>300 偏快 */
const SPEED_NORMAL: [number, number] = [180, 240];

/** 中文分词（无 jieba 依赖的简易逐字切分，用于 2-gram 统计） */
function toChars(text: string): string[] {
  return text.replace(/\s+/g, "").split("");
}

/** 统计 2-gram 频次 */
function topBigrams(text: string, topN = 3): string[] {
  const chars = toChars(text);
  if (chars.length < 2) return [];
  const freq = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1];
    // 过滤纯标点组合
    if (/^[\p{P}\p{S}]$/u.test(chars[i]) || /^[\p{P}\p{S}]$/u.test(chars[i + 1])) continue;
    freq.set(g, (freq.get(g) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([g]) => g);
}

/** 填充词密度（%）：命中填充词次数 / 总字数 */
function fillerDensity(text: string): number {
  const total = text.replace(/\s+/g, "").length;
  if (!total) return 0;
  let hits = 0;
  for (const f of FILLERS) {
    const count = text.split(f).length - 1;
    hits += count;
  }
  return Math.round((hits / total) * 1000) / 10;
}

/** 语速（字/分钟） */
function speed(text: string, durationSec: number): number {
  if (!durationSec) return 0;
  const chars = text.replace(/\s+/g, "").length;
  return Math.round((chars / durationSec) * 60);
}

/** 长停顿次数：相邻句时间戳间隔 > 2s */
function longPauses(sentences: SentenceTiming[]): number {
  let count = 0;
  for (let i = 1; i < sentences.length; i++) {
    const gap = sentences[i].start - sentences[i - 1].end;
    if (gap > 2) count++;
  }
  return count;
}

/** 时长分配：按句子在总时长中的位置归入 开场/主体/结尾 三段 */
function timeSplit(sentences: SentenceTiming[]): { opening: number; body: number; closing: number } {
  if (!sentences.length) return { opening: 0, body: 0, closing: 0 };
  const start = sentences[0].start;
  const end = sentences[sentences.length - 1].end;
  const total = Math.max(end - start, 1);
  let opening = 0,
    body = 0,
    closing = 0;
  for (const s of sentences) {
    const mid = (s.start + s.end) / 2 - start;
    const ratio = mid / total;
    const dur = s.end - s.start;
    if (ratio < 0.2) opening += dur;
    else if (ratio < 0.8) body += dur;
    else closing += dur;
  }
  const sum = opening + body + closing || 1;
  const pct = (v: number) => Math.round((v / sum) * 100);
  return { opening: pct(opening), body: pct(body), closing: pct(closing) };
}

/** 表达维度评分（1-5）：由语速 + 填充词密度 + 长停顿 + 时长分配 加权映射 */
function deliveryScore(
  spd: number,
  filler: number,
  pauses: number,
  split: { opening: number; body: number; closing: number },
): number {
  let score = 5;
  // 语速偏离正常区间
  if (spd > 0 && (spd < SPEED_NORMAL[0] || spd > SPEED_NORMAL[1])) score -= 1;
  // 填充词密度过高
  if (filler > 8) score -= 1;
  else if (filler > 4) score -= 0.5;
  // 长停顿过多
  if (pauses > 5) score -= 1;
  else if (pauses > 2) score -= 0.5;
  // 主体占比不足 60%
  if (split.body < 60) score -= 1;
  return Math.max(1, Math.min(5, Math.round(score * 2) / 2));
}

/** 主入口：综合表达分析 */
export function analyzeExpression(
  transcript: string,
  durationSec: number,
  sentences: SentenceTiming[] = [],
): ExpressionResult {
  const speedWpm = speed(transcript, durationSec);
  const fillerRate = fillerDensity(transcript);
  const fillerTop3 = topBigrams(transcript);
  const longPauseCount = longPauses(sentences);
  const split = timeSplit(sentences);
  const deliveryScoreVal = deliveryScore(speedWpm, fillerRate, longPauseCount, split);

  return {
    speedWpm,
    fillerRate,
    fillerTop3,
    longPauseCount,
    timeSplit: split,
    deliveryScore: deliveryScoreVal,
  };
}
