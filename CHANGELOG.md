# Changelog

## 0.2.3 (2026-10-31)

- fix: `Zotero.HTTP.request` 请求体参数改用 `options.body`（此前 `options.data` 被静默忽略 → S3 对象 0 字节）
- feat: 同步异常可视化（弹窗）+ `zrb-debug.log` 诊断日志 + `sync-report.json` 明细
- fix: `resolveS3Config` 主目录查找加固（Services 异常不再中断同步）
- fix: package.json 版本号与 manifest 一致递增（此前 0.2.x 的包内版本仍是 0.1.0，可能导致升级未生效）

## 0.2.2 (2026-10-31)

- feat: S3 全局限速（默认 400ms/请求）+ 429 指数退避（尊重 Retry-After）
- feat: ETag 内容校验（PUT 响应 ETag = MD5，替代 HEAD 长度比对，请求量减半）
- feat: 图片同步独立菜单（默认延后，避免触发网关限速）
- feat: 导出/同步互斥锁；导出不再重置已上传状态（指纹未变时）

## 0.2.1 (2026-10-31)

- fix: zh-CN 设置页标题
- feat: 账本逐条持久化（进度不丢）

## 0.2.0 (2026-10-31)

- feat: S3 SigV4 客户端（纯 JS SHA-256/HMAC，UA 绑定适配）+ 增量同步 + papers-index.jsonl
- feat: 设置页（S3 配置、暂存目录、密钥文件回退）

## 0.1.0 (2026-10-31)

- feat: 插件 MVP——工具菜单（导出选中/全库缺失/账本状态）、Notifier 差量扫描、任务账本
- feat: MinerU 缓存导出（题录头注入、图片哈希重命名、相对路径重写）
