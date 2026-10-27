// 题库抽题（批量模式）：按所选科目（多选）等概率抽取 10~15 题，一次返回
//
// 抽样策略：对每个选中科目先 count，再按科目题量占比分配抽取数（余数按
// 「大科优先」补齐），每个科目内部用「随机起点 + 连续取 k 条」近似无放回抽样
// （与 getQuestions 同一套分布修正思路），最后整体打乱输出。
// 只用 where/count/skip/limit/get 原语，不引入 aggregate，便于本地桩测试。
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 科目白名单：与 miniprogram/utils/quiz.ts、data/questions/subjects/ 的
// 13 个学科门类一致。白名单外的一律丢弃，防止借接口探测任意 category。
const SUBJECTS = [
  "哲学", "经济学", "法学", "教育学", "文学", "历史学", "理学",
  "工学", "农学", "医学", "军事学", "管理学", "艺术学",
];

const MIN_COUNT = 10;
const MAX_COUNT = 15;
const DEFAULT_COUNT = 12;
const MAX_QUESTION_LEN = 2000;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { error: "未获取用户身份，请重新进入小程序" };

  // ── 参数归一 ──
  const rawCats = Array.isArray(event.categories) ? event.categories : [];
  const categories = [...new Set(rawCats.filter((c) => SUBJECTS.includes(c)))];
  if (!categories.length) {
    return { error: "请至少选择一个有效科目" };
  }
  let count = Math.round(Number(event.count) || DEFAULT_COUNT);
  count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, count));

  // ── 各科目题量统计 ──
  const perCat = [];
  let totalAvailable = 0;
  for (const cat of categories) {
    const where = { scene: "interview", category: cat };
    const res = await db.collection("questions").where(where).count();
    const n = res.total || 0;
    perCat.push({ cat, n });
    totalAvailable += n;
  }
  if (totalAvailable === 0) {
    return {
      error:
        "所选科目在内置题库中没有题目。请先在云开发控制台删除 questions 集合旧数据并重新导入 questions.import.json（1382 条）",
    };
  }
  if (totalAvailable < MIN_COUNT) {
    return {
      error: `所选科目题量共 ${totalAvailable} 题，不足 ${MIN_COUNT} 题，请多选几个科目或先补全题库`,
    };
  }

  // ── 按题量占比分配抽取数 ──
  // k_c = floor(count * n_c / total)，余数按占比大者优先补齐；
  // 每个有题科目至少 1 题（保证多选的每个科目都出现在卷子里）。
  const quotas = perCat.map(({ cat, n }) => ({
    cat,
    n,
    k: n > 0 ? Math.max(1, Math.floor((count * n) / totalAvailable)) : 0,
  }));
  let assigned = quotas.reduce((a, b) => a + b.k, 0);
  // 超分回收：从占比小的科目回收（多因「每科至少 1 题」兜底超发）
  while (assigned > count) {
    const donor = [...quotas].filter((q) => q.k > 1).sort((a, b) => a.k - b.k)[0];
    if (!donor) break;
    donor.k -= 1;
    assigned -= 1;
  }
  // 不足补齐：按 n 大者优先
  const bySize = [...quotas].filter((q) => q.n > 0).sort((a, b) => b.n - a.n);
  let i = 0;
  while (assigned < count && bySize.length) {
    const taker = bySize[i % bySize.length];
    if (taker.k < taker.n) {
      taker.k += 1;
      assigned += 1;
    }
    i += 1;
    if (i > count * 2) break; // 防御：题量耗尽时退出
  }

  // ── 科目内随机抽样 ──
  const questions = [];
  for (const { cat, n, k } of quotas) {
    if (k <= 0 || n <= 0) continue;
    const take = Math.min(k, n);
    // 随机起点落在 [0, n - take]：与 getQuestions 相同的等概率修正
    const maxStart = Math.max(0, n - take);
    const skip = Math.floor(Math.random() * (maxStart + 1));
    const res = await db
      .collection("questions")
      .where({ scene: "interview", category: cat })
      .skip(skip)
      .limit(take)
      .get();
    for (const q of res.data || []) {
      questions.push({
        text: typeof q.text === "string" ? q.text.slice(0, MAX_QUESTION_LEN) : "",
        category: cat,
        difficulty: q.difficulty || "中等",
      });
    }
  }

  // 整体打乱（Fisher-Yates），避免科目聚块
  for (let j = questions.length - 1; j > 0; j--) {
    const r = Math.floor(Math.random() * (j + 1));
    [questions[j], questions[r]] = [questions[r], questions[j]];
  }

  return {
    questions: questions.filter((q) => q.text),
    totalAvailable,
    categories,
    count,
  };
};
