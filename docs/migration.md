# P1 旧 MinerU 缓存清点与无损迁移报告

**日期：** 2026-10-30（2026-10-31 补充 WAL 盲区说明）
**工具：** `tools/migrate_caches.py`（独立实现，只读访问 Zotero；未复用 llm-for-zotero 任何 AGPL 代码）
**结论：** ✅ **P1 达成**——全库 377 份本地 MinerU 缓存无损导出 356 篇（346 ok + 10 ambiguous），SHA-256 全量核验通过，0 断链图片。

## ⚠️ 2026-10-31 补充：元数据 WAL 盲区（P2 插件比对时发现）

P2 插件（走 Zotero 官方 API）与 P1 脚本（直读 sqlite `immutable=1`）输出比对：正文/图片逐字节一致，但部分条目 P1 缺 `year/DOI/publication`。根因：**`immutable=1` 不读 WAL**，Zotero 运行期间的元数据修改对 P1 不可见。
- **正文与图片不受影响**（MinerU 缓存是独立文件）。
- **处置**：后续以**插件导出为权威**（官方 API 永远读活数据）；如需刷新 `export-full/` 的题录，在**关闭 Zotero 后**重跑 P1 工具，或直接用插件的"导出全库缺失"（先清 ledger 对应条目）。
- P1 报告中的统计（如"321 条 DOI"）按 checkpoint 时的快照计，可能略低于实际。

## 1. 环境清点（P1-1）

| 项 | 值 |
|---|---|
| Zotero | 10.0.6（140.17.0esr 内核），数据目录 `%USERPROFILE%\Zotero`，仅 user 库（libraryID=1） |
| llm-for-zotero | 3.9.15（另有 mineru-for-zotero 0.9.8 并存，共 26 插件） |
| MinerU 本地缓存 | `<Zotero>/llm-for-zotero-mineru/`，377 个 attachmentId 目录，全部含 `full.md`；101 个含 `images/`（共 4405 张图） |
| 缓存来源分布 | `parsed` 101 / `restored` 276（restored = 从 MinerU 同步 ZIP 恢复） |
| Zotero PDF 附件 | 381 个（stored 217 / linked 164），356 有父条目，22 独立附件，5 个条目有多 PDF |
| MinerU 同步 ZIP | Zotero 中 376 个 `LLM-for-Zotero-MinerU-cache-*.zip` 附件，本地 storage 均不存在（未下载，WebDAV 按需拉取）——**未使用**：本地缓存已全量覆盖，无需下载 ZIP |

## 2. 缓存 ↔ Zotero 对应关系核验

- 377/377 缓存目录的 `_llm_source.json` 中 `attachmentKey` 与数据库 `items.key` **100% 一致**（0 mismatch）。
- `libraryID + parentItemKey + sourceAttachmentKey` 三元组全部可重建；数字 attachmentId 仅作过程标识不进入文件布局。
- 同一条目多 PDF（10 个 ambiguous）：按 `sourceAttachmentKey` 分目录保留各自全文，`metadata.json` 中标注 `ambiguous` 待用户决断。

## 3. 导出结果（P1-2 / P1-3）

分批执行：5 篇 → 30 篇 → 全量，每批自动核验（fulltext 存在性、SHA-256、图片引用完整性、metadata 一致性）。

| 指标 | 值 |
|---|---|
| 导出论文（fulltext.md + metadata.json） | 356 |
| 其中 ok / ambiguous | 346 / 10 |
| 复制图片 | 1032 个引用全部命中（4405 个源图 → 哈希去重命名 `figures/<sha16>.jpg`） |
| manifest.json / content_list.json | 有则原样保留 |
| 总大小 | 270 MB（含图片） |
| papers-index.jsonl | 356 行题录索引 |
| reports/inventory.csv + summary.json | 全库对账报表 |

### 布局

```
export-full/papers/u1/<parentItemKey>/<sourceAttachmentKey>/
├── fulltext.md          # <!-- ZRB-METADATA --> 题录头 + 原文（不改写正文）
├── metadata.json        # 题录/来源/指纹/哈希，无效值 null
├── manifest.json        # 原解析器数据（原样）
├── content_list.json    # 原解析结构（原样）
└── figures/<sha16>.jpg  # 内容哈希命名，正文内引用已重写为相对路径
```

`library-scope = u1`（user 库；群组库规则 `g{libraryID}` 已实现，当前无群组库）。

## 4. 未迁移清单（如实记录）

| 类别 | 数量 | 处置 |
|---|---|---|
| no_cache（有 PDF 无缓存） | 4 | `RDFI7MQ3`、`MJ29YYV8`、`PC8AIFN3`、`ZI8SKGJV`（最后一个无父条目）——P3 阶段经用户授权后走 OXR/MinerU 解析 |
| no_parent（独立 PDF 附件） | 21 | 已导出到 `papers/u1/_noparent/<attachmentKey>/`，题录从缺（PDF 文件名保留在 metadata），不臆造元数据 |
| ambiguous（同条目多 PDF） | 10 | 双份均导出，状态标 ambiguous，由用户后续指认主附件 |

## 5. 只读性保证

- `zotero.sqlite` 以 `mode=ro&immutable=1` 打开（SQLite 物理只读，不产生锁/journal）。
- 未写入/移动/删除：`storage/`、`llm-for-zotero-mineru/`、云端 `/zotero/`。
- 全程零解析 API 调用（零费用）。

## 6. 验收对照（项目书 §9 P1）

- ✅ 至少 30 篇原缓存导出正确 → 356 篇全量导出，抽样与全量核验通过
- ✅ Zotero Key/DOI 关联准确 → attachmentKey 100% 一致，Key 三元组可重建
- ✅ 全库清点报表 → `export-full/reports/`
