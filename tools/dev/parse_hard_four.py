# -*- coding: utf-8 -*-
"""硬骨头四篇解析流水线（OXR + MinerU），结果写入 zrb-cache/ 供插件导出管线使用。
免费额度核算：OXR 437 页（今日 500）+ MinerU 589+16 页（今日 1000）。"""
import json
import os
import re
import subprocess
import sys
import time

import pymupdf

PREFS = r"<Zotero Profile>/prefs.js"
ZDIR = r"%USERPROFILE%\Zotero"
CACHE = os.path.join(ZDIR, "zrb-cache")
TMP = r"<repo>\tools\dev\tmp"
REPORT = os.path.join(TMP, "parse_hard_report.json")

os.makedirs(TMP, exist_ok=True)
LOG_LINES = []


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    LOG_LINES.append(line)
    print(line, flush=True)


def pref(name):
    m = re.search(rf'user_pref\("extensions\.zotero\.zrb\.{name}",\s*"?(.*?)"?\);',
                  open(PREFS, encoding="utf-8", errors="replace").read())
    return m.group(1) if m else ""


OXR_KEY = pref("oxrApiKey")
MINERU_TOKEN = pref("mineruToken")

PDFS = {
    "RDFI7MQ3": r"%USERPROFILE%/Zotero/storage/RDFI7MQ3/Wang和Li - 2009 - Landslide disaster mitigation in three gorges reservoir, china.pdf",
    "MJ29YYV8": r"%USERPROFILE%/Zotero/storage/MJ29YYV8/van Leijen - Persistent scatterer interferometry based on geodetic estimation theory.pdf",
    "PC8AIFN3": r"%USERPROFILE%/Zotero/storage/PC8AIFN3/Kramer - Visibility in synthetic aperture radar satellite data metric formulation, observation scheduling, a.pdf",
    "ZI8SKGJV": r"%USERPROFILE%/Zotero/storage/ZI8SKGJV/JGR Earth Surface - 2020 - Bunn - Geologic Trends in Shear Strength Properties Inferred Through Three‐Dimensional Back.pdf",
}

IMAGES_RE = re.compile(r"images/([A-Za-z0-9_.-]+\.(?:jpe?g|png|gif|bmp|webp))", re.I)


