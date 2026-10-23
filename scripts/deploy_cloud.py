#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面镜 · 云函数批量部署脚本（微信开发者工具 CLI 封装）

为什么要有这个脚本：
  「10 个云函数在 IDE 里逐个右键上传」既慢又不可复现，还容易漏配超时/环境变量。
  本脚本把部署顺序固化下来（被依赖的先上），并对每一步打印可复核的命令。

前置条件（缺一不可）：
  1. 微信开发者工具已安装，且「设置 → 安全设置 → 服务端口」已开启；
  2. IDE 已登录（`cli.bat login` 或直接打开 IDE 扫码）；
  3. 项目已导入过一次（project.config.json 里已有 appid）。

用法：
  python scripts/deploy_cloud.py                # 干跑：只打印将执行的命令
  python scripts/deploy_cloud.py --apply        # 真的部署（约 3-6 分钟）
  python scripts/deploy_cloud.py --check        # 只列云端已有云函数，验证是否部署成功
  python scripts/deploy_cloud.py --apply --only asr analyze

注意：
  - 超时时间无法通过 config.json 设置（config.json 只管 openapi 权限与定时触发器），
    asr / analyze 需 60s，部署后必须去云开发控制台逐个改成 60s 并截图取证。
  - config.json 的 openapi 权限有 10 分钟缓存，刚上传后若报 -604101，等 10 分钟再试。
"""

import argparse
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 部署顺序：无依赖的先上，便于逐步验证
ORDER = [
    "login",           # 最先验证连通性
    "getQuestions",    # 只读题库
    "genQuestions",    # 依赖 LLM，失败降级 mock
    "submitPractice",  # 写 practices
    "getPractice",
    "getHistory",
    "updateTranscript",
    "asr",             # 依赖腾讯云凭证，失败走人工输入
    "analyze",         # 依赖 LLM，失败降级 mock
    "finalize",        # 依赖订阅消息模板 ID
]

DEFAULT_CLI_CANDIDATES = [
    r"D:\tools\微信web开发者工具\cli.bat",
    r"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat",
    r"C:\Program Files\Tencent\微信web开发者工具\cli.bat",
]


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
        sys.exit("cloudbaserc.json 的 envId 仍是占位符，请先填真实环境 ID")
    return eid


def run(cli: str, args: list, timeout=300) -> int:
    cmd = [cli] + args
    print("  $ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    out = (r.stdout or "").strip()
    err = (r.stderr or "").strip()
    if out:
        print("    " + out.replace("\n", "\n    ")[:4000])
    if err:
        print("    [stderr] " + err.replace("\n", "\n    ")[:2000])
    return r.returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正执行部署（默认只打印命令）")
    ap.add_argument("--check", action="store_true", help="只列云端云函数")
    ap.add_argument("--only", nargs="*", default=None, help="只部署指定函数")
    a = ap.parse_args()

    cli = find_cli()
    eid = env_id()
    targets = [f for f in ORDER if (a.only is None or f in a.only)]
    missing = [f for f in targets if not os.path.isdir(os.path.join(PROJECT, "cloudfunctions", f))]
    if missing:
        sys.exit(f"目录不存在，检查函数名：{missing}")

    print(f"CLI      : {cli}")
    print(f"PROJECT  : {PROJECT}")
    print(f"ENV      : {eid}")
    print(f"FUNCTIONS: {len(targets)} -> {', '.join(targets)}\n")

    if a.check:
        print("[1] 云端已有云函数：")
        run(cli, ["cloud", "functions", "list", "--env", eid, "--project", PROJECT])
        return

    if not a.apply:
        print("[干跑] 将执行以下命令（加 --apply 才真正上传）：")
        for f in targets:
            print(f"  cli cloud functions deploy --env {eid} --names {f} "
                  f"--project \"{PROJECT}\" --remote-npm-install")
        print("\n提示：也可一次性传多个 --names a b c，但逐个部署便于定位失败。")
        return

    ok, fail = [], []
    for i, f in enumerate(targets, 1):
        print(f"[{i}/{len(targets)}] 部署 {f}")
        rc = run(cli, ["cloud", "functions", "deploy", "--env", eid,
                       "--names", f, "--project", PROJECT, "--remote-npm-install"])
        (ok if rc == 0 else fail).append(f)

    print("\n部署成功：", ", ".join(ok) or "无")
    print("部署失败：", ", ".join(fail) or "无")
    print("\n[核对] 云端函数列表：")
    run(cli, ["cloud", "functions", "list", "--env", eid, "--project", PROJECT])
    print("\n[手动必做] 云开发控制台 → 云函数 → asr / analyze → 超时时间改 60s，并截图取证")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
