# P0 云端能力探针报告（cloud-spike）

**日期：** 2026-10-30（第三轮：团队知识库 MCP + S3 实测，P0 通过）
**结论：** ✅ **P0 核心闭环成立——但检索发生在"团队知识库"产品（kb.cstcloud.cn），不是"数据胶囊"（data.cstcloud.cn）。**
- 数据胶囊 MCP `search_file_content`：对普通实名账号恒 0（胶囊自身不做向量索引，§1–1.5 记录）。
- 团队知识库 MCP `search`（SSE，`https://kb.cstcloud.cn/kbmcp/v1/sse`）：✅ 命中真实论文、回链 `ZRB-METADATA`（含 zotero-item/attachment Key）、无关主题 0 命中（对照实验通过）。
- 数据胶囊 S3（`s3.cstcloud.cn` / SigV4 / Path-Style）：✅ list/put/get 全通；**但 S3 上传的文件不会自动进入知识库索引**（探针 `ZRB-S3LINK-20261030` 唯一词 0 命中）。
- **待打通**：插件自动把 Markdown 送入知识库的通道（见 §7）。

**执行范围：** 仅只读 Zotero + 两个只读/写 MCP token + 一对 S3 密钥；无删除/覆盖原始数据；无付费解析调用。

## 1. 实测记录

### 1.1 MCP 端点与协议

| 项 | 值 |
|---|---|
| 端点 | `https://data.cstcloud.cn/mcp`（Streamable HTTP, JSON-RPC） |
| 服务端 | `datacapsule-mcp-server` 1.0.0, protocol 2025-03-26 |
| 会话 | 每次需 initialize → 捕获 `Mcp-Session-Id` 响应头 → notifications/initialized → tools/call；无 session 直接调用返回 "Session ID missing" |
| 工具 | `list_files` / `search_file_by_name` / `search_file_content` / `read_file_by_id` / `read_file_lines` / `save_text` 共 6 个 |

### 1.2 逐项验证

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | `list_files` 根目录 | ✅ | 返回 `/zotero` 文件夹（count=1），分页 limit 参数存在 |
| 2 | `save_text` 写入（含 `ZRB-TEST-20261030` 标识） | ✅ | `/zrb-p0-probe.md`（375B, mcpFileId `5f26f8a31c9e418b89012d3171d791e4`）与 `/zrb-p0-probe2.txt` 写入成功；**当前 Token 实际具有 mcp:write 权限**（与此前"仅只读"的预期不符） |
| 3 | `search_file_by_name` | ✅ | 按名查 `zrb-p0-probe` 命中，返回 `parseStatus: "UNKNOWN"` |
| 4 | `read_file_by_id` / `read_file_lines` | ✅ | 读回内容与写入一致（服务器在正文前附加 `文件：…/路径：…` 头部） |
| 5 | `search_file_content` 内容搜索 | ❌ **0 chunks** | 写入后 1/3/7/20+ 分钟分别用唯一词（`landerquark`、`quasarmist`、`ZRB-TEST-20261030`）、普通词（`fox`、`InSAR`）查询均 0 命中；`parseStatus` 始终 `UNKNOWN`。旧 `/zotero/` 内 .zip/.prop 的 parseStatus 为 `None`，此前会话已实测同样无索引 |
| 6 | 索引延迟 | — | 无法测出：索引管线未激活 |

### 1.3 S3 通道（未实测，仅完成情报收集）

| 项 | 值 | 来源 |
|---|---|---|
| Endpoint | `https://s3.cstcloud.cn`（匿名访问 401，SigV4 必需） | 实测 + 官方 UI 字符串 |
| Region / 地址风格 | `us-east-1` / Path-Style | 官方客户端页面提示 + `studynt47/cstcloud-sync` 源码硬编码 |
| 密钥管理 API | `/api/client/generateNewKey`、`getKeyListByUser`、`getSecret`、`renewKey`、`updateAuthorizationOrigin` 等（需网页会话 `user_token`，MCP Token 调用返回"没有权限"） | 控制台前端 JS 逆向 |
| AccessKey 绑定 | 每个数据空间（oi）独立发key；key 绑定"应用"（S3Drive/S3Browser/Rclone/Obsidian/Cherry Studio，WebDAV 有 Zotero 预设）与权限（只读/完全控制），支持 Origin 白名单 | 同上 |
| 桶名 | 用户可自编辑桶名（3-63 位小写规则），即 Bucket = 数据空间绑定桶名 | 同上 |

### 1.4 内容索引的启用机制（关键发现）

