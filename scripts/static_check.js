#!/usr/bin/env node
/**
 * 小程序静态自检三件套（事件绑定 / 模板变量 / 标签配对 + 防重入铁律）。
 *
 * 用法：
 *   node scripts/static_check.js                    # 检查全部页面
 *   node scripts/static_check.js resume deep        # 只检查指定页面
 *
 * 为什么需要它：
 *   WXML 里绑了一个 TS 里不存在的方法 → 运行时点击无反应且**编译不报错**；
 *   模板引用了 data 里没声明的变量 → 渲染 undefined / 空白；
 *   标签没配对 → 小程序渲染层直接报错。
 *   这三类问题 IDE 静态检查抓不全，必须自己扫。
 *
 * ★额外铁律检查：按钮不得用 `disabled` 属性做防重入
 *   （disabled 会同时禁用控件并阻断 bindtap，锁一旦卡住按钮就永久点不动——
 *    见 utils/nav-guard.ts 的注释与 2026-10-26 的线上事故）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "miniprogram", "pages");

/** 列出全部页面目录名 */
function listPages() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  return fs
    .readdirSync(PAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** 提取 Page({ data: {...} }) 的 data 字段名（按缩进层级，避免误切嵌套对象） */
function extractDataKeys(ts) {
  const lines = ts.split(/\r?\n/);
  const keys = new Set();
  let inData = false;
  let dataIndent = -1;
  for (const line of lines) {
    if (!inData) {
      const m = line.match(/^(\s*)data:\s*\{/);
      if (m) {
        inData = true;
        dataIndent = m[1].length;
      }
      continue;
    }
    // data 块结束：缩进与 data 相同或更浅的右括号
    const trimmed = line.trim();
    if (trimmed.startsWith("}") && line.search(/\S/) <= dataIndent) break;
    // 只取 data 直属字段（缩进 = dataIndent + 2）
    const m = line.match(/^\s{0,20}?([A-Za-z_][\w]*)\s*:/);
    if (m) {
      const indent = line.search(/\S/);
      if (indent === dataIndent + 2) keys.add(m[1]);
    }
  }
  return keys;
}

/** 提取 Page 对象上定义的方法名（含 async 前缀） */
function extractMethods(ts) {
  const methods = new Set();
  const re = /^\s{2}(?:async\s+)?([A-Za-z_][\w]*)\s*\(/gm;
  let m;
  while ((m = re.exec(ts))) methods.add(m[1]);
  return methods;
}

function countTags(wxml) {
  const opens = [];
  const closes = [];
  const selfClosed = [];
  const re = /<(\/?)([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(wxml))) {
    const [, closing, tag, , selfClose] = m;
    if (selfClose === "/") selfClosed.push(tag);
    else if (closing === "/") closes.push(tag);
    else opens.push(tag);
  }
  const cnt = (arr) => {
    const o = {};
    for (const t of arr) o[t] = (o[t] || 0) + 1;
    return o;
  };
  const co = cnt(opens);
  const cc = cnt(closes);
  const sc = cnt(selfClosed);
  const unpaired = {};
  for (const t of new Set([...Object.keys(co), ...Object.keys(cc)])) {
    const open = (co[t] || 0) - (sc[t] || 0);
    const close = cc[t] || 0;
    if (open !== close) unpaired[t] = { open, close };
  }
  return unpaired;
}

function checkPage(name) {
  const tsPath = path.join(PAGES_DIR, name, name + ".ts");
  const wxmlPath = path.join(PAGES_DIR, name, name + ".wxml");
  if (!fs.existsSync(tsPath) || !fs.existsSync(wxmlPath)) {
    console.log(`  [SKIP] ${name}（缺少 .ts 或 .wxml）`);
    return 0;
  }
  const ts = fs.readFileSync(tsPath, "utf8");
  const rawWxml = fs.readFileSync(wxmlPath, "utf8");
  // 去掉 WXML 注释（<!-- ... -->）后再做模板变量检查：
  // 注释里常保留历史踩坑说明（如「原 {{formatTime(x)}} 求值为空」），
  // 那不是真实的模板引用。
  const wxml = rawWxml.replace(/<!--[\s\S]*?-->/g, "");

  const problems = [];

  // ⑤ WXSS 选择器不得含中文（2026-10-27 实踩：.q-diff-简单 编译报
  //    "unexpected character"，页面白屏）。选择器行 = 以 . # @ [ & 开头且含中文。
  const wxssPath = path.join(PAGES_DIR, name, name + ".wxss");
  if (fs.existsSync(wxssPath)) {
    const lines = fs.readFileSync(wxssPath, "utf8").split(/\r?\n/);
    const badSel = [];
    lines.forEach((l, i) => {
      const t = l.trim();
      if (/^[.#@\[&]/.test(t) && /[\u4e00-\u9fa5]/.test(t)) badSel.push(`行${i + 1}: ${t.slice(0, 40)}`);
    });
    if (badSel.length) {
      problems.push(`★WXSS 选择器含中文（编译会报 unexpected character，改用 ASCII 类名）: ${badSel.join(" | ")}`);
    }
  }

  // ① 事件绑定的函数必须在 TS 中定义
  const handlers = new Set();
  for (const m of wxml.matchAll(/(?:bind|catch)[a-zA-Z]+="([A-Za-z_][\w]*)"/g)) handlers.add(m[1]);
  const methods = extractMethods(ts);
  const missingHandlers = [...handlers].filter((h) => !methods.has(h)).sort();
  if (missingHandlers.length) {
    problems.push(`事件绑定函数未在 TS 中定义: ${missingHandlers.join(", ")}`);
  }

  // ② 模板引用的顶层变量必须在 data 中声明
  const dataKeys = extractDataKeys(ts);
  const used = new Set();
  for (const m of wxml.matchAll(/\{\{\s*([A-Za-z_][\w]*)/g)) used.add(m[1]);
  // 模板内自带的循环变量（wx:for 的 item / index）不算 data 字段
  const LOOP_VARS = new Set(["item", "index", "value", "true", "false", "null", "undefined"]);
  const undeclared = [...used].filter((v) => !dataKeys.has(v) && !LOOP_VARS.has(v)).sort();
  if (undeclared.length) {
    problems.push(`模板变量未在 data 中声明: ${undeclared.join(", ")}`);
  }

  // ③ 标签配对
  const unpaired = countTags(wxml);
  if (Object.keys(unpaired).length) {
    problems.push(
      "标签未配对: " +
        Object.entries(unpaired)
          .map(([t, v]) => `${t}(开${v.open}/闭${v.close})`)
          .join(", ")
    );
  }

  // ④ 防重入铁律：按钮不得用 disabled
  const disabledTags = [];
  for (const m of wxml.matchAll(/<(button|input|textarea)\b[^>]*\bdisabled\s*=[^>]*>/g)) {
    disabledTags.push(m[0].slice(0, 120));
  }
  if (disabledTags.length) {
    problems.push(`★按钮/input 使用了 disabled 属性（会导致锁卡死后永久不可用）: ${disabledTags.join(" | ")}`);
  }

  if (problems.length) {
    console.log(`  [FAIL] ${name}`);
    for (const p of problems) console.log(`         - ${p}`);
    return problems.length;
  }
  console.log(`  [PASS] ${name}（事件绑定 ${handlers.size} 个 / 模板变量 ${used.size} 个 / 标签配对 / 无 disabled）`);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const pages = args.length ? args : listPages();
  console.log("=== 小程序静态自检三件套 ===");
  let bad = 0;
  for (const p of pages) bad += checkPage(p);
  console.log("-".repeat(52));
  if (bad === 0) {
    console.log(`全部通过：${pages.length} 个页面无静态缺陷`);
  } else {
    console.log(`发现 ${bad} 处静态缺陷`);
  }
  process.exit(bad === 0 ? 0 : 1);
}

main();
