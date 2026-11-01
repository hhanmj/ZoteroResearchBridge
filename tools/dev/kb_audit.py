# -*- coding: utf-8 -*-
"""知识库入库对账：逐篇探测 380 篇哪些已在知识库（含解析完成），输出缺失清单 + 补传文件夹。"""
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")))
import kb_mcp_client as K  # noqa: E402

STAGING = r"%USERPROFILE%\Zotero\zrb-upload-staging"
OUT = os.path.dirname(os.path.abspath(__file__))

# 1. 收集 380 篇（attachmentKey -> staging 文件名）
papers = {}
for f in os.listdir(STAGING):
    if f.endswith(".md") and "__" in f:
        ak = f.split("__")[1]
        papers[ak] = f
print(f"暂存区论文: {len(papers)}")

c = K.KBMCP()
c.connect()
c.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                     "clientInfo": {"name": "zrb-audit", "version": "0.1"}}, msg_id=1)
c.rpc("notifications/initialized", None)

found, missing = set(), []
checked = 0
reconnects = 0
for ak, fname in papers.items():
    ok = False
    for attempt in range(2):
        try:
            r = c.rpc("tools/call", {"name": "search", "arguments": {
                "query": ak, "top_k": 5, "enable_rerank": False}}, msg_id=checked + 10)
            chunks = json.loads(r["result"]["content"][0]["text"], strict=False).get("data", {}).get("chunks", [])
            ok = any(ak in (x.get("chunkContent") or "") for x in chunks)
            break
        except Exception as e:
            reconnects += 1
            try:
                c.close()
            except Exception:
                pass
            time.sleep(2)
            c = K.KBMCP()
            c.connect()
            c.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                 "clientInfo": {"name": "zrb-audit", "version": "0.1"}}, msg_id=1)
            c.rpc("notifications/initialized", None)
    if ok:
        found.add(ak)
    else:
        missing.append((ak, fname))
    checked += 1
    if checked % 40 == 0:
        print(f"已探测 {checked}/{len(papers)}：在库 {len(found)}，缺失 {len(missing)}（重连 {reconnects}）", flush=True)

try:
    c.close()
except Exception:
    pass

print(f"\n===== 对账结果：在库 {len(found)} / {len(papers)}，缺失 {len(missing)} =====")
with open(os.path.join(OUT, "kb_missing.json"), "w", encoding="utf-8") as f:
    json.dump({"found": sorted(found), "missing": missing}, f, ensure_ascii=False, indent=1)

# 2. 生成补传文件夹
retry_dir = r"%USERPROFILE%\Zotero\zrb-kb-retry"
os.makedirs(retry_dir, exist_ok=True)
for old in os.listdir(retry_dir):
    os.remove(os.path.join(retry_dir, old))
for ak, fname in missing:
    shutil.copy2(os.path.join(STAGING, fname), os.path.join(retry_dir, fname))
print(f"补传文件夹已生成: {retry_dir}（{len(missing)} 个文件）")
