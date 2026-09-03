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
2. 新建集合 `questions`；
3. 点击「导入」，选择本 `questions.json` 文件（选择 JSON 格式、逐条导入）。

导入后即可在小程序内随机抽题。
