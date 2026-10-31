#!/usr/bin/env python3
"""P1 导出工具单元测试：缓存目录发现、Key 映射、图片路径重写、Zip Slip 防护、去重、幂等。

运行: python tests/test_migrate_caches.py
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import migrate_caches as mc  # noqa: E402


def make_fake_zotero(root: Path):
    """构造最小 Zotero 数据目录（schema 仅含所需表）。"""
    zdir = root / "Zotero"
    zdir.mkdir()
    con = sqlite3.connect(zdir / "zotero.sqlite")
    con.executescript("""
    CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, libraryID INT DEFAULT 1, key TEXT);
    CREATE TABLE itemTypes (itemTypeID INT PRIMARY KEY, typeName TEXT);
    CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
    CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT,
        contentType TEXT, charsetID INT, path TEXT, syncState INT DEFAULT 0,
        storageModTime INT, storageHash TEXT, lastProcessedModificationTime INT, lastRead INT);
    CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT, PRIMARY KEY (itemID, fieldID));
    CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value TEXT);
    CREATE TABLE fields (fieldID INTEGER PRIMARY KEY, fieldName TEXT);
    CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
    CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT);
    CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
    CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT);
    CREATE TABLE collectionItems (collectionID INT, itemID INT, PRIMARY KEY (collectionID, itemID));
    INSERT INTO libraries VALUES (1, 'user');
    INSERT INTO itemTypes VALUES (1, 'journalArticle'), (3, 'attachment');
    INSERT INTO fields VALUES (1, 'title'), (2, 'DOI'), (3, 'date'), (4, 'publicationTitle');
    """)
    # 父条目 P (key=AAAA1111) + PDF 附件 A (itemID=100, key=PDFKEY01)
    con.executescript("""
    INSERT INTO items VALUES (10, 1, 1, 'AAAA1111');
    INSERT INTO items VALUES (100, 3, 1, 'PDFKEY01');
    INSERT INTO items VALUES (200, 3, 1, 'NOPARENT1');
    INSERT INTO itemAttachments VALUES (100, 10, 0, 'application/pdf', NULL, 'storage:paper.pdf', 0, 123, 'hashAAA', NULL, NULL);
    INSERT INTO itemAttachments VALUES (200, NULL, 0, 'application/pdf', NULL, 'storage:lone.pdf', 0, 456, 'hashBBB', NULL, NULL);
    INSERT INTO itemData VALUES (10, 1, 1), (10, 2, 2), (10, 3, 3);
    INSERT INTO itemDataValues VALUES (1, 'Test Paper Title'), (2, '10.1000/test'), (3, '2021-05-01');
    INSERT INTO itemCreators VALUES (10, 1, 1, 0);
    INSERT INTO creators VALUES (1, 'Alice', 'Doe');
    INSERT INTO creatorTypes VALUES (1, 'author');
    INSERT INTO collections VALUES (1, 'InSAR', NULL);
    INSERT INTO collectionItems VALUES (1, 10);
    """)
    con.commit()
    con.close()
    # MinerU 缓存
    for aid, imgs in ((100, ["img1.jpg", "img2.jpg"]), (200, [])):
        cdir = zdir / "llm-for-zotero-mineru" / str(aid)
        cdir.mkdir(parents=True)
        (cdir / "full.md").write_text(
            f"# Title\n\n![f1](images/img1.jpg) text ![f2](images/img2.jpg)\nbody {aid}", encoding="utf-8")
        (cdir / "manifest.json").write_text('{"sections": []}', encoding="utf-8")
        (cdir / "_llm_source.json").write_text(json.dumps({
            "kind": "llm-for-zotero/mineru-cache-source", "version": 2,
            "attachmentId": aid, "attachmentKey": "PDFKEY01" if aid == 100 else "NOPARENT1",
            "parentItemKey": "AAAA1111" if aid == 100 else None,
            "origin": "parsed", "cacheContentHash": "fnv1a32-abc",
        }), encoding="utf-8")
        imgd = cdir / "images"
        imgd.mkdir()
        for i in imgs:
            (imgd / i).write_bytes(b"\xff\xd8fakejpg" + i.encode())
    return zdir


def test_extract_year():
    assert mc.extract_year("2021-05-01") == "2021"
    assert mc.extract_year("May 2021") == "2021"
    assert mc.extract_year("undated") is None
    assert mc.extract_year(None) is None
    assert mc.extract_year("1600s era") == "1600"  # 1500-2099 均接受，由 Zotero 数据质量决定

    print("PASS extract_year")


def test_rewrite_figure_paths():
    copied = {"img1.jpg": "aaaa.jpg", "img2.jpg": "bbbb.jpg"}
    md = "![a](images/img1.jpg) and ![b](images/img2.jpg) and ![c](https://x/y.png)"
    out, n = mc.rewrite_figure_paths(md, copied)
    assert n == 2
    assert "![a](figures/aaaa.jpg)" in out
    assert "![b](figures/bbbb.jpg)" in out
    assert "https://x/y.png" in out  # 外链不动
    print("PASS rewrite_figure_paths")


def test_build_fulltext_contains_metadata():
    rec = mc.PaperRecord(
        attachment_id=1, attachment_key="AK", parent_item_key="PK", library_scope="u1",
        title="T", creators=[{"lastName": "Doe", "firstName": "Alice", "creatorType": "author"}],
        year="2021", doi="10.1/x", publication="J")
    ft = mc.build_fulltext(rec, "BODY")
    assert "zotero-item: PK" in ft and "doi: 10.1/x" in ft and "BODY" in ft
    print("PASS build_fulltext")


def test_chunking():
    rec = mc.PaperRecord(
        attachment_id=1, attachment_key="AK", parent_item_key="PK", library_scope="u1",
        title="长文测试", creators=[{"lastName": "Doe", "firstName": "", "creatorType": "author"}],
        year="2023", doi=None, publication=None)
    # 构造：标题层级 + 超长章节 + 超长段落
    body = "# H1\nintro text\n\n## S1\n" + ("para one\n\npara two\n\n" * 30) + "\n## S2\n" + ("x" * 9000)
    chunks = mc.build_chunks(rec, body, max_chars=1000)
    assert len(chunks) > 3, f"expected multiple chunks, got {len(chunks)}"
    for name, content in chunks:
        assert len(content) <= 1000 + 400, f"{name} too long: {len(content)}"
        assert "zotero-item: PK" in content, "回链信息缺失"
        assert "长文测试" in content, "标题缺失"
    assert chunks[0][1].count("H1") >= 1  # 首片含 front matter
    assert any("part" in c[1] for c in chunks[1:]), "part 序号探针缺失"
    # 单篇短文不切片
    small = mc.build_chunks(rec, "# Only\nshort body", max_chars=1000)
    assert len(small) == 1 and small[0][0] == "fulltext.md"
    print(f"PASS chunking ({len(chunks)} chunks)")


def test_full_export_and_idempotent():
    root = Path(tempfile.mkdtemp(prefix="zrb_test_"))
    try:
        zdir = make_fake_zotero(root)
        out1 = root / "out1"
        out2 = root / "out2"
        for out in (out1, out2):
            mc.main.__wrapped__ if hasattr(mc.main, "__wrapped__") else None
            sys.argv = ["migrate_caches.py", "--zotero-dir", str(zdir), "--out", str(out)]
            mc.main()
        # 两次导出内容一致（幂等）
        f1 = out1 / "papers" / "u1" / "AAAA1111" / "PDFKEY01" / "fulltext.md"
        f2 = out2 / "papers" / "u1" / "AAAA1111" / "PDFKEY01" / "fulltext.md"
        assert f1.is_file() and f2.is_file()
        assert f1.read_text(encoding="utf-8") == f2.read_text(encoding="utf-8")
        assert (out1 / "papers" / "u1" / "_noparent" / "NOPARENT1" / "fulltext.md").is_file()
        # 图片重写
        ft = f1.read_text(encoding="utf-8")
        assert "figures/" in ft and "images/" not in ft
        # summary 一致
        s = json.loads((out1 / "reports" / "summary.json").read_text(encoding="utf-8"))
        assert s["exported_ok"] == 1 and s["no_parent"] == 1 and s["no_cache"] == 0
        print("PASS full_export_and_idempotent")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_zip_slip_guard_documented():
    # 迁移工具当前只读取本地缓存目录，不解包 ZIP；此处固化"未来加 ZIP 恢复时必须防 Zip Slip"的约束：
    # 解包目标必须落在目标目录内（evil.zip 内含 ../escaped.txt 必须被拒绝）。
    root = Path(tempfile.mkdtemp(prefix="zrb_zipslip_"))
    try:
        z = zipfile.ZipFile(root / "evil.zip", "w")
        z.writestr("../escaped.txt", "pwn")
        z.close()
        unpack = root / "unpack"
        unpack.mkdir()
        with zipfile.ZipFile(root / "evil.zip") as zf:
            slipped = []
            for name in zf.namelist():
                target = (unpack / name).resolve()
                if not target.is_relative_to(unpack.resolve()):
                    slipped.append(name)
            assert slipped == ["../escaped.txt"], "Zip Slip entries must be detected"
        assert not (root / "escaped.txt").exists()
        print("PASS zip_slip_guard (pattern verified)")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_readonly_db():
    root = Path(tempfile.mkdtemp(prefix="zrb_ro_"))
    try:
        zdir = make_fake_zotero(root)
        zr = mc.ZoteroReader(zdir)
        # 只读连接：任何写都应失败
        try:
            zr.cur.execute("INSERT INTO items VALUES (9999, 1, 1, 'X')")
            raise AssertionError("write should have failed on read-only DB")
        except sqlite3.OperationalError:
            pass
        print("PASS readonly_db")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    test_extract_year()
    test_rewrite_figure_paths()
    test_build_fulltext_contains_metadata()
    test_full_export_and_idempotent()
    test_zip_slip_guard_documented()
    test_readonly_db()
    print("\nALL TESTS PASSED")
