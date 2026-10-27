/**
 * 深度面试（简历驱动）共享类型与常量。
 *
 * 与「单题练习」链路（question → record → result）**并列**的第二条链路：
 *   resume（上传+解析确认+岗位） → deep（逐题作答） → deep-report（总结雷达）
 *
 * 设计要点：
 * 1. 跨页状态**不依赖页面栈**，全部落在云端 `interviews` 集合 → 中途退出可续答。
 * 2. 题目数量恒定在 [MIN_QUESTIONS, MAX_QUESTIONS] → 前端与云函数共用同一份常量口径。
 * 3. 雷达维度与单题练习的「表达五维」**不同**：深度面试评的是岗位能力（6 维），
 *    其中「表达沟通」由规则化表达分析（utils/expression.ts）辅助计算。
 */

/** 题目数量区间：需求要求 15～20 道，少于下限必须补齐 */
export const MIN_QUESTIONS = 15;
export const MAX_QUESTIONS = 20;

/** 深度面试雷达图的 6 个能力维度（顺序即雷达图轴顺序，勿随意调整） */
export const DEEP_DIMENSIONS = [
  { key: "technicalDepth", name: "技术深度" },
  { key: "projectAuthenticity", name: "项目真实性" },
  { key: "businessInsight", name: "业务理解" },
  { key: "problemSolving", name: "问题解决" },
  { key: "jobFit", name: "岗位匹配" },
  { key: "communication", name: "表达沟通" },
] as const;

export type DeepDimensionKey = (typeof DEEP_DIMENSIONS)[number]["key"];

/** 面试题类型：覆盖项目细节 / 技术理解 / 业务理解 / 场景问题 / 行为面试 */
export const QUESTION_TYPES = [
  { key: "project", name: "项目细节" },
  { key: "technical", name: "技术理解" },
  { key: "business", name: "业务理解" },
  { key: "scenario", name: "场景问题" },
  { key: "behavior", name: "行为面试" },
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number]["key"];

export const DIFFICULTIES = ["简单", "中等", "困难"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** 单题建议作答时长（秒），用于前端倒计时与「用时」统计 */
export const DEFAULT_ANSWER_SEC = 120;

// ---------------------------------------------------------------- 简历结构

export interface EducationItem {
  school: string;
  major: string;
  degree: string;
  period: string;
  highlights: string[];
}

export interface ExperienceItem {
  org: string;
  role: string;
  period: string;
  duties: string[];
  achievements: string[];
}

export interface ProjectItem {
  name: string;
  role: string;
  period: string;
  tech: string[];
  desc: string;
  metrics: string[];
  highlights: string[];
}

export interface AwardItem {
  name: string;
  level: string;
  period: string;
  issuer: string;
}

export interface SkillGroup {
  languages: string[];
  frameworks: string[];
  tools: string[];
  concepts: string[];
  other: string[];
}

/** 结构化简历（LLM 解析结果，mock 兜底时由规则解析产出同构数据） */
export interface ResumeProfile {
  summary: string;
  education: EducationItem[];
  experiences: ExperienceItem[];
  projects: ProjectItem[];
  awards: AwardItem[];
  skills: SkillGroup;
  /** 解析模式：ai=LLM 解析；rule=规则兜底解析（需用户重点核对） */
  parseMode: "ai" | "rule";
  /** 解析告警（如"教育经历未识别到"），透传给用户 */
  parseWarnings: string[];
}

// ---------------------------------------------------------------- 岗位与能力标准

export interface JobProfile {
  role: string;
  level: string;
  industry: string;
  extra: string;
}

export interface Competency {
  /** 对应 DEEP_DIMENSIONS 的 key */
  key: DeepDimensionKey;
  name: string;
  weight: number;
  focusPoints: string[];
  expectedLevel: string;
}

export interface CompetencyModel {
  role: string;
  level: string;
  industry: string;
  competencies: Competency[];
  /** 面试官风格提示（用于出题 prompt） */
  interviewerStyle: string;
}

// ---------------------------------------------------------------- 题目与作答

export interface InterviewQuestion {
  id: string;
  question: string;
  type: QuestionType;
  difficulty: Difficulty;
  /** 对应的考察维度 key */
  competency: DeepDimensionKey;
  /** ★与简历强关联的锚点（哪个项目/哪段经历/哪个数字） */
  evidence: string;
  /** 追问（可展开，不强制） */
  followups: string[];
  /** 参考答案要点提示 */
  keyPoints: string[];
  estimatedSec: number;
}

export interface AnswerRecord {
  questionId: string;
  answer: string;
  durationSec: number;
  /** 命中的要点 */
  hit: string[];
  /** 遗漏的要点 */
  missed: string[];
  /** 单题得分 1-5 */
  score: number;
  feedback: string;
  answeredAt: number;
}

// ---------------------------------------------------------------- 总结报告

export interface DeepReport {
  totalScore: number;
  /** 雷达轴值，顺序与 DEEP_DIMENSIONS 一致，长度恒为 6 */
  radar: number[];
  /** 分项能力得分：key → 1-5 */
  dimensions: Record<string, number>;
  strengths: { dimension: string; text: string; evidence: string }[];
  weaknesses: { dimension: string; text: string; evidence: string }[];
  /** 知识/技能补强 */
  knowledgeGaps: { topic: string; reason: string; resource: string }[];
  /** 简历优化点 */
  resumeTips: string[];
  /** 面试表达改进方向 */
  expressionTips: string[];
  /** 推荐练习方向 */
  practiceSuggestions: string[];
  /** 逐题点评 */
  perQuestion: {
    questionId: string;
    question: string;
    score: number;
    feedback: string;
    hit: string[];
    missed: string[];
  }[];
  overall: string;
  /** 回答统计 */
  stats: {
    answered: number;
    total: number;
    avgDurationSec: number;
    totalDurationSec: number;
  };
}

// ---------------------------------------------------------------- 会话记录

export type InterviewStatus =
  | "draft" // 简历已解析，待填岗位
  | "questions_ready" // 题目已生成
  | "in_progress" // 答题中
  | "analyzing" // 正在生成总结
  | "done"; // 总结完成

export interface InterviewRecord {
  _id: string;
  openid: string;
  status: InterviewStatus;
  resume: ResumeProfile | null;
  job: JobProfile | null;
  competency: CompetencyModel | null;
  questions: InterviewQuestion[];
  answers: AnswerRecord[];
  currentIndex: number;
  report: DeepReport | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- 工具函数

/** 把任意值夹到 [min, max] 并取整 */
export function clampScore(v: unknown, min = 1, max = 5): number {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** 秒 → "m:ss" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" + r : r}`;
}

/**
 * 校验题目数组是否满足 [MIN, MAX] 区间。
 * 供云函数与前端共用同一口径（前端用于二次兜底判断）。
 */
export function isValidQuestionCount(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_QUESTIONS && n <= MAX_QUESTIONS;
}

/** 题目类型 → 中文名（模板里不能调用函数，故前端需预先算好） */
export function questionTypeName(key: string): string {
  const hit = QUESTION_TYPES.find((t) => t.key === key);
  return hit ? hit.name : "综合";
}

/** 维度 key → 中文名 */
export function dimensionName(key: string): string {
  const hit = DEEP_DIMENSIONS.find((d) => d.key === key);
  return hit ? hit.name : "综合";
}
