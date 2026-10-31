# -*- coding: utf-8 -*-
"""P3 0.2.4 补丁：429 快速失败 + 连续限速中止 + 退避可视化 + 最终一致性 HEAD 重试。"""
import io
import sys

BASE = r"<repo>\src"


def patch(path, pairs):
    p = BASE + "\\" + path.replace("/", "\\")
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            print(f"FAIL: not found in {path}: {old[:70]!r}")
            sys.exit(1)
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched", path)


# ---- s3.ts：429 只试 2 次（5s/15s）快速失败；退避回调；minInterval 1200 ----
patch("src/modules/s3.ts", [
    ('''const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn: () => Promise<S3Response>, tries = 6): Promise<S3Response> {
  let last: S3Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r.status >= 200 && r.status < 300) return r;
    last = r;
    if (r.status === 429) {
      // 网关限速：优先尊重 Retry-After，否则指数退避（5s 起步）
      const ra = r.retryAfter ? parseInt(r.retryAfter, 10) * 1000 : 0;
      await sleep(Math.max(ra, Math.min(5000 * 2 ** i, 120000)));
      continue;
    }
    if (r.status >= 500 || r.status === 0) {
      await sleep(1000 * (i + 1));
      continue;
    }
    return r; // 其余 4xx 不重试
  }
  return last!;
}''',
     '''const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RetryHook = (info: { attempt: number; status: number; waitMs: number }) => void;

async function withRetry(
  fn: () => Promise<S3Response>,
  tries = 3,
  onRetry?: RetryHook,
): Promise<S3Response> {
  let last: S3Response | null = null;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r.status >= 200 && r.status < 300) return r;
    last = r;
    if (r.status === 429) {
      // 网关限速：快速失败策略——只等 5s/15s 两轮，让上层中止本轮并稍后断点续传
      const ra = r.retryAfter ? parseInt(r.retryAfter, 10) * 1000 : 0;
      const wait = Math.max(ra, i === 0 ? 5000 : 15000);
      onRetry?.({ attempt: i + 1, status: r.status, waitMs: wait });
      await sleep(wait);
      continue;
    }
    if (r.status >= 500 || r.status === 0) {
      const wait = 1000 * (i + 1);
      onRetry?.({ attempt: i + 1, status: r.status, waitMs: wait });
      await sleep(wait);
      continue;
    }
    return r; // 其余 4xx 不重试
  }
  return last!;
}'''),
    ('''export async function putObject(
  cfg: S3Config,
  key: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
): Promise<S3Response> {
  const headers = sigv4Headers(cfg, "PUT", key, undefined, body, contentType);
  return withRetry(() =>
    zrequest(cfg, "PUT", objectUrl(cfg, key), withUA(cfg, headers), body),
  );
}''',
     '''export async function putObject(
  cfg: S3Config,
  key: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
  onRetry?: RetryHook,
): Promise<S3Response> {
  const headers = sigv4Headers(cfg, "PUT", key, undefined, body, contentType);
  return withRetry(
    () => zrequest(cfg, "PUT", objectUrl(cfg, key), withUA(cfg, headers), body),
    3,
    onRetry,
  );
}'''),
    ('''export async function headObject(cfg: S3Config, key: string): Promise<S3Response> {
  const headers = sigv4Headers(cfg, "HEAD", key, undefined, new Uint8Array(0));
  return withRetry(() => zrequest(cfg, "HEAD", objectUrl(cfg, key), withUA(cfg, headers)));
}''',
     '''export async function headObject(cfg: S3Config, key: string): Promise<S3Response> {
  const headers = sigv4Headers(cfg, "HEAD", key, undefined, new Uint8Array(0));
  return withRetry(() => zrequest(cfg, "HEAD", objectUrl(cfg, key), withUA(cfg, headers)), 2);
}'''),
    ('  await pace(cfg.minIntervalMs ?? 400);', '  await pace(cfg.minIntervalMs ?? 1200);'),
])

# ---- sync.ts：uploadFile 支持 onRetry；连续 429 中止；HEAD-404 重试 ----
patch("src/modules/sync.ts", [
    ('''  const bytes = await IOUtils.read(path);
  const put = await s3.putObject(cfg, key, bytes, contentType);
  if (put.status < 200 || put.status >= 300) {
    return { ok: false, detail: `PUT ${put.status}${put.error ? " " + put.error : ""}` };
  }
  // 内容级验证：S3 简单 PUT 的 ETag = 内容 MD5（省一次请求，比 HEAD 更强）
  if (put.etag) {
    const local = md5(bytes);
    const remote = put.etag.replace(/"/g, "").toLowerCase();
    if (remote !== local) {
      return { ok: false, detail: `ETag 不一致 本地=${local} 远端=${remote}` };
    }
    return { ok: true, detail: "" };
  }
  const verify = await s3.headObject(cfg, key);
  if (verify.status !== 200) {
    return { ok: false, detail: `HEAD 验证失败 ${verify.status}` };
  }
  if (verify.contentLength !== null && verify.contentLength !== bytes.length) {
    return { ok: false, detail: `长度不一致 本地=${bytes.length} 远端=${verify.contentLength}` };
  }
  return { ok: true, detail: "" };''',
     '''  const bytes = await IOUtils.read(path);
  const put = await s3.putObject(cfg, key, bytes, contentType, (info) =>
    progress?.changeLine({
      text: `${baseLabel} 网关限速，退避 ${Math.round(info.waitMs / 1000)}s（第 ${info.attempt} 次）`,
      progress: progressPct,
    }),
  );
  if (put.status < 200 || put.status >= 300) {
    return { ok: false, detail: `PUT ${put.status}${put.error ? " " + put.error : ""}`, rateLimited: put.status === 429 };
  }
  // 内容级验证：S3 简单 PUT 的 ETag = 内容 MD5（省一次请求，比 HEAD 更强）
  if (put.etag) {
    const local = md5(bytes);
    const remote = put.etag.replace(/"/g, "").toLowerCase();
    if (remote !== local) {
      return { ok: false, detail: `ETag 不一致 本地=${local} 远端=${remote}` };
    }
    return { ok: true, detail: "" };
  }
  // 无 ETag：HEAD 验证（对最终一致性 404 重试 2 次，间隔 2s）
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    const verify = await s3.headObject(cfg, key);
    if (verify.status === 200) {
      if (verify.contentLength !== null && verify.contentLength !== bytes.length) {
        return { ok: false, detail: `长度不一致 本地=${bytes.length} 远端=${verify.contentLength}` };
      }
      return { ok: true, detail: "" };
    }
    if (verify.status !== 404) {
      return { ok: false, detail: `HEAD 验证失败 ${verify.status}` };
    }
  }
  return { ok: false, detail: "PUT 返回成功但对象暂不可见（最终一致性？）" };'''),
    ('''async function uploadFile(
  cfg: s3.S3Config, key: string, path: string, contentType: string,
): Promise<{ ok: boolean; detail: string }> {''',
     '''async function uploadFile(
  cfg: s3.S3Config, key: string, path: string, contentType: string,
  progress?: { changeLine: (o: any) => void },
  baseLabel = "S3 同步",
  progressPct = 0,
): Promise<{ ok: boolean; detail: string; rateLimited?: boolean }> {'''),
])

