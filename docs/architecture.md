# 架构：四节点串联（Zotero · 解析 · 中国科技云 · ZCode）

> 依据《团队知识库产品实践》(2025-10-17) 与 data.cstcloud.cn / kb.cstcloud.cn 前端逆向。
> 本文件回答"各节点如何连接"，并标注 **P0 探针实测**结果。

## 0. 中国科技云的两个不同产品（关键区分）

| 产品 | 地址 | 职责 | 检索接口 | 认证 |
|---|---|---|---|---|
| **数据胶囊** | `data.cstcloud.cn` | **对象存储**（S3 / WebDAV / 文件） | `data.cstcloud.cn/mcp` 的 `search_file_content` | MCP AccessToken（按数据空间） |
| **团队知识库** | `kb.cstcloud.cn` | **RAG 向量检索 + AI 问答**（文档解析/切片/嵌入/检索/对话） | `kb.cstcloud.cn/api/knowledge/mcp/{kbId}` + 网页 AI 对话 | MCP 认证密钥 authkey（**按知识库**）+ 登录 JWT |

文档原话：*"RAG 承担知识文件的解析与存储，是私有部署的关键"*、*"直接使用云端服务 https://kb.cstcloud.cn/"*、*"文件上传即刻具有智能力"*。
→ **向量索引发生在"团队知识库"，不在"数据胶囊"**。数据胶囊只是存储层。

"数据胶囊 → 知识库"的桥（前端逆向）：
- 数据胶囊侧：`/api/pushKb/pushFileData`（单文件推送）、S3 AccessKey 的 `kb:true`（新文件自动推送）。
- 知识库侧：`系统配置 → 数据胶囊文件推送密钥 (dcSecret)`（平台管理员用，普通用户不碰）。
- 用户侧：`我加入的知识库 → 数据胶囊` 条目 —— 说明你账号下已存在"胶囊↔知识库"的关联视图。

## 1. 目标数据流（四节点）

```
[Zotero 桌面]                [解析引擎]              [中国科技云]                    [ZCode]
 管理本地文献      ──PDF──▶  MinerU(复用/OXR)  ──fulltext.md──▶  ①数据胶囊(存)  ──关联/推送──▶ ②团队知识库(向量索引)  ──MCP──▶ 问答/总结
   Notifier/差量扫描          缓存优先,零重跑        S3 增量同步      pushFileData/kb:true       RAG 检索+回链           kb MCP authkey
```

- **节点1 Zotero**：唯一文献管理入口；插件只采集/解析/规范化/同步/状态管理，不做聊天。
- **节点2 解析**：优先复用 llm-for-zotero 的 MinerU 缓存（P1 已 356 篇无损导出，零重跑），缺失的 4 篇走 OXR/MinerU。
- **节点3 中国科技云**：
  - **数据胶囊 `Research-KB`**（`<datasetId>`）= 冷存储 + 文件真源，S3 增量写入。
  - **团队知识库 `InSAR`** = 检索大脑。Markdown 进入后自动切片+嵌入+可被 `search_file_content` 语义检索。
- **节点4 ZCode**：经知识库 MCP 问答，答案回链到论文标题/DOI/原文段落。

## 2. P0 探针实测结论（2026-10-30）

| 通道 | 实测 |
|---|---|
| 数据胶囊 MCP 读写（save_text/read/list/search-by-name） | ✅ 通，token 有写权限 |
| **数据胶囊 MCP `search_file_content`** | ❌ 新空间写入 30 分钟 0 命中（**因为该数据空间未关联到知识库，胶囊本身不做向量索引**） |
| 团队知识库产品 | 你已开通（InSAR 团队库存在）；其 MCP 端点 `kb.cstcloud.cn/api/knowledge/mcp/{kbId}` 真实存在（应用层 401，需 authkey） |

**修正 P0 判定**：项目书原设想用"数据胶囊 MCP search_file_content"做检索，但实测该检索依赖"胶囊→知识库"关联。你既然有知识库权限，**正确的检索接口应是团队知识库 MCP**，而非数据胶囊 MCP。数据胶囊 MCP 退化为"文件清单/存储校验"用途。

## 3. 需要你完成的节点连接（我负责全部代码与测试）

### 3.1 打通"数据胶囊 → 知识库"（让 Markdown 进入向量索引）
二选一，哪个可用用哪个：
- **(A) 自动**：在数据胶囊 `Research-KB` 空间"客户端访问→S3客户端"，你已建了 AccessKey（截图 AKIA…（已脱敏））。请点该 Key 行的 **"…"** 或页面下方，找 **"关联AI团队知识库"** 按钮（代码里它在**已有 AccessKey 后**才启用，且可能因账号类型隐藏）。若能看到 → 关联到你的 InSAR 库 → 以后 S3 上传的新文件自动进知识库。
- **(B) 手动/批量**：若 (A) 隐藏（普通实名账号无此权限），则**绕过胶囊关联**，改为直接把 `export-full/` 的 Markdown 上传进知识库（知识库支持"文件上传即刻具有智能力"，也可上传整个文件夹）。P2 插件可调用知识库上传接口，或先用网页拖拽验证。

### 3.2 拿到知识库 MCP 认证密钥（给 ZCode 问答用）
在 kb.cstcloud.cn 打开 **InSAR 知识库 → 设置/MCP → 创建新的 MCP 认证密钥**（只需填"密钥名称"，系统自动生成）。把生成的 **authkey** 交给我（放 `~/.zrb-secrets/kb-mcp-authkey.txt`，勿贴对话）。我用它连接 `kb.cstcloud.cn/api/knowledge/mcp/{kbId}` 跑端到端检索。

### 3.3 数据胶囊 S3 密钥（给插件上传用，P2/P3）
把你截图那对 AccessKey 的 **Secret**（点"眼睛"查看）写入 `~/.zrb-secrets/capsule-s3.json`：
```json
{"endpoint":"https://s3.cstcloud.cn","region":"us-east-1","bucket":"<datasetId>","pathStyle":true,"accessKeyId":"AKIA…（已脱敏）","secretAccessKey":"…"}
```
（仓库外，不进 git/日志。）

## 4. 我下一步会做什么（不等你也能推进）
1. **P2 插件骨架**：TypeScript + zotero-plugin-template，监听/差量扫描/任务账本/`export-full` 布局已就绪，先把"选中/全量同步 + 导出缓存"跑通（本地，不依赖云端）。
2. **P0 复测脚本**：写好知识库 MCP 客户端（`kb.cstcloud.cn/api/knowledge/mcp`），你给 authkey + 上传 1 篇测试 md 到 InSAR 库后，我立即验证 `检索→命中→读回→回链` 闭环，正式关闭 P0。
3. 若知识库检索闭环通过 → P3 把 S3 增量同步 + 知识库推送接进插件；P4 端到端验收。

## 5. 风险与备选
- 知识库 MCP 端点/工具名需 authkey 后实测（`tools/list`），当前从前端仅确认路由存在。
- 若知识库不支持 .md 语义检索或配额受限 → 回落 P4 的 RAGFlow 本地方案（你已有 Ollama）。
- 数据胶囊 MCP `search_file_content` 在普通账号下不可依赖（已实测）。
