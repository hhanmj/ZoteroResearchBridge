# 开发踩坑笔记（Lessons Learned）

> 全部来自本项目的真实踩坑（2026-10-30/31），每条含【现象 → 根因 → 解法】。
> 环境背景：Zotero 10.0.6（Gecko 140 ESR）/ Windows 11 / 中国科技云数据胶囊 + 团队知识库。

## 一、Zotero 插件开发

### 1. `Zotero.HTTP.request` 的请求体参数是 `body`，不是 `data` ⭐⭐⭐

- **现象**：S3 PUT"成功"（HTTP 200、对象已创建），但所有对象都是 **0 字节**；本地内容校验（ETag/长度比对）全部失败。
- **根因**：Zotero 7+ 的 `Zotero.HTTP.request(method, url, options)` 只认 **`options.body`**（源码 `chrome/content/zotero/xpcom/http.js`：`body = options.body || null; xmlhttp.send(body)`）。传 `options.data` 会被**静默忽略**——不报错、不警告，直接发出空体请求。
- **解法**：`Zotero.HTTP.request("PUT", url, { body: bytes, ... })`。
- **教训**：第三方运行时的 HTTP 封装必须先读源码（插件场景可直接解包 `app/omni.ja` 查 `xpcom/http.js`），不能凭 fetch/axios 的习惯猜参数名。0 字节成功 + 200 状态码的组合极具迷惑性——**上传类功能必须有内容级回读校验**。

### 2. `successCodes: false` / `timeout` / `responseType` 均受支持

- 同在 `xpcom/http.js`：`@param {Number[]|false} [options.successCodes]`——显式 `false` = 任何状态码都不抛异常（S3 客户端必需，4xx/5xx 自己处理）；`options.timeout` 默认 30000ms；`responseType` 按 XHR 2。
- 另：Zotero 内部有 `_retryOnServerError`，5xx 会自动重试，自己再加 5xx 重试时注意别翻倍。

### 3. 插件沙箱里可以发 Uint8Array 请求体、可以自定义 User-Agent

- `xmlhttp.send(Uint8Array)` 在 Gecko 140 下工作正常（0 字节事故修复后实测字节级一致）。
- `setRequestHeader("User-Agent", ...)` 在特权上下文下生效（本项目靠它满足数据胶囊网关的 UA 绑定，见三-1）。

### 4. 插件设置页（PreferencePanes）

- 注册：`Zotero.PreferencePanes.register({ pluginID, src: rootURI + "content/preferences.xhtml", label, image })`，在 `onStartup` 调用。
- XHTML 里 `preference="xxx"` 相对插件的 prefs 分支（`extensions.zotero.<addonRef>.xxx`），`prefs.js` 里写裸键名 `pref("xxx", default)`，脚手架构建时自动加前缀。
- **坑**：模板的 zh-CN ftl 里标题是中文（"插件模板"），用英文 "Template" 做 replace 匹配不到——多语言文件要分别处理。

### 5. XPI 版本号必须真实递增

- 只改文件名不改 `package.json` 的 `version`，生成的 manifest 版本不变；Zotero 对**同版本号重装**的行为不可靠（可能不替换代码），导致"升级后问题依旧"的假象。
- 教训：每次发版 `package.json` 版本 + XPI 文件名 + manifest 三处一致，装完在插件列表里核对版本号。

## 二、Zotero 数据访问

### 6. `immutable=1` 直读 zotero.sqlite 有 WAL 盲区 ⭐⭐⭐

- **现象**：脚本导出的部分条目缺 `year/DOI/publication`，而另一条链路（Zotero 官方 API）有。
- **根因**：`file:...?mode=ro&immutable=1` 打开的 SQLite **不读 WAL 日志**——Zotero 运行期间的元数据修改（各插件写入）停留在 `-wal` 文件里未 checkpoint，直读看到的是旧快照。
- **解法**：要么关闭 Zotero 后再直读；要么走官方 API（`item.getField(...)`，永远读活数据）；至少要把"WAL 盲区"写进数据口径说明。
- **教训**：对本体的分析脚本（只读、一次性）immutable 很好；但**生产数据链路不要直读运行中的 zotero.sqlite**。

### 7. 数字 attachmentId 不是稳定主键

- `<Zotero>/llm-for-zotero-mineru/<attachmentId>/` 缓存目录用数字 ID，跨设备/重建库后无意义。
- 稳定三元组：`library-scope(u{libraryID}|g{libraryID}) + parentItemKey + attachmentKey`（8 位大写 base32，Zotero 自带）。文件布局、账本、云端对象键全部用 Key，不存数字 ID。

