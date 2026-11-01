# -*- coding: utf-8 -*-
"""MJ29YYV8 + PC8AIFN3：各拆 2 卷走 MinerU（卷 ≤200 页），结果并入 zrb-cache。"""
import json
import os
import sys
import time

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parse_hard_four as P  # 复用函数与 Key

TMP = P.TMP
TARGETS = [
    ("MJ29YYV8", P.PDFS["MJ29YYV8"]),
    ("PC8AIFN3", P.PDFS["PC8AIFN3"]),
]

results = {}
for att, pdf_path in TARGETS:
    try:
        P.log(f"== {att}（MinerU 拆 2 卷）==")
        src = pymupdf.open(pdf_path)
        n = src.page_count
        half = (n + 1) // 2
        parts = []
        for i, (a, b) in enumerate([(0, half - 1), (half, n - 1)], 1):
            part_path = os.path.join(TMP, f"{att}_p{i}.pdf")
            out = pymupdf.open()
            out.insert_pdf(src, from_page=a, to_page=b)
            out.save(part_path)
            parts.append((f"{att[:4]}p{i}", part_path))
            P.log(f"  卷 {i}: 页 {a + 1}-{b + 1}（{os.path.getsize(part_path) // 1048576}MB，{b - a + 1} 页）")
        src.close()
        r = P.run_mineru_multi(att, parts)
        if r[0] is not None:
            P.write_cache(att, r[0]["md"], r[0]["images"])
            results[att] = f"ok（full.md {len(r[0]['md'])} 字符）"
            P.log(f"  ✓ {results[att]}")
        else:
            results[att] = f"失败: {r[1]}"
            P.log(f"  ✗ {results[att]}")
    except Exception as e:
        results[att] = f"异常: {e}"
        P.log(f"  ✗ 异常: {e}")

report = os.path.join(TMP, "parse_two_more_report.json")
with open(report, "w", encoding="utf-8") as f:
    json.dump({"finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "results": results},
              f, ensure_ascii=False, indent=1)
P.log(f"===== 结束：{json.dumps(results, ensure_ascii=False)} =====")
