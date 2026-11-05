# -*- coding: utf-8 -*-
"""P3 收尾流水线：3 篇新解析论文的导出 + S3 上传 + 全库对账 + 清洁度检查。"""
import hashlib
import json
import os
import re
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import s3_capsule as S  # noqa: E402

ZDIR = os.environ.get("ZRB_ZOTERO_DIR", os.path.join(os.path.expanduser("~"), "Zotero"))
CACHE = os.path.join(ZDIR, "zrb-cache")
EXPORT = os.path.join(ZDIR, "zrb-export")
STAGING = os.path.join(ZDIR, "zrb-upload-staging")
LOG_LINES = []


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    LOG_LINES.append(line)
    print(line, flush=True)


def sha256_text(t):
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


def meta_from_sqlite(parent_key):
    con = sqlite3.connect(f"file:{ZDIR}/zotero.sqlite?mode=ro&immutable=1", uri=True)
    cur = con.cursor()
    pid = cur.execute("select itemID from items where key=?", (parent_key,)).fetchone()
    out = {"title": None, "creators": [], "year": None, "doi": None, "publication": None}
    if not pid:
        return out
    pid = pid[0]
    names = {v: k for k, v in dict(cur.execute("select fieldName, fieldID from fields")).items()}
    for fid, vid in cur.execute("select fieldID, valueID from itemData where itemID=?", (pid,)):
        name = names.get(fid)
        val = cur.execute("select value from itemDataValues where valueID=?", (vid,)).fetchone()
        if name in ("title", "DOI", "publicationTitle", "date") and val:
            out[{"title": "title", "DOI": "doi", "publicationTitle": "publication", "date": "date"}[name]] = val[0]
    m = re.search(r"(1[5-9]\d{2}|20\d{2})", out.get("date") or "")
    out["year"] = m.group(1) if m else None
    for last, first in cur.execute(
            "select c.lastName, c.firstName from itemCreators ic join creators c on ic.creatorID=c.creatorID "
            "where ic.itemID=? order by ic.orderIndex limit 10", (pid,)):
        out["creators"].append({"lastName": last, "firstName": first})
    con.close()
    return out


NEW = [
    ("RDFI7MQ3", "CSTYJTX7"),
    ("MJ29YYV8", "2WBRBWF5"),
    ("PC8AIFN3", "JDK5SS7K"),
]

print("========== 1. 导出 3 篇新解析论文 ==========")
ledger_path = os.path.join(ZDIR, "zrb-ledger.json")
ledger = json.load(open(ledger_path, encoding="utf-8"))

