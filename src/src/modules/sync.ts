// P3 增量同步编排：本地 zrb-export → 数据胶囊 S3
// 幂等：对象键 + 内容指纹；uploaded 且指纹未变则跳过
// 验证：PUT 成功后 HEAD 比对 Content-Length（uploaded ≠ indexed_verified，后者在 P4 用 MCP 验证）

import { config } from "../../package.json";
import * as ledger from "./ledger";
import * as s3 from "./s3";
import { digestHex } from "./exporter";
import { md5 } from "./md5";

export function exportRoot(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, "zrb-export");
}

export async function resolveS3Config(): Promise<s3.S3Config | null> {
  const get = (n: string, d = ""): string => {
    try {
      return ((Zotero.Prefs.get(`extensions.zotero.${config.addonRef}.${n}`, true) as string) || d);
    } catch (_) {
      return d;
    }
  };
  let endpoint = get("s3Endpoint");
  let region = get("s3Region", "us-east-1");
  let bucket = get("s3Bucket");
  let accessKeyId = get("s3AccessKey");
  let secretAccessKey = get("s3Secret");
  const uaApp = get("uaApp", "S3Drive");
  const secretFile = get("s3SecretFile");
  if (!bucket || !accessKeyId || !secretAccessKey) {
    let home: string | null = null;
    try {
      home = (globalThis as any).Services?.dirsvc?.get("Home", (globalThis as any).Ci?.nsIFile)?.path ?? null;
    } catch (_) { home = null; }
    const candidates = [
      ...(secretFile ? [secretFile] : []),
      ...(home ? [PathUtils.join(home, ".zrb-secrets", "capsule-s3.json")] : []),
    ];
    for (const p of candidates) {
      try {
        if (await IOUtils.exists(p)) {
          const j = JSON.parse(await IOUtils.readUTF8(p));
          endpoint = endpoint || j.endpoint || "";
          region = region || j.region || "us-east-1";
          bucket = bucket || j.bucket || "";
          accessKeyId = accessKeyId || j.accessKeyId || "";
          secretAccessKey = secretAccessKey || j.secretAccessKey || "";
          break;
        }
      } catch (_) { /* 密钥文件不可读则跳过 */ }
    }
  }
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, region, bucket, accessKeyId, secretAccessKey, pathStyle: true, uaApp };
}

function getBoolPref(name: string): boolean {
  try {
    return (Zotero.Prefs.get(`extensions.zotero.${config.addonRef}.${name}`, true) as boolean) === true;
  } catch (_) {
    return false;
  }
}

function paperDirOf(e: ledger.LedgerEntry): string {
  return PathUtils.join(
    exportRoot(), "papers", e.libraryScope, e.parentItemKey || "_noparent", e.attachmentKey,
  );
}

function s3PrefixOf(e: ledger.LedgerEntry): string {
  return `papers/${e.libraryScope}/${e.parentItemKey || "_noparent"}/${e.attachmentKey}`;
}

function zoteroSelectUrl(e: ledger.LedgerEntry): string {
  return e.parentItemKey
    ? `zotero://select/library/items/${e.parentItemKey}`
    : `zotero://select/library/items/${e.attachmentKey}`;
}

async function buildMetadata(e: ledger.LedgerEntry, att: Zotero.Item | null): Promise<string> {
  let pdfFilename: string | null = null;
  try {
    if (att) pdfFilename = att.attachmentFilename || null;
  } catch (_) { /* linked 附件可能无文件名 */ }
  const meta = {
    generator: `${config.addonName} 0.1.0`,
    library_scope: e.libraryScope,
    parent_item_key: e.parentItemKey,
    source_attachment_key: e.attachmentKey,
    title: e.title ?? null,
    authors: null,
    year: e.year ?? null,
    doi: e.doi ?? null,
    zotero_select_url: zoteroSelectUrl(e),
    pdf_filename: pdfFilename,
    source_fingerprint: e.cacheContentHash ?? null,
    parser: e.cacheOrigin ? `mineru (llm-for-zotero cache, origin=${e.cacheOrigin})` : null,
    parse_time: null,
    upload_time: new Date().toISOString(),
    content_fingerprint: e.contentFingerprint
      ? { algo: e.contentFingerprint!.startsWith("fnv2-") ? "fnv1a32-x2" : "sha256", value: e.contentFingerprint }
      : null,
    cloud_relpath: `${s3PrefixOf(e)}/fulltext.md`,
  };
  return JSON.stringify(meta, null, 1);
}

