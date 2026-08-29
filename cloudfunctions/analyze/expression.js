/**
 * 规则化表达分析（FR-08）——云函数侧权威实现。
 * 与 miniprogram/utils/expression.ts 逻辑一致。
 *
 * 语速 / 填充词 / 口头禅 / 长停顿 / 时长分配 全部确定性计算，
 * delivery（表达）维度由此加权映射，与 LLM 的文字点评互补。
 */

const FILLERS = ["然后", "那个", "就是", "嗯", "啊", "对吧", "比如说", "然后呢", "这个"];

function chars(text) {
  return text.replace(/\s+/g, "").split("");
}

function topBigrams(text, topN = 3) {
  const cs = chars(text);
  if (cs.length < 2) return [];
  const freq = new Map();
  for (let i = 0; i < cs.length - 1; i++) {
    const g = cs[i] + cs[i + 1];
    if (/^[\p{P}\p{S}]$/u.test(cs[i]) || /^[\p{P}\p{S}]$/u.test(cs[i + 1])) continue;
    freq.set(g, (freq.get(g) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([g]) => g);
}

function fillerDensity(text) {
  const total = text.replace(/\s+/g, "").length;
  if (!total) return 0;
  let hits = 0;
  for (const f of FILLERS) hits += text.split(f).length - 1;
  return Math.round((hits / total) * 1000) / 10;
}

function speed(text, durationSec) {
  if (!durationSec) return 0;
  const n = text.replace(/\s+/g, "").length;
  return Math.round((n / durationSec) * 60);
}

function longPauses(sentences) {
  let count = 0;
  for (let i = 1; i < (sentences || []).length; i++) {
    if (sentences[i].start - sentences[i - 1].end > 2) count++;
  }
  return count;
}

function timeSplit(sentences) {
  if (!sentences || !sentences.length) return { opening: 0, body: 0, closing: 0 };
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
  const pct = (v) => Math.round((v / sum) * 100);
  return { opening: pct(opening), body: pct(body), closing: pct(closing) };
}

function deliveryScore(spd, filler, pauses, split) {
  let score = 5;
  if (spd > 0 && (spd < 150 || spd > 300)) score -= 1;
  if (filler > 8) score -= 1;
  else if (filler > 4) score -= 0.5;
  if (pauses > 5) score -= 1;
  else if (pauses > 2) score -= 0.5;
  if (split.body < 60) score -= 1;
  return Math.max(1, Math.min(5, Math.round(score * 2) / 2));
}

/** 节奏分（1-5）：语速 180-240 最佳 */
function paceScore(speedWpm) {
  if (!speedWpm) return 3;
  if (speedWpm >= 180 && speedWpm <= 240) return 5;
  if (speedWpm >= 150 && speedWpm <= 300) return 4;
  if (speedWpm >= 120 && speedWpm <= 350) return 3;
  return 2;
}

function analyzeExpression(transcript, durationSec, sentences = []) {
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

module.exports = { analyzeExpression, paceScore };