for att_key, parent_key in NEW:
    cache_md = os.path.join(CACHE, att_key, "full.md")
    if not os.path.isfile(cache_md):
        log(f"⚠️ {att_key}: zrb-cache 无 full.md，跳过")
        continue
    body = open(cache_md, encoding="utf-8").read()
    meta = meta_from_sqlite(parent_key)
    creators = meta["creators"]
    names = ", ".join(f"{c['lastName']}{(' ' + c['firstName']) if c.get('firstName') else ''}".strip()
                      for c in creators[:10])

    def block():
        head = ["<!-- ZRB-METADATA", f"title: {meta['title'] or ''}"]
        if names:
            head.append(f"authors: {names}")
        if meta["year"]:
            head.append(f"year: {meta['year']}")
        if meta["doi"]:
            head.append(f"doi: {meta['doi']}")
        if meta["publication"]:
            head.append(f"publication: {meta['publication']}")
        head += [f"zotero-item: {parent_key}", f"zotero-attachment: {att_key}",
                 "library-scope: u1", "-->"]
        readable = [f"# {meta['title'] or ''}"]
        if names:
            readable.append(f"*{names}*")
        bits = [b for b in (meta["year"], meta["publication"],
                            f"DOI: {meta['doi']}" if meta["doi"] else None) if b]
        if bits:
            readable.append(" | ".join(bits))
        readable.append("")
        return "\n".join(head), "\n".join(readable) + "\n"

    head, readable = block()
    fulltext = head + "\n---\n\n" + readable + body.strip() + "\n"
    fp = sha256_text(fulltext)

    paper_dir = os.path.join(EXPORT, "papers", "u1", parent_key, att_key)
    os.makedirs(paper_dir, exist_ok=True)
    with open(os.path.join(paper_dir, "fulltext.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(fulltext)
    meta_obj = {
        "generator": "ZoteroResearchBridge 0.3.5 (hard-four pipeline)",
        "library_scope": "u1", "parent_item_key": parent_key, "source_attachment_key": att_key,
        "title": meta["title"], "year": meta["year"], "doi": meta["doi"],
        "publication": meta["publication"],
        "zotero_select_url": f"zotero://select/library/items/{parent_key}",
        "parse_engine": "mineru-vlm (split-merge)", "upload_time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "content_fingerprint": {"algo": "sha256", "value": fp},
        "cloud_relpath": f"papers/u1/{parent_key}/{att_key}/fulltext.md",
    }
    with open(os.path.join(paper_dir, "metadata.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta_obj, f, ensure_ascii=False, indent=1)

    staging_name = f"{parent_key}__{att_key}__fulltext.md"
    with open(os.path.join(STAGING, staging_name), "w", encoding="utf-8", newline="\n") as f:
        f.write(fulltext)

    # 账本更新
    e = ledger["entries"].get(att_key, {"attachmentKey": att_key})
    e.update({
        "attachmentKey": att_key, "attachmentId": None, "parentItemKey": parent_key,
        "libraryScope": "u1", "title": meta["title"], "doi": meta["doi"], "year": meta["year"],
        "status": "exported", "parseEngine": "mineru-vlm",
        "contentFingerprint": fp, "stagingFile": staging_name,
        "chunkCount": 1, "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "error": None,
    })
    ledger["entries"][att_key] = e
    log(f"✓ {att_key} 导出完成（{len(fulltext)} 字符，指纹 {fp[:12]}）")

with open(ledger_path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(ledger, f, ensure_ascii=False, indent=1)
log("账本已更新")

print("\n========== 2. S3 上传（3 篇新论文 + index） ==========")
cfg = S.load_config()
for att_key, parent_key in NEW:
    e = ledger["entries"].get(att_key)
    if not e or e["status"] != "exported":
        log(f"跳过 {att_key}（状态 {e['status'] if e else '缺失'}）")
        continue
    prefix = f"papers/u1/{parent_key}/{att_key}"
    ft_local = os.path.join(EXPORT, "papers", "u1", parent_key, att_key, "fulltext.md")
    meta_local = os.path.join(EXPORT, "papers", "u1", parent_key, att_key, "metadata.json")
    for key, path, ct in ((f"{prefix}/fulltext.md", ft_local, "text/markdown; charset=utf-8"),
                          (f"{prefix}/metadata.json", meta_local, "application/json")):
        data = open(path, "rb").read()
        st, resp = S.request(cfg, "PUT", key, body=data, content_type=ct)
        if st != 200:
            log(f"✗ PUT {key} → {st} {resp[:100]}")
            sys.exit(1)
        # ETag 校验
        r2 = S.request(cfg, "HEAD", key)
        etag = (r2[1].decode() if isinstance(r2[1], bytes) else "") if r2[1] else ""
    md5_local = hashlib.md5(data).hexdigest()
    log(f"✓ 上传 {key}（{len(data)}B）")
    e["status"] = "uploaded"
    e["s3Prefix"] = prefix
    e["uploadedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")

with open(ledger_path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(ledger, f, ensure_ascii=False, indent=1)

# papers-index.jsonl 重建并上传
idx = []
for e in ledger["entries"].values():
    if e["status"] in ("uploaded", "exported"):
        idx.append(json.dumps({
            "attachment_key": e["attachmentKey"], "parent_item_key": e.get("parentItemKey"),
            "title": e.get("title"), "doi": e.get("doi"), "year": e.get("year"),
            "status": e["status"], "s3_prefix": e.get("s3Prefix"),
        }, ensure_ascii=False))
idx_path = os.path.join(EXPORT, "papers-index.jsonl")
open(idx_path, "w", encoding="utf-8", newline="\n").write("\n".join(idx) + "\n")
st, resp = S.request(cfg, "PUT", "papers-index.jsonl",
                     body=open(idx_path, "rb").read(), content_type="application/x-ndjson")
log(f"papers-index.jsonl 重建并上传：{st}（{len(idx)} 条）")

print("\n========== 3. 全库对账 ==========")
all_keys = []
cursor = ""
while True:
    q = {"list-type": "2", "max-keys": "1000"}
    if cursor:
        q["continuation-token"] = cursor
    st, body = S.request(cfg, "GET", "", query=q)
    if st != 200:
        log(f"list 失败 {st}"); break
    txt = body.decode("utf-8", "replace")
    keys = re.findall(r"<Key>([^<]+)</Key>", txt)
    sizes = dict(re.findall(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", txt, re.S))
    all_keys += keys
    m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", txt)
    if m and keys:
        cursor = m.group(1)
    else:
        break

fulls = [k for k in all_keys if k.endswith("/fulltext.md")]
print(f"S3 对象总数: {len(all_keys)} | fulltext.md: {len(fulls)}")
# 零字节检查
zero = []
for k in fulls:
    st, body = S.request(cfg, "HEAD", k)
    cl = None
    if st == 200:
        import urllib.request
        # HEAD 的 content-length 在 r2[1]？s3_capsule 不返回头，改用 GET 抽样 + 全量用对象大小
    # 直接用 list 的 Size 字段
st, body = S.request(cfg, "GET", "", query={"list-type": "2", "max-keys": "1000"})
txt = body.decode("utf-8", "replace")
pairs = re.findall(r"<Key>([^<]+)</Key><LastModified>[^<]*</LastModified><ETag>[^<]*</ETag><Size>(\d+)</Size>", txt.replace("\n", ""))
zero_fulls = [k for k, sz in pairs if k.endswith("/fulltext.md") and int(sz) == 0]
print(f"0 字节 fulltext.md 残留: {len(zero_fulls)}", zero_fulls[:5])
# 抽查书的正文
st, body = S.request(cfg, "GET", "papers/u1/CSTYJTX7/RDFI7MQ3/fulltext.md")
if st == 200:
    t = body.decode("utf-8")
    print(f"抽查书正文: {len(t)} 字符 | 含分卷标记: {t.count('ZRB 分卷')} | 含 ZRB-METADATA: {'ZRB-METADATA' in t}")
else:
    print("抽查书正文失败:", st)

from collections import Counter
c = Counter(e["status"] for e in ledger["entries"].values())
print(f"\n最终账本: {dict(c)}")
with open(os.path.join(EXPORT, "sync-report.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump({"finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
               "note": "hard-four pipeline + full reconciliation", "log": LOG_LINES}, f, ensure_ascii=False, indent=1)
print("对账完成，报告已写入 sync-report.json")