def curl(args, timeout=1800):
    r = subprocess.run(["curl", "-s", "-m", str(timeout)] + args,
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout


def write_cache(att_key, md, images):
    """images: list of (arcname, bytes)"""
    d = os.path.join(CACHE, att_key)
    os.makedirs(os.path.join(d, "images"), exist_ok=True)
    with open(os.path.join(d, "full.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(md)
    for arcname, data in images:
        with open(os.path.join(d, "images", arcname), "wb") as f:
            f.write(data)
    log(f"  zrb-cache/{att_key}/ 写入 full.md {len(md)} 字符 + {len(images)} 图片")


# ---------------- OXR ----------------
def oxr_submit(att_key, pdf_path):
    r = subprocess.run(["curl", "-s", "-m", "1800", "-X", "POST",
                        "https://somark.cn/api/v1/parse/async",
                        "-F", f"api_key={OXR_KEY}", "-F", f"file=@{pdf_path}"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        j = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None, f"提交响应非 JSON: {r.stdout[:200]}"
    if j.get("code") != 0:
        return None, f"提交失败: {json.dumps(j, ensure_ascii=False)[:200]}"
    task_id = (j.get("data") or {}).get("task_id") or j.get("task_id")
    return task_id, None


def oxr_poll(task_id):
    for i in range(160):  # 40 分钟
        time.sleep(15)
        r = subprocess.run(["curl", "-s", "-m", "60", "-X", "POST",
                            "https://somark.cn/api/v1/parse/async_check",
                            "-F", f"api_key={OXR_KEY}", "-F", f"task_id={task_id}"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        try:
            j = json.loads(r.stdout)
        except json.JSONDecodeError:
            continue
        d = j.get("data") or {}
        state = str(d.get("state") or d.get("status") or "").lower()
        if i % 4 == 0:
            log(f"  OXR {task_id[:12]} poll#{i}: state={state}")
        if state in ("done", "success", "completed", "finish"):
            return j, None
        if state in ("failed", "error"):
            return None, json.dumps(j, ensure_ascii=False)[:300]
    return None, "OXR 轮询超时（40 分钟）"


def oxr_extract_md(j, att_key):
    """结果结构未知：保存原文 + 多候选提取。"""
    d = j.get("data") if isinstance(j.get("data"), dict) else j
    raw = json.dumps(j, ensure_ascii=False)
    with open(os.path.join(TMP, f"oxr_result_{att_key}.json"), "w", encoding="utf-8") as f:
        f.write(raw)
    for path in (
        ("markdown",), ("result", "markdown"), ("content",),
        ("data", "markdown"), ("data", "result", "markdown"), ("data", "content"),
        ("text",), ("data", "text"), ("result", "content"),
    ):
        cur = d
        ok = True
        for k in path:
            if isinstance(cur, dict) and k in cur and isinstance(cur[k], (str, list)):
                cur = cur[k]
            else:
                ok = False
                break
        if ok and isinstance(cur, str) and len(cur) > 100:
            return cur
        if ok and isinstance(cur, list) and all(isinstance(x, str) for x in cur):
            return "\n\n".join(cur)
    log(f"  ⚠️ OXR 结果结构未识别（已存 oxr_result_{att_key}.json），返回空正文")
    return ""


def run_oxr(att_key, pdf_path):
    log(f"OXR 提交 {att_key}（{os.path.getsize(pdf_path) // 1048576}MB）...")
    task_id, err = oxr_submit(att_key, pdf_path)
    if err:
        return None, err
    log(f"  task_id={task_id}")
    j, err = oxr_poll(task_id)
    if err:
        return None, err
    md = oxr_extract_md(j, att_key)
    return {"md": md, "images": []}, None


# ---------------- MinerU ----------------
def mineru_apply(files_meta):
    body = json.dumps({"files": files_meta, "model_version": "vlm",
                       "enable_formula": True, "enable_table": True, "language": "ch"})
    r = subprocess.run(["curl", "-s", "-m", "120", "-X", "POST",
                        "https://mineru.net/api/v4/file-urls/batch",
                        "-H", f"Authorization: Bearer {MINERU_TOKEN}",
                        "-H", "Content-Type: application/json", "-d", body],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    j = json.loads(r.stdout)
    if j.get("code") != 0:
        return None, f"apply 失败: {json.dumps(j, ensure_ascii=False)[:200]}"
    return j["data"], None


def mineru_upload(url, pdf_path):
    r = subprocess.run(["curl", "-s", "-m", "1800", "-X", "PUT", url,
                        "-H", "Content-Type:", "-H", "Expect:",
                        "--data-binary", f"@{pdf_path}", "-w", "\n%{http_code}"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = r.stdout.rsplit("\n", 1)
    code = out[-1].strip()
    return code, (out[0] if len(out) > 1 else "")[:200]


def mineru_poll(batch_id, timeout_min=60):
    for i in range(timeout_min * 4):
        time.sleep(15)
        r = subprocess.run(["curl", "-s", "-m", "60",
                            f"https://mineru.net/api/v4/extract-results/batch/{batch_id}",
                            "-H", f"Authorization: Bearer {MINERU_TOKEN}"],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        try:
            j = json.loads(r.stdout)
        except json.JSONDecodeError:
            continue
        items = (j.get("data") or {}).get("extract_result") or []
        states = [it.get("state") for it in items]
        if i % 4 == 0:
            log(f"  MinerU batch poll#{i}: {states}")
        if all(s == "done" for s in states) and states:
            return items, None
        if any(s == "failed" for s in states):
            bad = [it for it in items if it.get("state") == "failed"]
            return None, f"batch 内有失败: {json.dumps(bad, ensure_ascii=False)[:300]}"
    return None, "MinerU batch 轮询超时"


def mineru_zip(full_zip_url, tag):
    zp = os.path.join(TMP, f"mineru_{tag}.zip")
    r = subprocess.run(["curl", "-s", "-m", "600", "-o", zp, full_zip_url],
                       capture_output=True, text=True)
    import zipfile
    z = zipfile.ZipFile(zp)
    return z


def run_mineru_multi(att_key, parts):
    """parts: [(tag, pdf_path)]；一个 batch 提交，逐个下载合并。"""
    files_meta = [{"name": f"{tag}.pdf", "is_ocr": True, "data_id": tag} for tag, _ in parts]
    data, err = mineru_apply(files_meta)
    if err:
        return None, err
    batch_id = data["batch_id"]
    urls = data["file_urls"]
    log(f"  batch_id={batch_id}，上传 {len(parts)} 个分卷...")
    for (tag, pdf_path), url in zip(parts, urls):
        code, resp = mineru_upload(url, pdf_path)
        log(f"  上传 {tag}: HTTP {code}")
        if code != "200":
            return None, f"上传 {tag} 失败 HTTP {code}: {resp}"
    items, err = mineru_poll(batch_id)
    if err:
        return None, err

    merged_md = []
    images = []
    for (tag, _), it in zip(parts, items):
        z = mineru_zip(it["full_zip_url"], tag)
        names = z.namelist()
        md_name = [n for n in names if n.endswith("full.md")][0]
        md = z.read(md_name).decode("utf-8")
        # 图片改名进 images/（防跨分卷碰撞）
        ren = {}
        for n in names:
            m = re.match(r".*/images/([A-Za-z0-9_.-]+\.(?:jpe?g|png|gif|bmp|webp))$", n, re.I)
            if m:
                new = f"{tag[:4]}_{m.group(1)}"
                ren[m.group(1)] = new
                images.append((new, z.read(n)))
        md = IMAGES_RE.sub(lambda m: f"images/{ren.get(m.group(1), m.group(1))}", md)
        merged_md.append(f"\n\n<!-- ZRB 分卷 {tag} -->\n\n" + md)
        log(f"  {tag}: full.md {len(md)} 字符, 图片 {len(ren)}")
    return {"md": "\n".join(merged_md), "images": images}, None


# ---------------- 主流程 ----------------
def main():
    results = {}
    only = sys.argv[1].split(",") if len(sys.argv) > 1 else list(PDFS.keys())

    # --- ZI8SKGJV：损坏 PDF，先试 MinerU 直传 ---
    if "ZI8SKGJV" in only:
        att = "ZI8SKGJV"
        try:
            log("== ZI8SKGJV（损坏 PDF，MinerU 直传尝试）==")
            r = run_mineru_multi(att, [(att[:4], PDFS[att])])
            if r[0] is not None:
                write_cache(att, r[0]["md"], r[0]["images"])
                results[att] = "ok"
            else:
                results[att] = f"失败: {r[1]}"
                log(f"  ✗ {r[1]}")
        except Exception as e:
            results[att] = f"异常: {e}"
            log(f"  ✗ 异常: {e}")

    # --- RDFI7MQ3：589 页书 → MinerU 分 3 卷 ---
    if "RDFI7MQ3" in only:
        att = "RDFI7MQ3"
        try:
            log("== RDFI7MQ3（589 页书 → MinerU 分 3 卷）==")
            src = pymupdf.open(PDFS[att])
            n = src.page_count
            parts = []
            ranges = [(0, 199), (200, 399), (400, n - 1)]
            for i, (a, b) in enumerate(ranges, 1):
                if a > n - 1:
                    break
                part_path = os.path.join(TMP, f"RDFI7MQ3_part{i}.pdf")
                out = pymupdf.open()
                out.insert_pdf(src, from_page=a, to_page=min(b, n - 1))
                out.save(part_path)
                parts.append((f"p{i}", part_path))
                log(f"  分卷 p{i}: 页 {a + 1}-{min(b, n - 1) + 1} ({os.path.getsize(part_path) // 1048576}MB)")
            src.close()
            r = run_mineru_multi(att, parts)
            if r[0] is not None:
                write_cache(att, r[0]["md"], r[0]["images"])
                results[att] = "ok"
            else:
                results[att] = f"失败: {r[1]}"
                log(f"  ✗ {r[1]}")
        except Exception as e:
            results[att] = f"异常: {e}"
            log(f"  ✗ 异常: {e}")

    # --- MJ29YYV8 / PC8AIFN3：OXR（≤300 页内）---
    for att in ("MJ29YYV8", "PC8AIFN3"):
        if att not in only:
            continue
        try:
            log(f"== {att}（OXR）==")
            r = run_oxr(att, PDFS[att])
            if r[0] is not None and r[0]["md"].strip():
                write_cache(att, r[0]["md"], r[0]["images"])
                results[att] = "ok"
            elif r[0] is not None:
                results[att] = "失败: OXR 返回空正文（结构见 tmp/oxr_result_*.json）"
                log(f"  ✗ {results[att]}")
            else:
                results[att] = f"失败: {r[1]}"
                log(f"  ✗ {r[1]}")
        except Exception as e:
            results[att] = f"异常: {e}"
            log(f"  ✗ 异常: {e}")

    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump({"finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "results": results, "log": LOG_LINES}, f, ensure_ascii=False, indent=1)
    log(f"===== 流水线结束：{json.dumps(results, ensure_ascii=False)} =====")


if __name__ == "__main__":
    main()