通过逆向 data.cstcloud.cn 控制台前端（`Client-Dxezp1x8.js`、`client-B6bwIeHn.js`、`pushKb-FXU6AAuo.js`）确认：

1. **`search_file_content` 的索引不由上传自动触发**。数据空间必须"**关联AI团队知识库**"（kb.cstcloud.cn 产品）。
2. 关联路径有两条：
   - **自动**：创建 S3 AccessKey 时勾选关联（`generateNewKey` 的 `kb: true` 标志）→ "可将胶囊新文件自动推送到AI知识库"；
   - **手动**：文件列表中对单个文件点"推送至知识库"（`/api/pushKb/pushFileData`，且仅当 `isInternalOrEduUser` 为真时菜单可见）。
3. **资格限制**：客户端访问需实名认证；AI 知识库关联功能仅对 `edu.cn` 邮箱或 `userCategory==="1"`（内部/教育用户）开放。
4. MCP 控制台页面明确宣传："使用MCP客户端连接后,支持两种方式搜索本数据空间：search_file_content 智能搜索文件内容、search_file_by_name 按文件名查找文件"——即**索引能力是平台设计内功能**，但依赖上述关联配置。
5. 官方 S3 使用说明文档：https://kb.cstcloud.cn/kb/1923253559269396480 （需登录查看）。

## 2. 失败原因分析

- 当前旧数据空间从未关联 AI 知识库 → 无向量/关键词索引 → `search_file_content` 恒空。
- MCP Token 无 `/api/*` 控制台权限 → 无法程序化创建 Research-KB 空间、发 S3 Key、关联 AI KB。
- 因此 **P0 的"S3 上传 → MCP 搜索"闭环无法在旧空间上完成，也绝不应在旧空间做**（保护性约束）。

## 3. 对架构的影响与决策建议

1. **方案不变，但新增一次必经配置步骤**：用户在 data.cstcloud.cn 控制台创建/选定 `Research-KB` 数据空间后，需：
   - 在"客户端访问"页为该空间**新增 AccessKey 并勾选"关联AI团队知识库"**（这同时解决 S3 上传与自动索引两个问题）；
   - 为该空间**新增 MCP AccessToken**（只读即可），交给 ZCode 作为 `cstcloud-research` 服务器。
2. 插件的同步目标状态机需要增加 `index_pending` 长驻状态：`uploaded` 后轮询 `parseStatus`（UNKNOWN → 解析中/已解析），因为索引是云端异步的。
3. `save_text` 通道（<5MB，无覆盖）可作为 S3 之外的第二写入通道与降级路径，但**不应作为主通道**（不能覆盖、不能传二进制图片）。
4. 若用户账号不满足 edu/内部资格，"自动推送"不可用，则 P0 判定失败，需按项目书 §3.6 评估备选（独立 Markdown + RAGFlow 或更换云端）。

## 4. 待用户操作清单（P0 通过的剩余条件）

1. ~~在 data.cstcloud.cn 控制台确认已创建 `Research-KB` 数据空间~~ ✅ 已完成（datasetId `<datasetId>`）
2. ~~新增 S3 AccessKey~~ ✅ 已完成（应用类型 S3Drive；**"关联AI团队知识库"选项对普通实名账号不显示**，见 §1.5）
3. ~~新增 MCP AccessToken~~ ✅ 已完成（save_text 实测有 mcp:write 权限）
4. **账号资格确认：非 edu.cn 邮箱且 userCategory≠1 → 无"自动推送新文件到AI知识库"资格**（用户实测控制台无此选项，与逆向代码判定一致）

## 1.5 第二轮复测（新 Research-KB 空间，2026-10-30）

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 新空间 `list_files` | ✅ | 根目录空（count=0） |
| 2 | 新空间 `save_text` | ✅ | `/zrb-p0-index-probe.md`（420B，含 `ZRB-TEST-20261030-RESEARCH-KB` 唯一标识） |
| 3 | `read_file_by_id` 读回 | ✅ | 内容一致 |
| 4 | `search_file_by_name` | ✅ | 按名命中，`parseStatus: "UNKNOWN"` |
| 5 | `search_file_content` | ❌ | 写入后 0/1/5/10/17/27+ 分钟，唯一词（`landerquark`）、标识串、英文语义（landslide InSAR kinematics）、中文（滑坡 InSAR 形变监测）查询全部 0 chunks |

### 控制台可见性判定（逆向 `Client-Dxezp1x8.js` 确认）

```
fs（客户端访问总开关）  = edu.cn 邮箱 || (isVerified 实名 && ...)   → 用户可见 ✓
Xe（关联AI团队知识库） = edu.cn 邮箱 || userCategory === "1"        → 用户不可见 ✗
文件级"推送至知识库"菜单 = isInternalOrEduUser                       → 用户不可见 ✗
```

