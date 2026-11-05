# 解析引擎 API 接入说明（OXR / MinerU）

> 插件内置两个引擎（`src/modules/parser.ts`），二选一，设置页填写 Key 即可。
> 本文档为官方 API 规范摘要 + 本插件的适配决策，供后续维护。

## MinerU（推荐首选，与既有缓存同源）

| 项 | 值 |
|---|---|
| 认证 | `Authorization: Bearer <token>`（API 管理页自建） |
| 提交（本地文件） | `POST https://mineru.net/api/v4/file-urls/batch` → 返回 `batch_id` + 预签名 PUT 地址（24h 有效） |
| 上传 | 对预签名地址 `PUT` PDF 字节（≤200MB / ≤200 页 / 批量 ≤50） |
| 轮询 | `GET /api/v4/extract-results/batch/{batch_id}`，状态 `waiting-file/pending/running/converting/done/failed` |
| 结果 | `full_zip_url` → zip 内含 `full.md` + `layout.json` + `*_content_list.json` |
| 参数 | `model_version: vlm`（推荐）、`is_ocr`、`enable_formula/table`、`language: ch` |
| 额度 | 每账号每天 1000 页最高优先级，超出降级 |
| 错误 | A0202 token 错误、A0211 过期、-60005 超 200MB、-60006 页数超限 |

插件实现：`mineruParse()` —— 上传→轮询（10s 间隔，20 分钟超时）→ zip 下载 → nsIZipReader 解包 → `full.md` + images → `zrb-cache/<attachmentId>/`。

## OXR / SoMark

| 项 | 值 |
|---|---|
| 认证 | **请求体字段** `api_key`（`sk-…`），不是 HTTP Header |
| Base | `https://somark.ai/api/v1` |
| 异步提交 | `POST /parse/async`（multipart：`api_key` + `file` 或 `file_url`，二选一）→ `task_id` |
| 轮询 | `POST /parse/async_check`（`api_key` + `task_id`） |
| 同步 | `POST /parse/sync`（小文件直接返回） |
| 余额 | `POST /usage` |
| 限制 | ≤200MB / ≤300 页 / QPS 4；支持 PDF/图片/Office |
| 元素 | 标题、段落、图片、表格、公式、页眉页脚、脚注、参考文献、化学式等 |

⚠️ 旧路径 `/extract/*` 将于 2026-12-31 停用。
⚠️ 结果 JSON 的 markdown 字段名官方页面未明确——插件实现里做了多候选兜底（`markdown / result.markdown / content.markdown`），首次真机解析时会把实际结构写入 `zrb-debug.log`，如未命中需按日志适配（parser.ts 的 OXR 分支）。

## 费用护栏（项目书 §6 要求，已实现）

1. **首次使用确认**：菜单触发后弹确认框（`parseConfirmed` 记忆）
2. **每日上限**：默认跟随服务商免费额度（`parseMaxDaily` 留空 → MinerU ≈50 篇/天、OXR 20 篇/天，见 `parser.ts` 的 `FREE_DAILY_DEFAULT`），跨天自动重置；填数字则显式覆盖
3. **只解析缺缓存的条目**：账本里 `not_parsed` 的才进队列（377 份既有缓存不受影响）
4. **逐条落盘**：解析结果写 `zrb-cache/<attachmentId>/`，随即并入导出/同步管线，中断可恢复

## 流程

```
not_parsed ──插件解析──▶ parsing ──完成──▶ parsed
                                            │
                              导出全库缺失（含 parsed）
                                            ▼
                                  exported → S3 uploaded
```

## 待真机验证

1. OXR 结果 JSON 实际字段名（首次运行打印到 zrb-debug.log）
2. MinerU 预签名 PUT 是否接受 Zotero.HTTP 的 Uint8Array body（S3 实测已验证同类用法可行）
3. OXR 图片导出（当前仅文本；首验后适配）
