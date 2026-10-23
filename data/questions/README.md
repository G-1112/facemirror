# 题库（80 题）

`questions.json` 包含 80 道内置题目，结构为：

```json
{ "scene": "interview", "category": "通用", "text": "...", "difficulty": "简单" }
```

- 通用面试 30 题（scene=interview, category=通用）
- 技术岗 30 题（scene=interview, category=技术）
- 答辩 20 题（scene=defense, category=答辩）

> 课堂展示（presentation）场景复用「通用」题库（见 `getQuestions` 云函数内的映射）。

## 导入云数据库

1. 打开微信开发者工具 → 云开发控制台 → 数据库；
2. 新建集合 `questions`（权限选「所有用户可读，仅创建者可写」）；
3. 点击「导入」→ 选择 **`questions.import.json`**（JSON Lines，每行一条，共 80 行）；
   > ⚠️ 不要导入 `questions.json`——它是标准 JSON 数组（单文档），云开发导入只接受
   > 每行一条的 JSON Lines，数组格式会报解析失败或导入 0 条。
4. 导入后 `questions` 集合应有 80 条记录，验证：`db.collection('questions').count()` → 80。

导入后即可在小程序内随机抽题。
