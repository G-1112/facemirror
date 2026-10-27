# 题库（1382 题）

`questions.json` 共 1382 道内置题目，每题结构为：

```json
{ "scene": "interview", "category": "通用", "text": "...", "difficulty": "简单" }
```

## 构成

**原有通用题库 80 题**（保持不变，位于文件最前）：

- 通用面试 30 题（scene=interview, category=通用）
- 技术岗 30 题（scene=interview, category=技术）
- 答辩 20 题（scene=defense, category=答辩）

**13 个学科门类 1302 题**（scene=interview，每科 ≥100 题）：

| category | 文件 | 题数 |
|---|---|---|
| 哲学 | subjects/philosophy.json | 100 |
| 经济学 | subjects/economics.json | 100 |
| 法学 | subjects/law.txt | 100 |
| 教育学 | subjects/education.txt | 100 |
| 文学 | subjects/literature.txt | 100 |
| 历史学 | subjects/history.txt | 100 |
| 理学 | subjects/science.txt | 101 |
| 工学 | subjects/engineering.txt | 101 |
| 农学 | subjects/agriculture.txt | 100 |
| 医学 | subjects/medicine.txt | 100 |
| 军事学 | subjects/military.txt | 100 |
| 管理学 | subjects/management.txt | 100 |
| 艺术学 | subjects/art.txt | 100 |

难度分布（全库）：简单 434 / 中等 657 / 困难 291。
学科题按「简单约 30% / 中等 45-50% / 困难 20-30%」设计。

> 课堂展示（presentation）场景仍复用「通用」题库（见 `getQuestions` 云函数内的映射）。
> 学科题通过 `category` 过滤：前端传 `category: "哲学"` 即可只抽该学科题目。

## 维护与合并

- `subjects/*.txt` 为源文件，每行格式 `难度|题目`（`#` 开头为注释）；`subjects/*.json` 为对象数组。
- 修改学科文件后运行合并脚本重建两个成品文件：

```bash
python scripts/merge_question_bank.py            # 校验 + 合并 + 复读校验
python scripts/merge_question_bank.py --dry-run  # 只校验不写出
```

脚本会校验：每科 ≥100 题、字段与难度白名单、全库题干去重（含与原 80 题查重）、
原 80 题逐字节不变（复读断言）。任何校验失败都不会写文件。

## 导入云数据库

1. 打开微信开发者工具 → 云开发控制台 → 数据库；
2. 集合 `questions` 已存在（权限「所有用户可读，仅创建者可写」）；
3. ⚠️ **若集合内已有旧数据（80 条），必须先全选删除所有记录**，
   否则新导入不携带 `_id`，会与旧记录叠加造成重复；
4. 点击「导入」→ 选择 **`questions.import.json`**（JSON Lines，每行一条，共 1382 行）；
   > ⚠️ 不要导入 `questions.json`——它是标准 JSON 数组（单文档），云开发导入只接受
   > 每行一条的 JSON Lines，数组格式会报解析失败或导入 0 条。
5. 导入后 `questions` 集合应有 1382 条记录，验证：`db.collection('questions').count()` → 1382。

导入后即可在小程序内随机抽题（含按学科抽题）。
