#!/usr/bin/env python3
"""ZoteroResearchBridge P1: MinerU 缓存清点与无损导出工具。

只读访问 Zotero 数据目录（zotero.sqlite 以 immutable 只读模式打开，
绝不写入 Zotero 原始数据）。输出到独立的导出目录，不触碰：
  - Zotero storage/ 目录
  - llm-for-zotero-mineru/ 原缓存（只读取）
  - 云端 /zotero/ WebDAV 空间

用法：
  python migrate_caches.py --zotero-dir "%USERPROFILE%/Zotero" \
      --out "E:/.../ZoteroResearchBridge/export" [--limit N] [--ids 1029,1112] [--report-only]

输出布局（按项目书 §4）：
  export/
  ├── papers/<library-scope>/<parentItemKey>/<sourceAttachmentKey>/
  │   ├── fulltext.md          # 头部题录 + 原文正文（唯一供索引的正文）
  │   ├── metadata.json        # 题录与来源信息（无效值写 null）
  │   ├── manifest.json        # 原解析器数据（有则原样复制）
  │   ├── content_list.json    # 原解析结构（有则原样复制）
  │   └── figures/             # 图片（有则复制，路径重写为相对路径）
  ├── papers-index.jsonl       # 每篇一行的题录索引
  └── reports/inventory.csv    # 全库清点报表
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

LIBRARY_SCOPE_USER = "u1"  # libraryID=1 (user) — 稳定命名空间：u{libraryID}，群组库扩展为 g{libraryID}


@dataclass
class PaperRecord:
    attachment_id: int
    attachment_key: str | None
    parent_item_key: str | None
    library_scope: str
    title: str | None = None
    creators: list = field(default_factory=list)
    year: str | None = None
    doi: str | None = None
    publication: str | None = None
    item_type: str | None = None
    collections: list = field(default_factory=list)
    pdf_filename: str | None = None
    pdf_storage_key: str | None = None
    source_fingerprint: str | None = None      # 源 PDF 的 storageHash 或 SHA-256
    cache_origin: str | None = None            # parsed / restored / zip
    cache_content_hash: str | None = None
    parser: str | None = None
    parse_time: str | None = None
    export_time: str | None = None
    fulltext_sha256: str | None = None
    chunk_count: int = 0
    cloud_relpath: str | None = None
    status: str = "ok"                          # ok / no_cache / no_parent / ambiguous
    notes: list = field(default_factory=list)


class ZoteroReader:
    """只读 Zotero 数据访问层。禁止任何写操作。"""

    def __init__(self, zotero_dir: Path):
        self.dir = zotero_dir
        db = zotero_dir / "zotero.sqlite"
        if not db.is_file():
            raise FileNotFoundError(f"zotero.sqlite not found: {db}")
        # immutable=1: SQLite 不获取锁、不写 journal —— 物理只读
        self.con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro&immutable=1", uri=True)
        self.cur = self.con.cursor()
        self._fields = dict(self.cur.execute("select fieldName, fieldID from fields"))
        self._names = {v: k for k, v in self._fields.items()}
        self._keys = dict(self.cur.execute("select itemID, key from items"))
        self._item_types = dict(self.cur.execute("select itemTypeID, typeName from itemTypes"))

    # ---- 基础查询 -------------------------------------------------
    def item_key(self, item_id: int) -> str | None:
        return self._keys.get(item_id)

    def item_type(self, item_id: int) -> str | None:
        r = self.cur.execute("select itemTypeID from items where itemID=?", (item_id,)).fetchone()
        return self._item_types.get(r[0]) if r else None

    def metadata(self, item_id: int) -> dict:
        d = {}
        for fid, vid in self.cur.execute(
                "select fieldID, valueID from itemData where itemID=?", (item_id,)):
            name = self._names.get(fid)
            if not name:
                continue
            row = self.cur.execute(
                "select value from itemDataValues where valueID=?", (vid,)).fetchone()
            d[name] = row[0] if row else None
        return d

    def creators(self, item_id: int, limit=50) -> list[dict]:
        out = []
        for last, first, ctype in self.cur.execute(
                """select c.lastName, c.firstName, ct.creatorType
                   from itemCreators ic
                   join creators c on ic.creatorID = c.creatorID
                   join creatorTypes ct on ic.creatorTypeID = ct.creatorTypeID
                   where ic.itemID=? order by ic.orderIndex limit ?""",
                (item_id, limit)):
            out.append({"lastName": last, "firstName": first, "creatorType": ctype})
        return out

    def collections_of(self, item_id: int) -> list[str]:
        # collectionName 可能重复，返回父链路径以保持可读性
        out = []
        for (cid,) in self.cur.execute(
                "select collectionID from collectionItems where itemID=?", (item_id,)):
            names = []
            cur_id = cid
            for _ in range(10):  # 防环
                row = self.cur.execute(
                    "select collectionName, parentCollectionID from collections where collectionID=?",
                    (cur_id,)).fetchone()
                if not row:
                    break
                names.append(row[0])
                if row[1] is None:
                    break
                cur_id = row[1]
            out.append("/".join(reversed(names)) if names else f"collection-{cid}")
        return out

    def pdf_attachments(self) -> list[dict]:
        rows = self.cur.execute(
            """select itemID, parentItemID, linkMode, path, storageHash, storageModTime
               from itemAttachments where contentType='application/pdf'""").fetchall()
        out = []
        for item_id, parent, link_mode, path, storage_hash, mtime in rows:
            out.append({
                "itemID": item_id,
                "parentItemID": parent,
                "linkMode": link_mode,
                "path": path,
                "storageHash": storage_hash,
                "storageModTime": mtime,
            })
        return out

    def library_of(self, item_id: int) -> int:
        r = self.cur.execute("select libraryID from items where itemID=?", (item_id,)).fetchone()
        return r[0] if r else 1


# ---- MinerU 缓存读取（独立实现，仅依赖公开缓存格式，不复用 AGPL 代码）----------

CACHE_FILES = {
    "full.md": "full_md",
    "manifest.json": "manifest",
    "content_list.json": "content_list",
    "_llm_source.json": "llm_source",
    "_llm_sync_state.json": "llm_sync_state",
}


def read_cache(cache_dir: Path) -> dict:
    data = {}
    for fname, key in CACHE_FILES.items():
        p = cache_dir / fname
        if p.is_file():
            try:
                if fname.endswith(".json"):
                    data[key] = json.loads(p.read_text(encoding="utf-8"))
                else:
                    data[key] = p.read_text(encoding="utf-8")
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                data[key + "_error"] = str(e)
    img_dir = cache_dir / "images"
    if img_dir.is_dir():
        data["images"] = [f for f in img_dir.iterdir() if f.is_file()]
    return data


def sha256_file(p: Path, chunk=1 << 20) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def extract_year(date_val: str | None) -> str | None:
    if not date_val:
        return None
    m = re.search(r"(1[5-9]\d{2}|20\d{2})", str(date_val))
    return m.group(1) if m else None


FIGURE_REF = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


def rewrite_figure_paths(md_text: str, copied: dict[str, str]) -> tuple[str, int]:
    """把 Markdown 中的图片引用改写为 figures/<新名> 相对路径。仅重写已复制的图。"""
    count = 0

    def sub(m):
        nonlocal count
        alt, target = m.group(1), m.group(2)
        base = target.split("/")[-1].split("?")[0]
        new = copied.get(base)
        if new:
            count += 1
            return f"![{alt}](figures/{new})"
        # 未命中的引用（外链或缺失图）保留原样但记录
        return m.group(0)

    return FIGURE_REF.sub(sub, md_text), count


def build_fulltext(rec: PaperRecord, md_body: str) -> str:
    """生成 fulltext.md：头部题录块 + 分隔线 + 原文正文（不改写科学含义）。"""
    return metadata_block(rec) + "\n---\n\n" + readable_header(rec) + md_body.rstrip() + "\n"


def metadata_block(rec: PaperRecord) -> str:
    head = ["<!-- ZRB-METADATA",
            f"title: {rec.title or ''}"]
    if rec.creators:
        names = ", ".join(
            f"{c.get('lastName','')}{(' ' + c['firstName']) if c.get('firstName') else ''}".strip()
            for c in rec.creators[:10])
        head.append(f"authors: {names}")
    if rec.year:
        head.append(f"year: {rec.year}")
    if rec.doi:
        head.append(f"doi: {rec.doi}")
    if rec.publication:
        head.append(f"publication: {rec.publication}")
    head.append(f"zotero-item: {rec.parent_item_key or ''}")
    head.append(f"zotero-attachment: {rec.attachment_key or ''}")
    head.append(f"library-scope: {rec.library_scope}")
    if rec.source_fingerprint:
        head.append(f"source-fingerprint: {rec.source_fingerprint}")
    head.append("-->")
    return "\n".join(head)


def readable_header(rec: PaperRecord) -> str:
    """供词面搜索使用的可读标题块（索引器可抓到）。"""
    readable = []
    if rec.title:
        readable.append(f"# {rec.title}")
    if rec.creators:
        names = ", ".join(
            f"{c.get('lastName','')}{(' ' + c['firstName']) if c.get('firstName') else ''}".strip()
            for c in rec.creators[:10])
        if names:
            readable.append(f"*{names}*")
    meta_bits = []
    if rec.year:
        meta_bits.append(rec.year)
    if rec.publication:
        meta_bits.append(rec.publication)
    if rec.doi:
        meta_bits.append(f"DOI: {rec.doi}")
    if meta_bits:
        readable.append(" | ".join(meta_bits))
    readable.append("")
    return "\n".join(readable) + "\n"


# ---- 知识库切片（chunking）：知识库对单个 .md 只生成 1 个 chunk（P0 实测），
# 长文整篇进向量索引会被嵌入模型截断，且检索命中一次返回整篇。
# 导出时按标题结构预切分为 ≤ max_chars 的片段，每片段带完整题录头 + 章节路径。----

MD_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


def split_markdown(md_body: str, max_chars: int = 4000) -> list[tuple[str, str]]:
    """按 Markdown 标题切分正文。返回 [(section_path, section_text), ...]。
    标题栈维护章节路径；超限的段按段落再切；段落仍超限则硬切。"""
    sections: list[tuple[list[str], list[str], int]] = []  # (heading_stack, lines, body_chars)
    stack: list[tuple[int, str]] = []  # (level, title)
    cur_lines: list[str] = []
    cur_chars = 0

    def flush():
        nonlocal cur_lines, cur_chars
        path = [t for _, t in stack]
        sections.append((path, cur_lines, cur_chars))
        cur_lines, cur_chars = [], 0

    for line in md_body.split("\n"):
        m = MD_HEADING.match(line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            flush()  # 先用旧栈归档上一节内容，再更新标题栈
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            cur_lines = [line]
            cur_chars = 0
        else:
            cur_lines.append(line)
            cur_chars += len(line)
    flush()

    out: list[tuple[str, str]] = []
    for path, lines, _ in sections:
        text = "\n".join(lines).strip()
        sec_path = " > ".join(path) if path else "(front matter)"
        if not text:
            continue
        if len(text) <= max_chars:
            out.append((sec_path, text))
            continue
        # 按段落组切
        paras = re.split(r"\n\s*\n", text)
        buf: list[str] = []
        buf_len = 0
        for p in paras:
            if len(p) > max_chars:
                # 段落本身超限：先冲掉缓冲，再硬切该段
                if buf:
                    out.append((sec_path, "\n\n".join(buf)))
                    buf, buf_len = [], 0
                for i in range(0, len(p), max_chars):
                    out.append((sec_path, p[i:i + max_chars]))
                continue
            if buf_len + len(p) + 2 > max_chars and buf:
                out.append((sec_path, "\n\n".join(buf)))
                buf, buf_len = [], 0
            buf.append(p)
            buf_len += len(p) + 2
        if buf:
            out.append((sec_path, "\n\n".join(buf)))
    return out


def build_chunks(rec: PaperRecord, md_body: str, max_chars: int = 4000) -> list[tuple[str, str]]:
    """返回 [(filename, content)]。相邻小节打包进同一块直至 max_chars（减少文件数），
    题录全文放第 1 片；每片头部重复精简题录行（title/item/attachment/part/sections），
    保证命中任一片段都能回链；`part idx/n` 串可用于 P4 的"已索引验证"探针。"""
    sections = split_markdown(md_body, max_chars)
    # 打包相邻小节：单片不超过 max_chars（超出则新起一片；单节超限自然成片）
    packed: list[tuple[list[str], list[str]]] = []  # ([section paths], [texts])
    for path, text in sections:
        if packed and sum(len(t) for t in packed[-1][1]) + len(text) + 2 <= max_chars:
            packed[-1][0].append(path)
            packed[-1][1].append(text)
        else:
            packed.append(([path], [text]))
    n = len(packed)
    out = []
    meta_full = metadata_block(rec)
    for idx, (paths, texts) in enumerate(packed, start=1):
        secs = paths[0] if len(paths) == 1 else f"{paths[0]} (+{len(paths) - 1} more)"
        slim = (f"<!-- zrb: {rec.title or ''} | zotero-item: {rec.parent_item_key or ''}"
                f" | zotero-attachment: {rec.attachment_key or ''}"
                f" | part {idx}/{n}"
                + (f" | section: {secs[:120]}" if secs != "(front matter)" else "") + " -->")
        parts = [slim]
        if idx == 1:
            parts += ["", meta_full, "", readable_header(rec).rstrip()]
        parts += ["", "\n\n".join(texts)]
        name = f"part{idx:03d}.md" if n > 1 else "fulltext.md"
        out.append((name, "\n".join(parts)))
    return out



def safe_name(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s)[:120].strip() or "unnamed"


def main():
    ap = argparse.ArgumentParser(description="P1 MinerU cache inventory & lossless export")
    ap.add_argument("--zotero-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0, help="only export first N (0 = all)")
    ap.add_argument("--ids", default="", help="comma-separated attachmentIds to export")
    ap.add_argument("--report-only", action="store_true", help="inventory only, no file export")
    ap.add_argument("--chunk-chars", type=int, default=0,
                    help="pre-split into chunks of <=N chars (0 = one file per paper; "
                         "KB's own 'paper' chunk method handles splitting — recommended)")
    args = ap.parse_args()

    zdir = Path(args.zotero_dir)
    out = Path(args.out)
    cache_root = zdir / "llm-for-zotero-mineru"
    if not cache_root.is_dir():
        print(f"[FATAL] MinerU cache dir not found: {cache_root}", file=sys.stderr)
        sys.exit(2)

    zr = ZoteroReader(zdir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "reports").mkdir(exist_ok=True)
    staging_dir = out / "upload-staging"
    staging_dir.mkdir(exist_ok=True)
    for old in staging_dir.glob("*.md"):
        old.unlink()  # 重建暂存区（仅删本工具自己生成的文件）

    wanted_ids = {int(x) for x in args.ids.split(",") if x.strip().isdigit()} if args.ids else None
    pdfs = zr.pdf_attachments()
    print(f"[info] PDF attachments in Zotero: {len(pdfs)}")

    records: list[PaperRecord] = []
    exported = skipped_no_cache = skipped_no_parent = ambiguous = 0
    multi_pdf_parents: dict[int, int] = {}
    for p in pdfs:
        if p["parentItemID"]:
            multi_pdf_parents[p["parentItemID"]] = multi_pdf_parents.get(p["parentItemID"], 0) + 1

    for p in pdfs:
        item_id = p["itemID"]
        if wanted_ids and item_id not in wanted_ids:
            continue
        parent = p["parentItemID"]
        lib = zr.library_of(item_id)
        rec = PaperRecord(
            attachment_id=item_id,
            attachment_key=zr.item_key(item_id),
            parent_item_key=zr.item_key(parent) if parent else None,
            library_scope=f"u{lib}" if lib == 1 else f"g{lib}",
        )
        # 源 PDF 信息
        if p["path"]:
            rec.pdf_filename = p["path"].replace("storage:", "", 1)
            if p["linkMode"] == 0:
                rec.pdf_storage_key = rec.attachment_key
        rec.source_fingerprint = p["storageHash"] or None
        if parent:
            m = zr.metadata(parent)
            rec.title = m.get("title")
            rec.doi = m.get("DOI") or None
            rec.year = extract_year(m.get("date"))
            rec.publication = m.get("publicationTitle")
            rec.item_type = zr.item_type(parent)
            rec.creators = zr.creators(parent)
            rec.collections = zr.collections_of(parent)
            if multi_pdf_parents.get(parent, 0) > 1:
                rec.status = "ambiguous"
                rec.notes.append("multiple PDF attachments on same parent item")
        else:
            rec.status = "no_parent"
            rec.notes.append("PDF without parent item (standalone attachment)")

        cache_dir = cache_root / str(item_id)
        if not (cache_dir / "full.md").is_file():
            rec.status = "no_cache"
            skipped_no_cache += 1
            records.append(rec)
            continue

        cache = read_cache(cache_dir)
        src = cache.get("llm_source") or {}
        rec.cache_origin = src.get("origin")
        rec.cache_content_hash = src.get("cacheContentHash")
        rec.parser = "mineru" if src.get("kind", "").startswith("llm-for-zotero") else (src.get("kind") or "unknown")
        rec.parse_time = src.get("recordedAt") or src.get("restoredAt")

        # 一致性核验：缓存记录的 attachmentKey/parentItemKey 必须与数据库一致
        if src.get("attachmentKey") and src["attachmentKey"] != rec.attachment_key:
            rec.notes.append(f"cache attachmentKey mismatch: {src['attachmentKey']} != {rec.attachment_key}")
        if src.get("parentItemKey") and rec.parent_item_key and src["parentItemKey"] != rec.parent_item_key:
            rec.notes.append(f"cache parentItemKey mismatch: {src['parentItemKey']} != {rec.parent_item_key}")

        if args.report_only or (args.limit and exported >= args.limit):
            records.append(rec)
            continue

        # ---- 导出 ----
        if rec.status in ("ok", "ambiguous") and rec.parent_item_key:
            dest = out / "papers" / rec.library_scope / rec.parent_item_key / (rec.attachment_key or f"id{item_id}")
        else:
            # no_parent：用附件 key 自身作命名空间，保持可追踪
            dest = out / "papers" / rec.library_scope / "_noparent" / (rec.attachment_key or f"id{item_id}")
        dest.mkdir(parents=True, exist_ok=True)

        # 图片复制 + 路径重写
        copied: dict[str, str] = {}
        for img in cache.get("images", []):
            ext = img.suffix.lower() or ".jpg"
            digest = sha256_file(img)[:16]
            new_name = f"{digest}{ext}"
            (dest / "figures").mkdir(exist_ok=True)
            tgt = dest / "figures" / new_name
            if not tgt.exists():
                shutil.copy2(img, tgt)
            copied[img.name] = new_name
        body, nrewritten = rewrite_figure_paths(cache.get("full_md", ""), copied)
        if cache.get("images") and len(copied) != len(cache.get("images", [])):
            rec.notes.append(f"image name collisions: {len(cache.get('images', []))} -> {len(copied)}")

        # 完整 fulltext.md 始终保留（本机权威副本/对账基准）
        fulltext = build_fulltext(rec, body)
        (dest / "fulltext.md").write_text(fulltext, encoding="utf-8", newline="\n")
        rec.fulltext_sha256 = sha256_file(dest / "fulltext.md")

        # 知识库切片：默认关闭（知识库自带"学术论文 Paper"切片方法，上传整篇即可，
        # 见 docs/cloud-spike.md §7.6）。--chunk-chars N 时按 N 字符预切分作为备选。
        chunkdir = dest / "chunks"
        if chunkdir.is_dir():
            shutil.rmtree(chunkdir)
        if args.chunk_chars > 0:
            chunkdir.mkdir(parents=True)
            chunks = build_chunks(rec, body, max_chars=args.chunk_chars)
            rec.chunk_count = len(chunks)
            for fname, content in chunks:
                (chunkdir / fname).write_text(content, encoding="utf-8", newline="\n")
        else:
            rec.chunk_count = 1
        # 拖拽暂存区：扁平命名 <parentItemKey>__<attachmentKey>__<fname>（一篇一文件）
        staging_name = f"{rec.parent_item_key or rec.attachment_key or item_id}__{rec.attachment_key or ''}__fulltext.md"
        (staging_dir / staging_name).write_text(fulltext, encoding="utf-8", newline="\n")

        # manifest / content_list 原样保留
        for fname in ("manifest.json", "content_list.json"):
            srcf = cache_dir / fname
            if srcf.is_file():
                shutil.copy2(srcf, dest / fname)

        # metadata.json —— 全部题录与来源信息
        meta_obj = asdict(rec)
        meta_obj["parse_source_file"] = str(cache_dir / "full.md")
        meta_obj["export_tool"] = "ZoteroResearchBridge migrate-caches p1"
        (dest / "metadata.json").write_text(
            json.dumps(meta_obj, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")

        rec.cloud_relpath = (dest / "fulltext.md").relative_to(out).as_posix()
        rec.export_time = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        if rec.status == "ok":
            exported += 1
        elif rec.status == "ambiguous":
            exported += 1
            ambiguous += 1
        records.append(rec)

    if rec_status := [r for r in records if r.status == "no_parent"]:
        skipped_no_parent = len(rec_status)

    # papers-index.jsonl
    with open(out / "papers-index.jsonl", "w", encoding="utf-8", newline="\n") as f:
        for r in records:
            if r.status in ("ok", "ambiguous") and r.cloud_relpath:
                f.write(json.dumps(asdict(r), ensure_ascii=False) + "\n")

    # reports/inventory.csv
    cols = ["attachment_id", "attachment_key", "parent_item_key", "library_scope", "status",
            "title", "doi", "year", "publication", "cache_origin", "cache_content_hash",
            "parser", "pdf_filename", "source_fingerprint", "fulltext_sha256", "chunk_count",
            "cloud_relpath", "notes"]
    with open(out / "reports" / "inventory.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in records:
            d = asdict(r)
            w.writerow([d.get(c, "") if c != "notes" else "; ".join(d.get("notes", [])) for c in cols])

    # 汇总报表
    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "zotero_dir": str(zdir),
        "total_pdf_attachments": len(pdfs),
        "processed": len(records),
        "exported_ok": sum(1 for r in records if r.status == "ok"),
        "exported_ambiguous": sum(1 for r in records if r.status == "ambiguous"),
        "no_cache": sum(1 for r in records if r.status == "no_cache"),
        "no_parent": sum(1 for r in records if r.status == "no_parent"),
        "cache_key_mismatches": sum(1 for r in records if any("mismatch" in n for n in r.notes)),
        "parents_with_multiple_pdfs": sum(1 for v in multi_pdf_parents.values() if v > 1),
    }
    (out / "reports" / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
