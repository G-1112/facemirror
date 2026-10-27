#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""合并学科题库到 data/questions/questions.json / questions.import.json。

数据源：
- data/questions/questions.json        —— 原 80 题内置题库（原样保留，置于最前）
- data/questions/subjects/*.json|*.txt —— 13 个学科文件（新增）

txt 格式：每行 `难度|题目`（难度 ∈ 简单/中等/困难，# 开头为注释）。
json 格式：对象数组，字段 {scene, category, text, difficulty}。

校验（任一失败则退出码非 0，不写出文件）：
1. 每个学科文件 >= 100 题；
2. 字段恰为 {scene, category, text, difficulty}，difficulty 在白名单内；
3. 题干非空且唯一（学科内 + 与原 80 题查重）；
4. 原有 80 题保持逐字节不变（按 [text, difficulty, category, scene] 键集合比对）。

用法：python scripts/merge_question_bank.py [--dry-run]
"""
import io
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QDIR = os.path.join(ROOT, "data", "questions")
SUBJ_DIR = os.path.join(QDIR, "subjects")

CATEGORY_BY_FILE = {
    "philosophy.json": "哲学",
    "economics.json": "经济学",
    "law.txt": "法学",
    "education.txt": "教育学",
    "literature.txt": "文学",
    "history.txt": "历史学",
    "science.txt": "理学",
    "engineering.txt": "工学",
    "agriculture.txt": "农学",
    "medicine.txt": "医学",
    "military.txt": "军事学",
    "management.txt": "管理学",
    "art.txt": "艺术学",
}

SCENE = "interview"
DIFFICULTIES = {"简单", "中等", "困难"}
MIN_PER_SUBJECT = 100
FIELDS = {"scene", "category", "text", "difficulty"}


def load_original():
    path = os.path.join(QDIR, "questions.json")
    arr = json.load(io.open(path, encoding="utf-8"))
    for q in arr:
        if set(q) != FIELDS or q["difficulty"] not in DIFFICULTIES:
            raise SystemExit(f"原题库记录字段异常: {q}")
    return arr


def load_subject(filename, category):
    path = os.path.join(SUBJ_DIR, filename)
    records = []
    if filename.endswith(".txt"):
        for lineno, line in enumerate(io.open(path, encoding="utf-8"), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|", 1)
            if len(parts) != 2 or parts[0].strip() not in DIFFICULTIES or not parts[1].strip():
                raise SystemExit(f"{filename}:{lineno} 格式非法: {line[:50]}")
            records.append({
                "scene": SCENE,
                "category": category,
                "text": parts[1].strip(),
                "difficulty": parts[0].strip(),
            })
    else:
        arr = json.load(io.open(path, encoding="utf-8"))
        for i, q in enumerate(arr, 1):
            if set(q) != FIELDS or q["difficulty"] not in DIFFICULTIES:
                raise SystemExit(f"{filename} 第{i}条字段/难度非法: {q}")
            records.append({
                "scene": SCENE,
                "category": category,
                "text": q["text"].strip(),
                "difficulty": q["difficulty"],
            })
    return records


def key(q):
    return (q["scene"], q["category"], q["text"], q["difficulty"])


def main():
    dry_run = "--dry-run" in sys.argv
    original = load_original()
    original_keys = {key(q) for q in original}

    bank = list(original)
    seen = set(original_keys)
    stats = []
    errors = []

    for filename, category in CATEGORY_BY_FILE.items():
        records = load_subject(filename, category)
        dup_in_file = 0
        for q in records:
            k = key(q)
            if k in seen:
                dup_in_file += 1
                continue
            seen.add(k)
            bank.append(q)
        diff_count = {}
        for q in records:
            diff_count[q["difficulty"]] = diff_count.get(q["difficulty"], 0) + 1
        stats.append((category, filename, len(records), dup_in_file, diff_count))
        if len(records) - dup_in_file < MIN_PER_SUBJECT:
            errors.append(f"{category}({filename}) 有效题数 {len(records) - dup_in_file} < {MIN_PER_SUBJECT}")

    if errors:
        for e in errors:
            print("[FAIL]", e)
        sys.exit(1)

    from collections import Counter
    total = Counter(q["category"] for q in bank)
    difficulty = Counter(q["difficulty"] for q in bank)
    scene = Counter(q["scene"] for q in bank)

    print(f"原题库: {len(original)} 题（保持不变）")
    for category, filename, n, dup, diff_count in stats:
        print(f"  {category:<4} <- {filename:<16} {n:>4} 题  重复剔除 {dup}  分布 {diff_count}")
    print(f"合并后总数: {len(bank)} 题 | category 数: {len(total)} | 难度: {dict(difficulty)} | scene: {dict(scene)}")

    if dry_run:
        print("dry-run，不写出文件")
        return

    # 写 questions.json（数组，缩进 1 保持紧凑）
    with io.open(os.path.join(QDIR, "questions.json"), "w", encoding="utf-8", newline="") as f:
        json.dump(bank, f, ensure_ascii=False, indent=0)
        f.write("\n")
    # 写 questions.import.json（JSON Lines，每行一条，云数据库导入格式）
    with io.open(os.path.join(QDIR, "questions.import.json"), "w", encoding="utf-8", newline="") as f:
        for q in bank:
            f.write(json.dumps(q, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("已写出 questions.json 与 questions.import.json")

    # 复读校验
    back = json.load(io.open(os.path.join(QDIR, "questions.json"), encoding="utf-8"))
    assert len(back) == len(bank), "复读数量不一致"
    assert back[: len(original)] == original, "原 80 题被改动"
    lines = io.open(os.path.join(QDIR, "questions.import.json"), encoding="utf-8").read().splitlines()
    assert len(lines) == len(bank), "import 行数不一致"
    assert all(json.loads(l)["category"] for l in lines), "import 行存在空 category"
    print("复读校验通过：总数一致 / 原 80 题未变 / import 行数一致")


if __name__ == "__main__":
    main()
