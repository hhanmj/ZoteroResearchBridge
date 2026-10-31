# DEPLOYMENT 部署与验收记录

> 本文件不含任何密钥。密钥位置见 §2，自行准备。

## 1. 环境清单（本机实测基准）

| 组件 | 版本/路径 |
|---|---|
| OS | Windows 11 |
| Zotero | 10.0.6（Gecko 140.17 ESR），数据目录 `C:\Users\<user>\Zotero` |
| 既有插件 | llm-for-zotero 3.9.15、mineru-for-zotero 0.9.8 等 26 个（**共存，未卸载**） |
| Python | 3.12（迁移/诊断脚本用） |
| Node.js | 24（插件构建用） |
| Git | Git Bash（Windows） |

## 2. 凭据与密钥（本机存放约定，均不入库）

| 用途 | 位置 | 说明 |
|---|---|---|
| 数据胶囊 S3 | `~/.zrb-secrets/capsule-s3.json` | `{endpoint, region, bucket, pathStyle, accessKeyId, secretAccessKey}`；插件设置页留空时自动读取 |
| 知识库 MCP authkey | `~/.zrb-secrets/kb-mcp-authkey.txt` | 供 ZCode/诊断脚本；插件设置页也可手填 |
| 数据胶囊 MCP token | `~/.zrb-secrets/research-mcp-token.txt` | 只读+save_text |

也可全部改在 Zotero 设置页（编辑→首选项→ZoteroResearchBridge）填写，Secret 存于本机 prefs。

## 3. 构建与安装

```bash
cd src
npm install
npm run build          # 产物 .scaffold/build/zotero-research-bridge.xpi
cp .scaffold/build/*.xpi ../dist/zrb-<version>.xpi
```

安装：Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File → 选 XPI → 重启。
装完在插件列表核对版本号（历史上出现过"文件名升级、包内版本未变导致升级不生效"）。

## 4. 单元/功能测试记录

| 日期 | 测试 | 结果 |
|---|---|---|
| 10-30 | `tests/test_migrate_caches.py`（Key 映射/图片重写/幂等/只读/Zip Slip） | 6/6 通过 |
| 10-30 | P1 全量导出 356 篇 + SHA-256 全量核验 + 图片引用 1032 处 | 0 断链 |
| 10-30 | 知识库检索闭环（30 篇拖拽入库 → MCP search 命中 + 回链） | 30/30 |
| 10-31 | 纯 JS SHA-256/HMAC 对照 Python hashlib | 7/7 通过 |
| 10-31 | SigV4 签名对照已验证的真实客户端（同输入同签名） | 一致 |
| 10-31 | 纯 JS MD5 对照 hashlib（ETag 校验用） | 6/6 通过 |
| 10-31 | 插件导出 vs P1 脚本导出逐字节比对（7 篇抽样） | 正文/图片一致；元数据插件更新（见 docs/migration.md WAL 盲区） |
| 10-31 | 插件真机 S3 上传 | 首版 0 字节 bug（lessons.md 一-1）已修复，重测待网关写封禁解除 |

## 5. 已知限制 / 待办

1. 知识库自动入库通道缺失（平台侧），当前为网页拖拽半自动——工单已起草（docs/support-ticket-draft.md）。
2. 知识库"学术论文"切片方法前端无入口，默认整篇 1 chunk；≤100KB 实测可用，超长文待验证或走 console 直调 API / 预切分。
3. 英文查询需 `enable_rerank:false`。
4. 数据胶囊 S3 网关 UA 绑定导致"知识库 S3 导入"401（平台兼容问题）。
5. 4 篇 PDF 无 MinerU 缓存，待 OXR/MinerU API 接入后解析（涉及费用，先征求用户授权）。
6. `not_parsed` 状态的自动解析、解析费用护栏（并发/日限额）= P3 解析引擎阶段。

## 6. 本机数据流路径速查

```
Zotero 数据目录/
├── llm-for-zotero-mineru/<attachmentId>/   # 既有 MinerU 缓存（只读）
├── zrb-export/papers/<scope>/<parentKey>/<attKey>/
│     ├── fulltext.md  metadata.json  manifest.json  figures/
│     ├── papers-index.jsonl  sync-report.json  zrb-debug.log
├── zrb-upload-staging/<parentKey>__<attKey>__fulltext.md   # 网页拖拽用扁平目录
└── zrb-ledger.json                                          # 任务账本
```

云端对象键 = `papers/<scope>/<parentKey>/<attKey>/...`（与 zrb-export 一一对应）。