# ---- sync.ts: syncToS3Inner 主循环改造（连续限速中止 + 进度回调）----
p = BASE + r"\src\modules\sync.ts"
s = io.open(p, encoding="utf-8").read()

old = '''  const report: any = { startedAt: new Date().toISOString(), uploaded: 0, skipped: 0, failed: [] as any[] };
  for (const e of targets) {
    try {'''
new = '''  const report: any = { startedAt: new Date().toISOString(), uploaded: 0, skipped: 0, failed: [] as any[] };
  let consecutiveRateLimit = 0;
  let aborted = false;
  for (const e of targets) {
    try {'''
assert old in s
s = s.replace(old, new)

old = '''    // 1) fulltext.md
    const r1 = await uploadFile(cfg, `${prefix}/fulltext.md`, ftPath, "text/markdown; charset=utf-8");
    if (!r1.ok) err = `fulltext: ${r1.detail}`;'''
new = '''    // 1) fulltext.md
    const r1 = await uploadFile(
      cfg, `${prefix}/fulltext.md`, ftPath, "text/markdown; charset=utf-8",
      progress, `S3 同步 ${e.attachmentKey}`, Math.round(((uploaded + skipped) / Math.max(1, total)) * 100),
    );
    if (!r1.ok) err = `fulltext: ${r1.detail}`;
    if (r1.rateLimited) consecutiveRateLimit++; else consecutiveRateLimit = 0;'''
assert old in s
s = s.replace(old, new)

old = '''    if (err) {
      failed.push(`${e.attachmentKey}: ${err}`);
      ledger.upsert({ attachmentKey: e.attachmentKey, status: "exported", error: err });
      report.failed.push({ key: e.attachmentKey, error: err });
    } else {'''
new = '''    if (err) {
      failed.push(`${e.attachmentKey}: ${err}`);
      ledger.upsert({ attachmentKey: e.attachmentKey, status: "exported", error: err });
      report.failed.push({ key: e.attachmentKey, error: err });
      // 连续 3 个条目都因限速失败 → 本轮终止（进度已逐条保存，稍后重跑续传）
      if (consecutiveRateLimit >= 3) {
        aborted = true;
        await debugLog(`sync abort: 连续限速（429）×${consecutiveRateLimit}，建议 10-30 分钟后重跑`);
        break;
      }
    } else {
      consecutiveRateLimit = 0;'''
assert old in s
s = s.replace(old, new)

old = '''    } else {
      consecutiveRateLimit = 0;
      uploaded++;'''
new = '''    } else {
      consecutiveRateLimit = 0;
      uploaded++;'''
# 已有 else 分支补 0 计数（若上面 replace 没覆盖）
if old not in s:
    old_b = '''    } else {
      uploaded++;'''
    if old_b in s:
        s = s.replace(old_b, new)
        print("patched else-branch counter")

old = '''  report.finishedAt = new Date().toISOString();'''
new = '''  report.finishedAt = new Date().toISOString();
  report.aborted = aborted;'''
assert old in s
s = s.replace(old, new)

old = '''  progress.changeLine({
    text: `S3 同步完成：本次上传 ${uploaded}，跳过 ${skipped}，失败 ${failed.length}；索引 ${rIdx.ok ? "已更新" : "更新失败"}`,
    type: failed.length ? "fail" : "success",
    progress: 100,
  });'''
new = '''  progress.changeLine({
    text: aborted
      ? `网关持续限速，本轮中止（已上传 ${uploaded}，失败 ${failed.length}）。进度已保存，10-30 分钟后重跑即续传`
      : `S3 同步完成：本次上传 ${uploaded}，跳过 ${skipped}，失败 ${failed.length}；索引 ${rIdx.ok ? "已更新" : "更新失败"}`,
    type: failed.length || aborted ? "fail" : "success",
    progress: 100,
  });'''
assert old in s
s = s.replace(old, new)

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("patched src/modules/sync.ts (main loop)")
print("ALL DONE")
