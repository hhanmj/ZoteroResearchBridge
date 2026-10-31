#!/usr/bin/env python3
"""Minimal S3 SigV4 client for China Science & Technology Cloud data capsule.
Stdlib-only prototype; the Zotero plugin will reuse this signing scheme.

Usage:
  python s3_capsule.py put <localfile> <key>
  python s3_capsule.py get <key> <outfile>
  python s3_capsule.py head <key>
  python s3_capsule.py list [prefix]
  python s3_capsule.py ping

Config: ~/.zrb-secrets/capsule-s3.json
  {"endpoint","region","bucket","pathStyle","accessKeyId","secretAccessKey"}
Never print secrets.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import json
import os
import sys
import urllib.request
from urllib.parse import quote, urlparse

UNSIGNED = "UNSIGNED-PAYLOAD"


def load_config():
    p = os.path.expanduser("~/.zrb-secrets/capsule-s3.json")
    cfg = json.load(open(p, encoding="utf-8"))
    for k in ("endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"):
        if not cfg.get(k):
            raise KeyError(f"capsule-s3.json missing field: {k}")
    cfg.setdefault("pathStyle", True)
    return cfg


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _sigv4_headers(cfg, method, path, query, payload_hash, headers_extra=None):
    host = urlparse(cfg["endpoint"]).netloc
    t = _dt.datetime.now(_dt.timezone.utc)
    amzdate = t.strftime("%Y%m%dT%H%M%SZ")
    datestamp = t.strftime("%Y%m%d")
    # canonical URI: keep slashes, encode each segment
    canon_uri = quote(path, safe="/-_.~")
    canon_qs = "&".join(f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}"
                        for k, v in sorted((query or {}).items()))
    hdrs = {
        "host": host,
        "x-amz-date": amzdate,
        "x-amz-content-sha256": payload_hash,
    }
    if headers_extra:
        hdrs.update({k.lower(): v for k, v in headers_extra.items()})
    signed = ";".join(sorted(hdrs))
    canon_hdrs = "".join(f"{k}:{hdrs[k].strip()}\n" for k in sorted(hdrs))
    creq = "\n".join([method, canon_uri, canon_qs, canon_hdrs, signed, payload_hash])
    scope = f"{datestamp}/{cfg['region']}/s3/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope,
                     hashlib.sha256(creq.encode()).hexdigest()])
    k_date = _sign(("AWS4" + cfg["secretAccessKey"]).encode(), datestamp)
    k_region = _sign(k_date, cfg["region"])
    k_service = _sign(k_region, "s3")
    k_signing = _sign(k_service, "aws4_request")
    sig = hmac.new(k_signing, sts.encode(), hashlib.sha256).hexdigest()
    hdrs["authorization"] = (f"AWS4-HMAC-SHA256 Credential={cfg['accessKeyId']}/{scope}, "
                             f"SignedHeaders={signed}, Signature={sig}")
    return hdrs


def _url(cfg, key=""):
    base = cfg["endpoint"].rstrip("/")
    if cfg.get("pathStyle", True):
        return base + "/" + cfg["bucket"] + ("/" + quote(key, safe="/-_.~") if key else "")
    raise NotImplementedError("virtual-host style not used by capsule console")


def _ua(cfg):
    # 数据胶囊按 AccessKey 创建时所选"应用"校验 User-Agent：UA 必须包含应用名（不分大小写）。
    # 实测规则：'S3Drive' 通过，'curl'/'rclone'/'obsidian'/无 UA 全部 401（空响应体）。
    app = cfg.get("uaApp", "S3Drive")
    return f"{app}/ZoteroResearchBridge"


def request(cfg, method, key="", query=None, body=b"", content_type=None):
    # 空 body 用空串 SHA256（标准 SigV4），非 UNSIGNED-PAYLOAD
    ph = hashlib.sha256(body).hexdigest()
    if body and content_type:
        h = _sigv4_headers(cfg, method, _path(cfg, key), query, ph,
                           {"content-type": content_type})
    else:
        h = _sigv4_headers(cfg, method, _path(cfg, key), query, ph)
    url = _url(cfg, key)
    if query:
        from urllib.parse import urlencode
        url += "?" + urlencode(query)
    req = urllib.request.Request(url, data=body if body else None, method=method)
    for k, v in h.items():
        req.add_header(k if k != "host" else "Host", v)
    req.add_header("User-Agent", _ua(cfg))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _path(cfg, key=""):
    p = "/" + cfg["bucket"]
    if key:
        p += "/" + quote(key, safe="/-_.~")
    return p


def cmd_ping(cfg):
    st, body = request(cfg, "GET", "", query={"list-type": "2", "max-keys": "5"})
    ok = st == 200
    print(f"{'PASS' if ok else 'FAIL'}: ListObjectsV2 HTTP {st}"
          + ("" if ok else f" :: {body[:400].decode('utf-8','replace')}"))
    return 0 if ok else 1


def cmd_put(cfg, local, key):
    data = open(local, "rb").read()
    ct = "text/markdown; charset=utf-8" if key.endswith(".md") else "application/octet-stream"
    st, body = request(cfg, "PUT", key, body=data, content_type=ct)
    ok = st in (200, 201)
    print(f"{'PASS' if ok else 'FAIL'}: PUT {key} ({len(data)}B) HTTP {st}"
          + ("" if ok else f" :: {body[:400].decode('utf-8','replace')}"))
    etag = ""
    return 0 if ok else 1


def cmd_get(cfg, key, out):
    st, body = request(cfg, "GET", key)
    if st == 200:
        open(out, "wb").write(body)
        print(f"PASS: GET {key} -> {out} ({len(body)}B)")
        return 0
    print(f"FAIL: GET {key} HTTP {st} :: {body[:300].decode('utf-8','replace')}")
    return 1


def cmd_head(cfg, key):
    st, body = request(cfg, "HEAD", key)
    print(f"HEAD {key} -> HTTP {st}")
    return 0 if st == 200 else 1


def cmd_list(cfg, prefix=""):
    q = {"list-type": "2", "max-keys": "1000"}
    if prefix:
        q["prefix"] = prefix
    st, body = request(cfg, "GET", "", query=q)
    if st != 200:
        print(f"FAIL list HTTP {st} :: {body[:300].decode('utf-8','replace')}")
        return 1
    import re
    keys = re.findall(r"<Key>([^<]+)</Key>", body.decode("utf-8", "replace"))
    for k in keys:
        print(k)
    print(f"-- {len(keys)} keys (truncated if 1000)")
    return 0


def main():
    cfg = load_config()
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    cmd = args[0]
    try:
        if cmd == "ping":
            return cmd_ping(cfg)
        if cmd == "put":
            return cmd_put(cfg, args[1], args[2])
        if cmd == "get":
            return cmd_get(cfg, args[1], args[2])
        if cmd == "head":
            return cmd_head(cfg, args[1])
        if cmd == "list":
            return cmd_list(cfg, args[1] if len(args) > 1 else "")
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}")
        return 1
    print("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
