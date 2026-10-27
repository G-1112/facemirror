// 题库抽题（批量模式）：科目常量 + 类型 + 工具
// 与 cloudfunctions/quizDraw 的 SUBJECTS 白名单保持同一份口径（云函数不能跨目录
// require，故服务端内联同名清单；修改时两处必须同步，merge_question_bank.py 的
// CATEGORY_BY_FILE 是第三处，均为 13 个学科门类）。

export interface QuizSubject {
  key: string; // 与题库 category 一致
  name: string;
  icon: string;
}

export const QUIZ_SUBJECTS: QuizSubject[] = [
  { key: "哲学", name: "哲学", icon: "🧭" },
  { key: "经济学", name: "经济学", icon: "📈" },
  { key: "法学", name: "法学", icon: "⚖️" },
  { key: "教育学", name: "教育学", icon: "🎓" },
  { key: "文学", name: "文学", icon: "📖" },
  { key: "历史学", name: "历史学", icon: "🏛️" },
  { key: "理学", name: "理学", icon: "🔬" },
  { key: "工学", name: "工学", icon: "⚙️" },
  { key: "农学", name: "农学", icon: "🌾" },
  { key: "医学", name: "医学", icon: "🩺" },
  { key: "军事学", name: "军事学", icon: "🛡️" },
  { key: "管理学", name: "管理学", icon: "📊" },
  { key: "艺术学", name: "艺术学", icon: "🎨" },
];

/** 抽题数量档位（10~15 题，需求口径） */
export const QUIZ_COUNT_OPTIONS = [10, 12, 15];
export const QUIZ_DEFAULT_COUNT = 12;
export const QUIZ_MIN_COUNT = 10;
export const QUIZ_MAX_COUNT = 15;

/** 单题答案长度上限（与 submitPractice 的 questionText 上限同口径） */
export const MAX_QUIZ_ANSWER_LEN = 2000;

/** 服务端返回的一道抽题 */
export interface QuizQuestion {
  text: string;
  category: string;
  difficulty: string;
}

/** 每题点评 */
export interface QuizPerQuestion {
  index: number;
  category: string;
  question: string;
  score: number; // 1~5
  comment: string;
  answered: boolean;
}

/** 科目维度掌握度 */
export interface QuizSubjectMastery {
  category: string;
  count: number;
  avgScore: number; // 1~5（保留 1 位小数）
  percent: number; // 0~100
  summary: string;
}

/** 统一评分报告（quizScore 云函数返回） */
export interface QuizReport {
  kind: "quiz";
  totalScore: number; // 0~100
  perQuestion: QuizPerQuestion[];
  subjectMap: QuizSubjectMastery[];
  radar: number[]; // 与 subjectMap 顺序一致，1~5
  labels: string[]; // 科目名
  suggestions: string[];
  overall: string;
  stats: { answered: number; total: number };
  model: "llm" | "rule"; // 评分来源（llm=大模型 / rule=规则降级）
  injectionFlagged?: boolean;
  persisted: boolean; // 是否已写入历史记录
}

/** 答案裁剪：超长截断 + 去首尾空白 */
export function clampAnswer(text: string): string {
  const s = typeof text === "string" ? text.trim() : "";
  return s.length > MAX_QUIZ_ANSWER_LEN ? s.slice(0, MAX_QUIZ_ANSWER_LEN) : s;
}

/** 校验科目选择是否合法（全部在白名单内且至少一个） */
export function isValidSubjectSelection(cats: string[]): boolean {
  if (!Array.isArray(cats) || cats.length === 0) return false;
  const valid = new Set(QUIZ_SUBJECTS.map((s) => s.key));
  return cats.every((c) => valid.has(c));
}