async function listFigureFiles(dir: string): Promise<string[]> {
  try {
    if (await IOUtils.exists(dir)) {
      const all = await IOUtils.getChildren(dir);
      return all.filter((p: string) => /\.(jpe?g|png|gif|bmp|webp|svg|tiff?)$/i.test(p));
    }
  } catch (_) { /* 目录缺失 */ }
  return [];
}

async function uploadFile(
  cfg: s3.S3Config, key: string, path: string, contentType: string,
  progress?: { changeLine: (o: any) => void },
  baseLabel = "S3 同步",
  progressPct = 0,
): Promise<{ ok: boolean; detail: string; rateLimited?: boolean }> {
  const bytes = await IOUtils.read(path);
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
  return { ok: false, detail: "PUT 返回成功但对象暂不可见（最终一致性？）" };
}

export async function debugLog(msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}
`;
  Zotero.debug(`[zrb] ${msg}`);
  try {
    const p = PathUtils.join(exportRoot(), "zrb-debug.log");
    const prev = (await IOUtils.exists(p)) ? await IOUtils.readUTF8(p) : "";
    await IOUtils.writeUTF8(p, prev + line);
  } catch (_) { /* 日志失败不影响主流程 */ }
}

export async function syncToS3(): Promise<void> {
  const d = addon.data as any;
  if (d.zrbBusy) {
    const pw = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true });
    pw.createLine({ text: "ZRB 已有任务在运行，请等其完成", type: "fail", progress: 100 });
    pw.show();
    pw.startCloseTimer(6000);
    await debugLog("sync: busy, skip");
    return;
  }
  d.zrbBusy = true;
  try {
    await syncToS3Inner();
  } catch (e: any) {
    const msg = `同步异常：${e?.message || e}${e?.stack ? " | " + String(e.stack).slice(0, 300) : ""}`;
    Zotero.logError(e);
    await debugLog(`sync FATAL: ${msg}`);
    const pw = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true });
    pw.createLine({ text: msg.slice(0, 200), type: "fail", progress: 100 });
    pw.show();
    pw.startCloseTimer(15000);
  } finally {
    d.zrbBusy = false;
  }
}

async function syncToS3Inner(): Promise<void> {
  await ledger.load();
  const cfg = await resolveS3Config();
  await debugLog(`sync start: config ${cfg ? "resolved (bucket=" + cfg.bucket + ", ak=" + cfg.accessKeyId.slice(0, 6) + "...)" : "MISSING"}`);
  const progress = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: false })
    .createLine({ text: "ZRB S3 同步", type: "default", progress: 0 })
    .show();
  if (!cfg) {
    progress.changeLine({
      text: "未配置 S3：请在设置页填写，或放置 ~/.zrb-secrets/capsule-s3.json",
      type: "fail",
      progress: 100,
    });
    progress.startCloseTimer(15000);
    await debugLog("sync abort: no config");
    return;
  }
  const ping = await s3.ping(cfg);
  await debugLog(`sync ping: ${ping.ok ? "ok" : ping.detail}`);
  if (!ping.ok) {
    progress.changeLine({ text: `S3 连接失败：${ping.detail}`, type: "fail", progress: 100 });
    progress.startCloseTimer(15000);
    return;
  }

  const entries = Object.values(ledger.get().entries);
  const targets = entries.filter(
    (e) => e.status === "exported" || e.status === "queued_upload" || e.status === "uploaded",
  );
  const total = targets.length;
  let uploaded = 0;
  let skipped = 0;
  const failed: string[] = [];

  const report: any = { startedAt: new Date().toISOString(), uploaded: 0, skipped: 0, failed: [] as any[] };
  let consecutiveRateLimit = 0;
  let aborted = false;
  for (const e of targets) {
    try {
    const dir = paperDirOf(e);
    const ftPath = PathUtils.join(dir, "fulltext.md");
    if (!(await IOUtils.exists(ftPath))) {
      skipped++;
      continue;
    }
    // 幂等：已上传且指纹未变 → 跳过
    if (e.status === "uploaded" && e.contentFingerprint) {
      const cur = await digestHex(await IOUtils.readUTF8(ftPath));
      if (cur === e.contentFingerprint) {
        skipped++;
        continue;
      }
    }
    const prefix = s3PrefixOf(e);
    let err: string | null = null;

    // 1) fulltext.md
    const r1 = await uploadFile(
      cfg, `${prefix}/fulltext.md`, ftPath, "text/markdown; charset=utf-8",
      progress, `S3 同步 ${e.attachmentKey}`, Math.round(((uploaded + skipped) / Math.max(1, total)) * 100),
    );
    if (!r1.ok) err = `fulltext: ${r1.detail}`;
    if (r1.rateLimited) consecutiveRateLimit++; else consecutiveRateLimit = 0;

    // 2) metadata.json
    if (!err) {
      let att: Zotero.Item | null = null;
      try {
        att = e.attachmentId ? Zotero.Items.get(e.attachmentId) : null;
      } catch (_) { /* ignore */ }
      const metaPath = PathUtils.join(dir, "metadata.json");
      await IOUtils.writeUTF8(metaPath, await buildMetadata(e, att));
      const r2 = await uploadFile(cfg, `${prefix}/metadata.json`, metaPath, "application/json");
      if (!r2.ok) err = `metadata: ${r2.detail}`;
    }

    // 3) manifest.json（原样）
    if (!err) {
      const mfPath = PathUtils.join(dir, "manifest.json");
      if (await IOUtils.exists(mfPath)) {
        const r3 = await uploadFile(cfg, `${prefix}/manifest.json`, mfPath, "application/json");
        if (!r3.ok) err = `manifest: ${r3.detail}`;
      }
    }

    // 4) figures：默认延后（数量大易触限速），用"同步图片文件"单独跑
    if (!err && getBoolPref("figuresSync") && !e.figuresUploaded) {
      const figDir = PathUtils.join(dir, "figures");
      const figs = await listFigureFiles(figDir);
      for (const f of figs) {
        const rf = await uploadFile(
          cfg, `${prefix}/figures/${PathUtils.filename(f)}`, f,
          "application/octet-stream",
        );
        if (!rf.ok) {
          err = `figures: ${rf.detail}`;
          break;
        }
      }
    }

    if (err) {
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
      consecutiveRateLimit = 0;
      uploaded++;
      report.uploaded++;
      ledger.upsert({
        attachmentKey: e.attachmentKey,
        status: "uploaded",
        error: null,
        figuresUploaded: true,
        s3Prefix: prefix,
        uploadedAt: new Date().toISOString(),
      });
    }
    // 逐条持久化：任何意外中断都不丢进度
    await ledger.persist();
    } catch (eAny: any) {
      failed.push(`${e.attachmentKey}: ${eAny?.message || eAny}`);
      report.failed.push({ key: e.attachmentKey, error: String(eAny?.message || eAny) });
    }
    progress.changeLine({
      text: `S3 同步 ${uploaded + skipped}/${total}（失败 ${failed.length}）`,
      progress: Math.round(((uploaded + skipped) / Math.max(1, total)) * 100),
    });
  }

  // papers-index.jsonl：全量题录索引（本地 + 云端）
  const idxLines = Object.values(ledger.get().entries)
    .filter((e) => e.status === "uploaded" || e.status === "exported")
    .map((e) =>
      JSON.stringify({
        attachment_key: e.attachmentKey,
        parent_item_key: e.parentItemKey,
        library_scope: e.libraryScope,
        title: e.title,
        doi: e.doi,
        year: e.year,
        status: e.status,
        s3_prefix: e.s3Prefix ?? null,
        content_fingerprint: e.contentFingerprint ?? null,
      }),
    );
  const idxPath = PathUtils.join(exportRoot(), "papers-index.jsonl");
  await IOUtils.writeUTF8(idxPath, idxLines.join("\n") + "\n");
  const rIdx = await uploadFile(cfg, "papers-index.jsonl", idxPath, "application/x-ndjson");

  await ledger.persist();
  report.finishedAt = new Date().toISOString();
  report.aborted = aborted;
  report.uploadedTotal = uploaded;
  report.skipped = skipped;
  report.indexUploaded = rIdx.ok;
  try {
    await IOUtils.writeUTF8(
      PathUtils.join(exportRoot(), "sync-report.json"),
      JSON.stringify(report, null, 1),
    );
  } catch (_) { /* 报告写失败不影响主流程 */ }
  progress.changeLine({
    text: aborted
      ? `网关持续限速，本轮中止（已上传 ${uploaded}，失败 ${failed.length}）。进度已保存，10-30 分钟后重跑即续传`
      : `S3 同步完成：本次上传 ${uploaded}，跳过 ${skipped}，失败 ${failed.length}；索引 ${rIdx.ok ? "已更新" : "更新失败"}`,
    type: failed.length || aborted ? "fail" : "success",
    progress: 100,
  });
  progress.startCloseTimer(10000);
  await debugLog(`sync done: uploaded=${uploaded} skipped=${skipped} failed=${failed.length}`);
  if (failed.length) await debugLog(`failures: ${failed.slice(0, 20).join("; ")}`);
}

export async function syncFigures(): Promise<void> {
  const d = addon.data as any;
  if (d.zrbBusy) {
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({ text: "ZRB 已有任务在运行", type: "fail", progress: 100 })
      .startCloseTimer(5000);
    return;
  }
  d.zrbBusy = true;
  const progress = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: false })
    .createLine({ text: "ZRB 图片同步", type: "default", progress: 0 })
    .show();
  try {
    const cfg = await resolveS3Config();
    if (!cfg) {
      progress.changeLine({ text: "未配置 S3", type: "fail", progress: 100 });
      progress.startCloseTimer(8000);
      return;
    }
    await ledger.load();
    const entries = Object.values(ledger.get().entries).filter(
      (e) => e.status === "uploaded" && !e.figuresUploaded,
    );
    let done = 0;
    let failed = 0;
    for (const e of entries) {
      const figDir = PathUtils.join(paperDirOf(e), "figures");
      const figs = await listFigureFiles(figDir);
      let err: string | null = null;
      for (const f of figs) {
        const rf = await uploadFile(
          cfg, `${s3PrefixOf(e)}/figures/${PathUtils.filename(f)}`, f,
          "application/octet-stream",
        );
        if (!rf.ok) { err = rf.detail; break; }
      }
      if (err) {
        failed++;
        ledger.upsert({ attachmentKey: e.attachmentKey, error: err });
      } else {
        ledger.upsert({ attachmentKey: e.attachmentKey, figuresUploaded: true, error: null });
        done++;
      }
      await ledger.persist();
      progress.changeLine({
        text: `图片同步 ${done + failed}/${entries.length}`,
        progress: Math.round(((done + failed) / Math.max(1, entries.length)) * 100),
      });
    }
    progress.changeLine({
      text: `图片同步完成：成功 ${done}，失败 ${failed}`,
      type: failed ? "fail" : "success", progress: 100,
    });
    progress.startCloseTimer(8000);
  } finally {
    d.zrbBusy = false;
  }
}

// 自动备份管线：条目新增/变更/启动时 → 导出缺失 → S3 增量同步
// 注意：解析不进自动链（涉及 API 费用，必须手动触发）
export async function autoBackup(): Promise<void> {
  const d = addon.data as any;
  if (d.zrbBusy) return; // 已有任务在跑，静默跳过（下次变更再试）
  const getB = (n: string): boolean => {
    try {
      return (Zotero.Prefs.get(`extensions.zotero.${config.addonRef}.${n}`, true) as boolean) === true;
    } catch (_) { return false; }
  };
  if (!getB("autoSync")) return;
  d.zrbBusy = true;
  const progress = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: false })
    .createLine({ text: "ZRB 自动备份", type: "default", progress: 0 })
    .show();
  try {
    const { exportAllMissing } = await import("./exporter");
    await exportAllMissing();
    await syncToS3();
    progress.changeLine({ text: "自动备份完成", type: "success", progress: 100 });
    progress.startCloseTimer(5000);
  } catch (e: any) {
    await debugLog(`autoBackup FATAL: ${e?.message || e}`);
    progress.changeLine({ text: `自动备份异常：${String(e?.message || e).slice(0, 120)}`, type: "fail", progress: 100 });
    progress.startCloseTimer(10000);
  } finally {
    d.zrbBusy = false;
  }
}