### 8. 导出与同步并发会互相覆写账本

- **现象**：导出 456 个 PDF 跑到一半时点同步 → 同步上传成功，但账本最终全是 `exported`、无 `uploaded` 记录。
- **根因**：导出循环逐条 `upsert(status="exported")`，收尾整体 persist；与同步的 `upsert(status="uploaded")` 交错后，后持久化的一方覆写另一方。
- **解法**：① 模块级忙碌锁（`zrbBusy`，进入 try/finally，重复触发直接提示退出）；② 导出时"已上传且内容指纹未变 → 保持 uploaded"；③ 账本**逐条持久化**（JSON 小文件，开销可忽略），中断也不丢进度。

## 三、中国科技云数据胶囊（S3/MCP）

### 9. S3 网关按 AccessKey 绑定的"应用"校验 User-Agent ⭐⭐⭐

- **现象**：同一把密钥，UA 含 `S3Drive`（创建 Key 时所选应用名）→ 200；UA 为 `aws-sdk-java`/`okhttp`/`curl`/`rclone`/`MinIO`/`Mozilla`/无 UA → **401 空响应体**。
- **实测矩阵**：`S3Drive`、`s3drive`、`X S3Drive Y` 全放行（子串、不分大小写）；其余全拒。GET/PUT/HEAD 一视同仁。
- **解法**：自研客户端把 UA 设为 `<应用名> <自定义后缀>`。
- **连带影响**：任何"服务端代拉"类功能（如知识库的 S3 导入）都会被此门禁拦截——它们的 UA 不可能包含你选的应用名。这解释了"知识库 S3 导入连接数据胶囊恒 401"（已提工单）。
- **诊断技巧**：该网关对**密钥错误 / UA 不符 / 权限不足**一律返回 401 + 空响应体，无法从响应区分——只能用同一密钥换 UA 做对照实验。

### 10. 网关有请求频率限制（429），批量上传必须限速

- **现象**：顺序 PUT 几百个对象后全部 429；重试风暴会延长限制窗口。
- **解法**：① 全局最小间隔（本插件 400ms/请求）；② 429 指数退避（5s 起步，上限 120s，尊重 `Retry-After` 头）；③ 把 4400+ 张图片拆成独立的"慢速通道"菜单，不阻塞正文链路。
- **注意**：429 与 401 不同——429 要退避重试，401 是认证/权限/UA 问题，重试无意义。

### 11. S3 简单 PUT 的 ETag = 内容 MD5 → 免费的内容级校验

- 用 PUT 响应自带的 `ETag`（去引号、小写）与本地 MD5 比对，**省掉一次 HEAD 请求**且是内容级验证（比长度比对强）。纯 JS MD5 实现约 60 行，MD5 与 SHA-256/HMAC 均须对官方库跑测试向量后再上生产。

### 12. 桶名可自定义（datasetId → 人类可读名）

- 控制台改桶名后，S3 层用新名（如 `hhanmj`），MCP/网页视角是同一数据集——密钥文件、插件配置、文档要同步更新，否则出现"我的客户端 401 但 MCP 看得到文件"的错乱。

### 13. MCP（数据胶囊）使用要点

- Streamable HTTP：`initialize` → 捕获 `Mcp-Session-Id` 响应头 → `notifications/initialized` → `tools/call`；不带 session 直接调 tools 会报 "Session ID missing"。
- `save_text` 只写 `.md/.txt`、<5MB、**永不覆盖同名文件**；不能传二进制——只能当降级通道，不是同步主通道。
- `search_file_content` 的内容检索**依赖知识库侧索引**（见四），数据胶囊本身不做向量索引。

## 四、中国科技云团队知识库（kb.cstcloud.cn）

### 14. 知识库 ≠ 数据胶囊：索引发生在知识库产品 ⭐⭐⭐

- 数据胶囊=存储；团队知识库=RAG（解析/切片/向量化/对话）。**数据胶囊的 MCP `search_file_content` 对未关联知识库的空间恒返回 0**——不是因为没索引，而是索引引擎在另一个产品里。

### 15. 知识库 MCP：SSE 传输 + 按库 authkey

- 端点 `https://kb.cstcloud.cn/kbmcp/v1/sse`（GET SSE 拿 endpoint 事件 → POST `/kbmcp/v1/mcp/message?sessionId=...`），Bearer 认证用**按知识库生成**的 MCP 认证密钥（authkey 不适用于知识库 REST API，反过来也不行）。
- 工具 4 个全只读：`search`（RAG，支持 `knowledge_ids/top_k/enable_rerank`）、`get_document_chunks`、`get_knowledge_detail`、`list_knowledges`。
- 实测：中文语义/问句/公式/表格/图注都能命中并回链自定义元数据头；**无关主题 0 命中**（检索有真实区分度）；英文查询需 `enable_rerank:false`（rerank 模型会过滤跨语言相关项）；响应无 score 字段。
- SSE 空闲会超时断连——长会话客户端要处理重连。

