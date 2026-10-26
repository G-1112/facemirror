#!/usr/bin/env node
/**
 * 统计 `npm test` 各测试文件的真实断言数（PASS 场景 + 单条断言两种输出格式都计入）。
 *
 * 用法：
 *   node scripts/count_assertions.js
 *
 * 为什么需要它：
 *   早期文档只统计 `[PASS]` 标记，漏掉了云函数测试里用 `✓` 输出的 47 条断言
 *   （security 40 + openid_guard 7），把 297 写成了 250。本脚本统一口径，
 *   并直接读取 package.json 的 test 脚本取文件列表，避免人工维护清单漂移。
 */
const { execFileSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));

// 从 package.json 的 test 脚本里解析出所有 `node <file>` 节点
const files = [];
for (const m of pkg.scripts.test.matchAll(/node\s+([^\s&|]+)/g)) files.push(m[1]);

const RE_MARK = /\[PASS\]|✓/; // 两种断言输出格式都算

let total = 0;
const rows = [];
for (const f of files) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(root, f)], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  const lines = out.split(/\r?\n/);
  // 一行只计一次（避免同一行同时含两个标记被重复计数）
  const assertions = lines.filter((l) => RE_MARK.test(l)).length;
  const failed = lines.filter((l) => /\[FAIL\]|✗/.test(l)).length;
  const scenes = (out.match(/全部通过：\s*(\d+)\s*个场景/) || [])[1] || "-";
  total += assertions;
  rows.push({ file: f, assertions, scenes, failed });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("");
console.log(pad("测试文件", 46) + pad("断言", 8) + pad("场景", 8) + "失败");
console.log("-".repeat(74));
for (const r of rows) {
  console.log(pad(r.file, 46) + pad(r.assertions, 8) + pad(r.scenes, 8) + r.failed);
}
console.log("-".repeat(74));
console.log(`合计：${rows.length} 个测试文件，${total} 条断言，失败 ${rows.reduce((a, r) => a + r.failed, 0)} 条`);
console.log(`场景合计：${rows.filter((r) => r.scenes !== "-").reduce((a, r) => a + Number(r.scenes), 0)} 个`);
process.exit(rows.some((r) => r.failed > 0) ? 1 : 0);
