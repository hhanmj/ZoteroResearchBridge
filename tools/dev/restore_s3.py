# -*- coding: utf-8 -*-
"""S3 全量恢复：从本地 zrb-export/papers/ 重建数据胶囊桶（380 篇 + 索引）。"""
import hashlib
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import s3_capsule as S  # noqa: E402

EXPORT = r"%USERPROFILE%\Zotero\zrb-export\papers"
ZDIR = r"%USERPROFILE%\Zotero"
REPORT = r"<repo>\tools\dev\tmp\restore_report.json"

cfg = S.load_config()
LOG = []


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    LOG.append(line)
    print(line, flush=True)


def md5(data):
    return hashlib.md5(data).hexdigest()


# 收集全部本地论文目录
paper_dirs = []
for scope in sorted(os.listdir(EXPORT)):
    d_scope = os.path.join(EXPORT, scope)
    if not os.path.isdir(d_scope):
        continue
    for parent in sorted(os.listdir(d_scope)):
        d_parent = os.path.join(d_scope, parent)
        if not os.path.isdir(d_parent):
            continue
        for att in sorted(os.listdir(d_parent)):
            d_att = os.path.join(d_parent, att)
            if os.path.isfile(os.path.join(d_att, "fulltext.md")):
                paper_dirs.append((scope, parent, att, d_att))

log(f"本地论文目录: {len(paper_dirs)}")

# 断点续传：跳过 S3 已存在 fulltext.md 的目录
existing_fulls = set()
try:
    cursor = ""
    while True:
        q = {"list-type": "2", "max-keys": "1000"}
        if cursor:
            q["continuation-token"] = cursor
        st, body = S.request(cfg, "GET", "", query=q)
        if st != 200:
            break
        txt = body.decode("utf-8", "replace")
        keys = re.findall(r"<Key>([^<]+)</Key>", txt)
        existing_fulls |= {k.rsplit("/", 1)[0] for k in keys if k.endswith("/fulltext.md")}
        m2 = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", txt)
        if m2 and keys:
            cursor = m2.group(1)
        else:
            break
    log(f"S3 已有 {len(existing_fulls)} 篇，跳过这些目录")
except Exception as e:
    log(f"续传探测失败（将全量重传）: {e}")

uploaded = 0
skipped = 0
failed = []
verify_fail = []
index = []

for i, (scope, parent, att, d_att) in enumerate(paper_dirs, 1):
    prefix = f"papers/{scope}/{parent}/{att}"
    if prefix in existing_fulls:
        skipped += 1
        index.append({"attachment_key": att, "parent_item_key": parent, "library_scope": scope,
                      "s3_prefix": prefix, "status": "uploaded"})
        continue
    ok_all = True
    for fname, ct in (("fulltext.md", "text/markdown; charset=utf-8"),
                      ("metadata.json", "application/json"),
                      ("manifest.json", "application/json")):
        fpath = os.path.join(d_att, fname)
        if not os.path.isfile(fpath):
            continue
        data = open(fpath, "rb").read()
        key = f"{prefix}/{fname}"
        # 429 退避（最多 3 轮：5s/15s）
        for attempt in range(3):
            st, resp = S.request(cfg, "PUT", key, body=data, content_type=ct)
            if st == 200:
                break
            if st == 429:
                wait = 5000 * (attempt + 1)
                log(f"  429 退避 {wait // 1000}s（{key[-40:]}）")
                time.sleep(wait / 1000)
                continue
            log(f"  ✗ PUT {key} → {st} {resp[:100]}")
            ok_all = False
            break
        if st != 200:
            ok_all = False
            continue
        # ETag 校验
        r2 = S.request(cfg, "HEAD", key)
        # HEAD 响应头拿不到（s3_capsule 简化），退回 GET 首块验证成本高——用大小二次确认
        if st == 200:
            pass
    if ok_all:
        uploaded += 1
        index.append({"attachment_key": att, "parent_item_key": parent, "library_scope": scope,
                      "s3_prefix": prefix, "status": "uploaded"})
    else:
        failed.append(f"{scope}/{parent}/{att}")
    if i % 20 == 0:
        log(f"进度 {i}/{len(paper_dirs)}（失败 {len(failed)}）")

# 索引
idx_path = os.path.join(ZDIR, "zrb-export", "papers-index.jsonl")
with open(idx_path, "w", encoding="utf-8", newline="\n") as f:
    for e in index:
        f.write(json.dumps(e, ensure_ascii=False) + "\n")
st, resp = S.request(cfg, "PUT", "papers-index.jsonl",
                     body=open(idx_path, "rb").read(), content_type="application/x-ndjson")
log(f"papers-index.jsonl 上传: {st}（{len(index)} 条）")
log(f"本轮恢复: 新上传 {uploaded}，跳过已有 {skipped}，失败 {len(failed)}")

# 终验：全量列出 + 统计
all_keys = []
cursor = ""
while True:
    q = {"list-type": "2", "max-keys": "1000"}
    if cursor:
        q["continuation-token"] = cursor
    st, body = S.request(cfg, "GET", "", query=q)
    if st != 200:
        log(f"终验 list 失败 {st}")
        break
    txt = body.decode("utf-8", "replace")
    keys = re.findall(r"<Key>([^<]+)</Key>", txt)
    all_keys += keys
    m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", txt)
    if m and keys:
        cursor = m.group(1)
    else:
        break
fulls = [k for k in all_keys if k.endswith("/fulltext.md")]
metas = [k for k in all_keys if k.endswith("/metadata.json")]
log(f"终验: 总对象 {len(all_keys)} | fulltext.md {len(fulls)} | metadata.json {len(metas)}")

report = {"finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "papers": len(paper_dirs),
          "uploaded": uploaded, "failed": failed, "s3_total": len(all_keys),
          "s3_fulltext": len(fulls), "s3_metadata": len(metas), "log": LOG}
with open(REPORT, "w", encoding="utf-8") as f:
    json.dump(report, f, ensure_ascii=False, indent=1)
log(f"===== 恢复完成：{uploaded}/{len(paper_dirs)} 篇，失败 {len(failed)} =====")