### 16. 知识库默认解析对 .md 整篇 1 chunk；"学术论文"切片方法有 API 无 UI

- 默认解析把 23k 字符 md 存成单 chunk。前端已实现"请选择切片方法"（通用/问答/表格/学术论文/书籍/法律）和批量重解析 API（`PUT /api/knowledge/file/{kbId}/documents/reparseDocumentBatch`，body `{fileIdList, chunkMethod:"paper"}`），**但当前版本前端没有任何按钮触发它**（父组件绑定了弹窗，子组件零 emit——半成品功能）。
- 备选：浏览器 console 用页面自身凭证直调 API；或导出侧按章节预切分（工具已内置 `--chunk-chars`）。单 chunk ≤100KB 实测检索可用，超长文尾部召回未验证。

### 17. 把文件送进知识库：普通账号只有"网页拖拽"

- MCP 全只读；REST 上传（`/api/knowledge/file/uploadFiles` 等）只认网页登录 JWT（authkey 四种传法全部 401）；数据胶囊侧的"关联AI团队知识库/推送至知识库"对非 edu/内部账号隐藏（前端可见性由 `email.endsWith("edu.cn") || userCategory==="1"` 控制）。
- 知识库自己的"S3 导入"功能被胶囊网关 UA 门禁拦截（见三-9），属于平台两产品间兼容缺口，工单处理中。
- 结论：**半自动**（插件导出 → 网页拖文件夹）是当前普通实名账号的可用上限；控制台前端逆向（读构建产物里的组件与 API 组装）是确认平台能力的最快路径。

### 18. 前端逆向是摸清平台能力的最快手段

- 官方文档少时，SPA 构建产物（`assets/*.js`）里有全部 API 路径、参数、可见性门槛与业务规则（如 `generateNewKey` 的 `kb:true`、`isInternalOrEduUser` 门槛、`forcePathStyle` 提示）。本项目 80% 的平台行为结论来自逆向 + 最小化实测验证。

## 五、解析资产（MinerU）

### 19. 缓存即资产：377 份 `full.md` 全量复用，零重新解析

- 缓存布局 `<Zotero>/llm-for-zotero-mineru/<attachmentId>/full.md` + `manifest.json`（章节 charStart/charEnd）+ `content_list.json` + `images/` + `_llm_source.json`（来源审计：attachmentKey/parentItemKey/origin）。
- `_llm_source.json` 的 Key 与 zotero.sqlite 100% 一致——迁移前必须做这层一致性核验，别盲信文件名。

### 20. Markdown 头部注入元数据 = 检索回链的关键

- 每篇正文头部注入 `<!-- ZRB-METADATA title/authors/year/doi/zotero-item/zotero-attachment/library-scope -->`——知识库切片检索时原样返回，ZCode 的答案可以直接回链 Zotero 条目。这是"答案→原文→文献管理"闭环的锚点，成本极低收益极大。

### 21. 图片重命名防碰撞 + 防路径穿越

- `images/` 里是 MinerU 输出的哈希名；复制时用内容哈希重命名（去重）+ 白名单扩展名 + 只取 `PathUtils.filename`（防 Zip Slip 类路径注入）。全库 4405 张图重命名后 1032 处引用零断链。

## 六、工程实践

### 22. 状态机：`uploaded ≠ indexed_verified`

- 上传成功只代表存储层落盘；向量索引是否建成要走 MCP 检索验证。两端状态分开记，中间允许长时间停留（人工入库步骤）。

### 23. 幂等设计：对象键 + 内容指纹

- 指纹变了才重传；没变直接跳过。断点恢复=逐条持久化账本。重试要区分 429（退避重试）/4xx（不重试）/5xx（有限重试）。

### 24. 诊断信息落盘，别依赖用户转述

- `sync-report.json`（每次同步的成败明细）+ `zrb-debug.log`（时间线）写进导出目录——远程协作时直接读文件，省掉一轮"你看到了什么"的沟通。

### 25. 对照实验是排障的最后手段，但要控制变量

- 401 三义（密钥/UA/权限）无法从响应区分时，固定密钥换 UA、固定 UA 换密钥，一轮矩阵实验即可定位。**先做完矩阵再下结论**——本项目两次因为"半个实验"的结论让用户白折腾（"关联AI知识库选项"、"Key 权限"）。