即：**普通实名账号可以使用 S3/MCP/WebDAV 客户端，但被排除在 AI 知识库推送体系之外**。MCP `search_file_content` 的混合检索（向量+关键词）建立在 AI 知识库的解析产物上，因此索引闭环无法达成。

## 5. 测试凭据处理

- 本探针产生的两个测试文件 `/zrb-p0-probe.md`、`/zrb-p0-probe2.txt` 留在旧空间根目录（MCP 无删除工具；位于 `/zotero/` 之外，不影响 Zotero 同步）。如需清理可在网页控制台删除。
- 全程未在日志中输出 Token 原文。

**判定：P0 未通过（索引闭环在当前账号资格下无法达成）。按项目书 §3.6 停止大规模云端同步开发，向用户报告并给出决策建议。P1（本地资产迁移）已完成，不受影响。**

## 6. 决策建议（按项目书 §3.6 要求给出）

云端"上传→索引→搜索→读回"闭环被账号资格卡住，但**本地 Markdown 资产（export-full/，356 篇）已就绪**。三条可行路径：

| 方案 | 说明 | 代价 | 检索能力 |
|---|---|---|---|
| **A. 申请 edu/内部资格** | 联系中国科技云客服/管理员开通 userCategory=1 或使用 edu.cn 邮箱账号，然后按原方案勾选关联AI知识库 | 取决于审批 | 平台原生混合检索（最优） |
| **B. RAGFlow 增强链路** | 项目书预留路径：`export-full/` 喂给本机 RAGFlow（已有 Ollama），ZCode 经 RAGFlow API 检索；云端空间退化为纯备份（S3 上传照做，`uploaded` 即终态，不等待 `indexed_verified`） | 本机算力 | 本机向量+关键词检索 |
| **C. 纯本地检索** | ZCode 直接对 `export-full/papers-index.jsonl` + 全文做 grep/工具检索，不上云 | 零 | 词面检索，无语义 |

**建议：先 C 后 A**——C 零成本立即可用（ZCode 已可直接读本地文件）；A 并行推进，获批后切换到云端闭环并补做 `indexed_verified` 状态机。B 作为 A 长期拿不到时的兜底。

无论选哪条路，P2 插件（采集/解析/规范化/状态管理）架构不变；仅"同步目标与验收状态"需要按决策调整。

## 7. 第三轮实测：团队知识库 MCP + S3 直传（2026-10-30，P0 通过项）

### 7.1 团队知识库 MCP（`https://kb.cstcloud.cn/kbmcp/v1/sse`，SSE 传输，Bearer authkey）

| 验证项 | 结果 |
|---|---|
| 连接/握手 | ✅ SSE endpoint 事件 → POST /kbmcp/v1/mcp/message?sessionId=... |
| 工具 | `search`（RAG 检索，支持 knowledge_ids/top_k/enable_rerank）、`get_document_chunks`、`get_knowledge_detail`、`list_knowledges` —— **全部只读，无上传工具** |
| 语义检索（中文改写/问句/公式/表格/图注 7 组查询） | ✅ 全部命中真实论文，chunk 保留 `ZRB-METADATA`（zotero-item: 3YZ2YTJ7 回链可用） |
| 英文查询 | ⚠️ `enable_rerank=true` 时 0 命中；`rerank=false` 时命中（rerank 模型会过滤跨语言相关项）；建议默认 `rerank=false` 或双通道查询 |
| 对照实验（量子计算/唐诗/财报） | ✅ 0 命中——检索有真实区分度，不是"永远返回 top1" |
| 响应无 score 字段 | 已知限制，排序不可见 |

### 7.2 数据胶囊 S3（`https://s3.cstcloud.cn`，SigV4，Path-Style）

| 验证项 | 结果 |
|---|---|
| ListObjectsV2 / PUT / GET | ✅ 全部 200；`tools/s3_capsule.py`（纯标准库 SigV4，插件 S3 模块原型） |
| **User-Agent 绑定（项目书预言的限制）** | ✅ 确认：AccessKey 按创建时所选"应用"校验 UA —— UA 含 `S3Drive`（不分大小写）放行，`curl/rclone/obsidian/无UA` 全部 401 空响应体 |
| 桶名 | = datasetId（`<datasetId>`），Path-Style `https://s3.cstcloud.cn/<bucket>/<key>` |
| S3 上传 → 胶囊 MCP `list_files` | ✅ 可见（证实"S3 新增文件出现在同一空间 MCP 清单"） |
| **S3 上传 → 知识库索引** | ❌ **不会自动入索引**（探针唯一词 `ZRB-S3LINK-20261030`/`glorpwhistle` 3 分钟后 0 命中）—— 数据胶囊与知识库之间没有普通账号可用的自动推送 |

