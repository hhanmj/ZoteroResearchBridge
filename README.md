# ZoteroResearchBridge

Zotero 文献解析与中国科技云知识同步插件。一次解析、独立保存、云端全文检索、ZCode 随处问答。

**让 Zotero 管文献、MinerU/OXR 做解析、中国科技云做存储与向量检索、ZCode 做问答。**

## 现状（2026-10-31）

| 阶段 | 状态 |
|---|---|
| P0 云端能力探针 | ✅ 检索闭环成立（知识库 MCP），限制与工单见 docs/cloud-spike.md |
| P1 MinerU 缓存无损迁移 | ✅ 377 份缓存 → 356 篇规范 Markdown（逐字节核验） |
| P2 Zotero 插件 MVP | ✅ 导出/账本/差量扫描，真机验收通过 |
| P3 S3 增量同步 + 解析引擎 | 🔨 S3 模块完成待真机复验；OXR/MinerU 引擎排期中 |
| P4 ZCode MCP 端到端验收 | ⏳ 依赖知识库入库量 |

## 架构（三层资产）

```
Zotero + MinerU 缓存 ──插件导出──▶ 本地暂存（规范 Markdown）
   │                                  │
   │                                  ├─[自动] S3 → 数据胶囊（备份/文件真源）
   │                                  └─[手动] 网页拖拽 → 团队知识库（向量索引）
   ▼
ZCode ←知识库 MCP 检索（答案回链 Zotero 条目 Key）
```

- **数据胶囊**只做存储，不做向量索引
- **团队知识库**（kb.cstcloud.cn）是 RAG 检索大脑，文件上传即自动解析切片
- 两者通过"关联AI团队知识库"打通（该功能当前对普通实名账号有资格门槛，见 docs/cloud-spike.md）

## 快速开始

### 离线迁移（复用既有 MinerU 缓存，零 API 费用）

```bash
python tools/migrate_caches.py --zotero-dir "C:/Users/<user>/Zotero" --out ./export-full
python tests/test_migrate_caches.py
```

### 插件

```bash
cd src && npm install && npm run build
# 产物 .scaffold/build/zotero-research-bridge.xpi → Zotero 安装
```

功能菜单（工具菜单）：导出选中 / 导出全库缺失 / 同步到中国科技云 S3（增量）/ 同步图片 / 账本状态。

### ZCode 问答接入

知识库 MCP（SSE）配置样例见 docs/architecture.md §3；authkey 从 kb.cstcloud.cn 知识库设置页生成。

## 目录

```
├── src/           # Zotero 插件（TypeScript，基于 zotero-plugin-template）
├── tools/         # migrate_caches.py（P1 迁移）、s3_capsule.py、kb_mcp_client.py
├── tests/         # 单元测试
├── docs/          # cloud-spike / architecture / migration / lessons（踩坑笔记）
├── dist/          # 可安装 XPI
├── DEPLOYMENT.md  # 环境、路径、验收记录（无密钥）
└── LICENSE        # AGPL-3.0-or-later
```

## 文档索引

- [DEPLOYMENT.md](DEPLOYMENT.md) — 环境与验收记录
- [docs/lessons.md](docs/lessons.md) — **开发踩坑笔记**（25 条，含复现与解法）
- [docs/cloud-spike.md](docs/cloud-spike.md) — 中国科技云两产品（数据胶囊 vs 知识库）能力实测
- [docs/architecture.md](docs/architecture.md) — 四节点串联架构
- [docs/migration.md](docs/migration.md) — P1 迁移报告 + sqlite WAL 盲区

## 安全约定

密钥只存本机（`~/.zrb-secrets/` 或插件设置页），不入库不入日志；`export-full/`（论文版权数据）已 gitignore，仅存本机。

## 许可

AGPL-3.0-or-later（插件基于 [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 搭建，其许可为 AGPL-3.0）。`tools/migrate_caches.py` 为独立实现，未复用 llm-for-zotero（AGPL-3.0）代码。
