"""对比云端云函数代码包与本地目录的逐文件 md5（verify_cloud_deploy.py 的 MCP 替代方案，
因沙箱拦截 reg.exe 导致微信 CLI 不可用）。用法：python _check_cloud_code.py
下载地址来自 mcp getFunctionDownloadUrl（有效期 1 小时，过期重取）。
"""
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

REPO = r"E:\葛铭坤\26传智\团队赛\微信小程序\facemirror"

URLS = {
    "analyze": "https://function-codes-1258016615.cos.ap-guangzhou.myqcloud.com/%2F1498932176/lam-j56oae3n/%24LATEST/3f77bdf6-cd63-4c28-97c6-bf7e3f5e4f80/analyze.zip?q-sign-algorithm=sha1&q-ak=AKIDBBuNZU8VbQyEDvMVO0LOAfsoTryoRnsg&q-sign-time=1794800478%3B1794804078&q-key-time=1794800478%3B1794804078&q-header-list=host&q-url-param-list=&q-signature=f4fe28541b0c202cb11cc02359dda4f7d2ef447c",
    "updateTranscript": "https://function-codes-1258016615.cos.ap-guangzhou.myqcloud.com/%2F1498932176/lam-ds95joir/%24LATEST/9009e557-8b74-4720-b546-5b7b2fdc614b/updateTranscript.zip?q-sign-algorithm=sha1&q-ak=AKIDBBuNZU8VbQyEDvMVO0LOAfsoTryoRnsg&q-sign-time=1794800503%3B1794804103&q-key-time=1794800503%3B1794804103&q-header-list=host&q-url-param-list=&q-signature=7b756245388527541c532c0e914abf5de078da6d",
    "genQuestions": "https://function-codes-1258016615.cos.ap-guangzhou.myqcloud.com/%2F1498932176/lam-9r18gvwj/%24LATEST/53cea7b7-a15a-44ce-b00a-6fe9e0a79010/genQuestions.zip?q-sign-algorithm=sha1&q-ak=AKIDBBuNZU8VbQyEDvMVO0LOAfsoTryoRnsg&q-sign-time=1794800503%3B1794804103&q-key-time=1794800503%3B1794804103&q-header-list=host&q-url-param-list=&q-signature=e44afb3c68828c6aae5dbfaba73f8d3ece364b89",
    "genDeepQuestions": "https://function-codes-1258016615.cos.ap-guangzhou.myqcloud.com/%2F1498932176/lam-gassmzxr/%24LATEST/8effdfca-dbe4-41b1-8b90-d8513e5ef659/genDeepQuestions.zip?q-sign-algorithm=sha1&q-ak=AKIDBBuNZU8VbQyEDvMVO0LOAfsoTryoRnsg&q-sign-time=1794800503%3B1794804103&q-key-time=1794800503%3B1794804103&q-header-list=host&q-url-param-list=&q-signature=1cf9fa81364d5bd9e7f8b5fde41f04ccb7117d17",
    "parseResume": "https://function-codes-1258016615.cos.ap-guangzhou.myqcloud.com/%2F1498932176/lam-rib6868x/%24LATEST/f361b52f-61f4-4493-acd8-9b755a71de80/parseResume.zip?q-sign-algorithm=sha1&q-ak=AKIDBBuNZU8VbQyEDvMVO0LOAfsoTryoRnsg&q-sign-time=1794800504%3B1794804104&q-key-time=1794800504%3B1794804104&q-header-list=host&q-url-param-list=&q-signature=c923a3fb5241994c4f97f37614ebe4f98ec92799",
    "analyzeJob": "https://function-codes-1258016615.cos.ap-guangzhou.myqcloud.com/%2F1498932176/lam-6ob2cngv/%24LATEST/a4d5f3ba-2c53-4432-a20c-258d497a00e2/analyzeJob.zip?q-sign-algorithm=sha1&q-ak=AKIDBBuNZU8VbQyEDvMVO0LOAfsoTryoRnsg&q-sign-time=1794800503%3B1794804103&q-key-time=1794800503%3B1794804103&q-header-list=host&q-url-param-list=&q-signature=ed234d4a44616e2450d690d44380238a057b2114",
    "quizScore": "https://function-codes-1258016615.cos.ap-guangzhou.myqcloud.com/%2F1498932176/lam-nqwbw4vd/%24LATEST/2e55586c-f93c-4f12-9e83-0db4f6ce940c/quizScore.zip?q-sign-algorithm=sha1&q-ak=AKIDBBuNZU8VbQyEDvMVO0LOAfsoTryoRnsg&q-sign-time=1794800503%3B1794804103&q-key-time=1794800503%3B1794804103&q-header-list=host&q-url-param-list=&q-signature=86e7dd99e0205e4266594af118c821d08f4a35dc",
}


def md5(b):
    return hashlib.md5(b).hexdigest()


def local_files(fn):
    """本地函数目录 → {相对路径: md5}，排除 node_modules 与锁文件外的杂物"""
    d = os.path.join(REPO, "cloudfunctions", fn)
    out = {}
    for root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if x not in ("node_modules", ".git")]
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, d).replace("\\", "/")
            out[rel] = md5(open(p, "rb").read())
    return out


summary = []
for fn, url in URLS.items():
    zip_raw = urllib.request.urlopen(urllib.request.Request(url), timeout=120).read()
    zf = zipfile.ZipFile(io.BytesIO(zip_raw))
    cloud = {n: md5(zf.read(n)) for n in zf.namelist() if not n.endswith("/")}
    local = local_files(fn)
    # 云端部署包通常不带 package-lock（CLI 部署上传内容以 index/config/package/共享 js 为主）
    # 对比键：云端文件全集合 vs 本地同名文件
    diffs, missing_cloud = [], []
    for rel, h in local.items():
        if rel.endswith("package-lock.json"):
            continue
        if rel not in cloud:
            missing_cloud.append(rel)
        elif cloud[rel] != h:
            diffs.append(rel)
    extra_cloud = [rel for rel in cloud if rel not in local and not rel.startswith("node_modules/") and rel != "package-lock.json"]
    status = "SAME" if not (diffs or missing_cloud or extra_cloud) else "DIFF"
    summary.append((fn, status, len(local), diffs, missing_cloud, extra_cloud))
    print(f"[{status}] {fn}: 本地 {len(local)} 文件 | 代码差异 {diffs or '-'} | 云端缺 {missing_cloud or '-'} | 云端多 {extra_cloud or '-'}")

print("\n需部署函数:", [s[0] for s in summary if s[1] == "DIFF"] or "无")