### 7.3 知识库上传接口现状

- 前端 REST：`POST /api/knowledge/file/uploadFiles`、`POST /api/knowledge/file/{kbId}/{folderId}/uploadFile`、`PUT .../documents/reparseDocument/{id}`（批量重解析）——**只认网页登录 JWT，MCP authkey 返回 401**。
- 结论：**自动入库通道缺失**，当前只能网页拖拽上传（支持文件夹批量）。

### 7.4 切片行为（已解决——知识库自带切片方法）

- 现象：23.7k 字符的单篇 Markdown 被切成 **1 个 chunk**（`get_document_chunks` total=1），检索整篇返回。
- **根因与对策（逆向 `EditDataSet` 前端确认）**：知识库**内置切片方法选择**——"请选择切片方法"对话框提供 通用/Q&A/表格/**学术论文 Paper**/书籍/法律 等方式（"依据论文章节、段落等自然分界进行分片"），并有 `reparseDocument` / `reparseDocumentBatch`（批量重新解析）API。默认解析未按论文结构分片，上传后（或上传时）选"学术论文"方法重解析即可。
- **导出定案**：`export-full/upload-staging/` 一篇一个 `*__fulltext.md`（377 个，28MB），你拖拽上传后对文件选"学术论文"切片方法（可批量）。工具保留 `--chunk-chars N` 预切分作为备选（平台切片效果不佳时启用），默认关闭。
- 注意：网页拖拽一次 377 个文件可能较重，建议按目录分 3-4 次拖；或先试 30 个验证"paper"切片效果再全量。

### 7.5 P0 判定（修订）

✅ **检索闭环成立**：知识库网页上传 → 向量索引 → 知识库 MCP `search` 命中 → 原文回链。
⚠️ **写入闭环未打通**：自动入知识库无 API（胶囊侧关联按钮、kb 侧 REST 均需更高权限/网页会话）。可选项：a) 向平台申请 API 推送权限；b) 接受"半自动"——插件导出到本地目录+胶囊 S3 备份，用户网页拖拽入库；c) 回退 RAGFlow 本地方案做自动链路。
**插件架构定案**：Zotero 采集 → 缓存迁移/解析 → `export-full/` 布局（含预切分）→ S3 增量同步（备份+胶囊 MCP 文件管理）→ 知识库（入库通道待定，检索已验证）。`uploaded ≠ indexed_verified` 仍然成立，索引验证走知识库 MCP。

### 7.6 切片方法与 S3 导入的最终结论（2026-10-30 深夜）

| 项 | 结论 |
|---|---|
| 平台切片方法 UI | **无入口**——前端已实现 `UpdateChunkMethodBatchModal`（通用/问答/表格/学术论文/书籍/法律）且 API（`reparseDocumentBatch`，body `{fileIdList, chunkMethod}`）可用，但当前版本前端没有任何按钮触发它（父组件绑定 `onUpdateChunkMethodBatch:$i`，子组件零 emit 调用）。"更多→批量解析文件"走 `method:"reparse"`（按原方法重解析），单文件"重新解析"传 `{}` |
| 控制台直调 API | 技术可行（浏览器 console 用页面自身凭证 fetch + `chunkMethod:'paper'`），因捕获脚本时机 bug（快照早于 Authorization 头设置）未完成；用户决定停止尝试。后续如需优化：修复版 hook（在请求完成后快照全部头）即可 |
| 知识库 S3 导入 | **确认不可用**——数据胶囊 S3 网关按 AccessKey 绑定的应用校验 User-Agent（仅放行 UA 含应用名的请求，实测矩阵见 §7.2），知识库服务端 UA 无法匹配 → 恒 401。工单文案见 `docs/support-ticket-draft.md`，待平台修复后该通道即通 |
| 验收状态 | **P0 检索闭环成立**（30/30 篇可检索、ZRB-METADATA 回链完整、无关主题 0 命中），入库为网页拖拽半自动；切片为平台默认（.md 整篇 1 chunk），≤100KB 实测检索有效，超长文档尾部召回未验证（已知限制） |

**ZCode 接入**：知识库 MCP（SSE + authkey）已写入 ZCode 全局配置（`cstcloud-kb`，只读 4 工具），下个会话起 ZCode 可原生检索文献库。
