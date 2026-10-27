#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""云端部署验证：download 云端代码 → 与本地逐文件 md5 比对。

为什么必须这么做：
  `cli cloud functions deploy` 返回 success=true **不可信**（历史上多次出现
  「返回成功但代码没更新」的情况）。唯一可信的验证是：
    1. 用 `cli cloud functions download` 把云端代码拉回本地临时目录；
    2. 对 index.js / config.json / package.json 等关键文件逐个算 md5；
    3. 与仓库里的同名文件比对，完全一致才算部署成功。

用法：
  python scripts/verify_cloud_deploy.py                        # 校验全部函数
  python scripts/verify_cloud_deploy.py parseResume deepSession # 校验指定函数
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCTIONS_DIR = os.path.join(PROJECT, "cloudfunctions")

DEFAULT_CLI_CANDIDATES = [
    r"D:\tools\微信web开发者工具\cli.bat",
    r"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat",
    r"C:\Program Files\Tencent\微信web开发者工具\cli.bat",
]

# 每个云函数里需要比对的关键文件
KEY_FILES = ["index.js", "config.json", "package.json", "sec-check.js", "llm.js", "injection.js"]


def find_cli() -> str:
    env = os.environ.get("WECHAT_DEVTOOLS_CLI")
    if env and os.path.isfile(env):
        return env
    for p in DEFAULT_CLI_CANDIDATES:
        if os.path.isfile(p):
            return p
    sys.exit("找不到 cli.bat，请设置环境变量 WECHAT_DEVTOOLS_CLI 指向它")


def env_id() -> str:
    cfg = os.path.join(PROJECT, "cloudbaserc.json")
    with open(cfg, encoding="utf-8") as f:
        eid = json.load(f).get("envId", "")
    if not eid or "{{" in eid:
        sys.exit("cloudbaserc.json 的 envId 仍是占位符")
    return eid


def md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def run(cli: str, args: list, timeout=300) -> subprocess.CompletedProcess:
    return subprocess.run(
        [cli] + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )


def list_cloud_functions(cli: str, eid: str):
    r = run(cli, ["cloud", "functions", "list", "--env", eid, "--project", PROJECT])
    out = (r.stdout or "") + (r.stderr or "")
    names = []
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("*"):
            names.append(s.lstrip("* ").strip())
    return names


def download_function(cli: str, eid: str, fn: str, dest: str):
    """下载单个云函数代码到 dest 目录。返回是否成功。

    ⚠️ CLI 签名为 `download --env <eid> --name <fn> --path <dir>`
       （注意是 --path 不是 --dest；--name 单数，--names 才是 deploy 用的复数）
    """
    os.makedirs(dest, exist_ok=True)
    r = run(cli, ["cloud", "functions", "download", "--env", eid,
                  "--name", fn, "--project", PROJECT, "--path", dest])
    out = (r.stdout or "") + (r.stderr or "")
    ok = "Missing required argument" not in out and "download cloudfunction" in out.lower() or "√" in out
    return ok, out


def find_downloaded(dest: str, fn: str):
    """CLI 下载后的目录结构在不同版本里不一样：
       可能是 dest/<fn>/... 也可能是 dest/... 甚至 dest 下直接铺文件。
       这里递归找出含 index.js 的那一层。"""
    for root, _dirs, files in os.walk(dest):
        if "index.js" in files:
            return root
    return None


def main():
    cli = find_cli()
    eid = env_id()
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    cloud_names = list_cloud_functions(cli, eid)
    targets = args or sorted(cloud_names)

    print(f"CLI      : {cli}")
    print(f"ENV      : {eid}")
    print(f"云端函数 : {len(cloud_names)} 个")
    print("")

    tmp_root = tempfile.mkdtemp(prefix="fm_verify_")
    all_ok = True
    summary = []

    try:
        for fn in targets:
            local_dir = os.path.join(FUNCTIONS_DIR, fn)
            if not os.path.isdir(local_dir):
                print(f"[SKIP] {fn}：本地无此目录")
                continue

            dest = os.path.join(tmp_root, fn)
            ok, log = download_function(cli, eid, fn, dest)
            if not ok:
                print(f"[FAIL] {fn}：download 未成功")
                for line in log.splitlines()[-12:]:
                    print("       " + line)
                all_ok = False
                summary.append((fn, "download 失败", 0, 0))
                continue

            got = find_downloaded(dest, fn)
            if not got:
                print(f"[FAIL] {fn}：下载结果里找不到 index.js")
                all_ok = False
                summary.append((fn, "下载内容异常", 0, 0))
                continue

            same = 0
            diff = 0
            detail = []
            for fname in KEY_FILES:
                lp = os.path.join(local_dir, fname)
                rp = os.path.join(got, fname)
                if not os.path.isfile(lp):
                    continue
                if not os.path.isfile(rp):
                    # 云端可能不包含某些共享副本（如未用到 sec-check.js）
                    detail.append(f"{fname}: 云端缺失")
                    diff += 1
                    continue
                lm, rm = md5(lp), md5(rp)
                if lm == rm:
                    same += 1
                    detail.append(f"{fname}: {lm} ✓")
                else:
                    diff += 1
                    detail.append(f"{fname}: 本地 {lm} ≠ 云端 {rm} ✗")

            status = "OK " if diff == 0 else "DIFF"
            print(f"[{status}] {fn}：一致 {same} 个，不一致/缺失 {diff} 个")
            for d in detail:
                print("       - " + d)
            if diff:
                all_ok = False
            summary.append((fn, status.strip(), same, diff))
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    print("")
    print("=" * 60)
    print(f"{'函数':<22}{'状态':<10}{'一致':<8}{'差异'}")
    for fn, st, s, d in summary:
        print(f"{fn:<22}{st:<10}{s:<8}{d}")
    print("=" * 60)
    if all_ok:
        print("结论：全部函数云端代码与本地逐字节一致 ✅")
    else:
        print("结论：存在不一致，需重新部署 ❌")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
