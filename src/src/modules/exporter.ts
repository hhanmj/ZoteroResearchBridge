// ZRB 导出器：MinerU 缓存 → 规范化 Markdown + 上传暂存区（P2 MVP）
// 移植自 tools/migrate_caches.py（P1 验证过的逻辑），数据访问改用 Zotero 官方 API，
// 不直接读写 zotero.sqlite。

import { config } from "../../package.json";
import * as ledger from "./ledger";

export interface PaperMeta {
  title: string | null;
  creators: { lastName: string; firstName: string; creatorType: string }[];
  year: string | null;
  doi: string | null;
  publication: string | null;
  itemType: string | null;
}

const FIGURE_REF = /!\[([^\]]*)\]\(([^)]+)\)/g;

function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export async function digestHex(text: string): Promise<string> {
  // 优先 SubtleCrypto SHA-256；沙箱不可用时退回双 fnv 指纹
  try {
    const cr = (globalThis as any).crypto as any;
    if (cr && cr.subtle) {
      const buf = await cr.subtle.digest("SHA-256", textBytes(text) as any);
      return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch (_) {
    /* fallthrough */
  }
  const b = textBytes(text);
  const a = fnv1a32(b);
  const c = fnv1a32(b.slice(Math.floor(b.length / 2)));
  return `fnv2-${a}${c}`;
}

function extractYear(dateVal: string | null): string | null {
  if (!dateVal) return null;
  const m = dateVal.match(/(1[5-9]\d{2}|20\d{2})/);
  return m ? m[1]! : null;
}

function metaOf(parent: Zotero.Item): PaperMeta {
  const creators = (parent.getCreators() || []).map((c: any) => ({
    lastName: c.lastName || "",
    firstName: c.firstName || "",
    creatorType: Zotero.CreatorTypes.getName(c.creatorTypeID) || "author",
  }));
  const year = extractYear(parent.getField("date"));
  return {
    title: parent.getField("title") || null,
    creators,
    year,
    doi: parent.getField("DOI") || null,
    publication: parent.getField("publicationTitle") || null,
    itemType: Zotero.ItemTypes.getName(parent.itemTypeID),
  };
}

function safeName(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex -- Windows 文件名必须排除控制字符。
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .slice(0, 110)
      .trim() || "unnamed"
  );
}

function libraryScope(libraryID: number): string {
  const lib = Zotero.Libraries.get(libraryID);
  const type = lib ? lib.libraryType : "user";
  return (type === "user" ? "u" : "g") + libraryID;
}

function cacheDirFor(attachmentId: number): string {
  // 优先旧插件缓存（llm-for-zotero），回退本插件 API 解析产出（zrb-cache）
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    "llm-for-zotero-mineru",
    String(attachmentId),
  );
}

export async function resolveCacheDir(
  attachmentId: number,
  attachmentKey?: string,
): Promise<string | null> {
  const candidates = [
    cacheDirFor(attachmentId),
    ...(attachmentKey
      ? [
          PathUtils.join(
            Zotero.DataDirectory.dir,
            "llm-for-zotero-mineru",
            attachmentKey,
          ),
        ]
      : []),
    PathUtils.join(Zotero.DataDirectory.dir, "zrb-cache", String(attachmentId)),
    ...(attachmentKey
      ? [PathUtils.join(Zotero.DataDirectory.dir, "zrb-cache", attachmentKey)]
      : []),
  ];
  for (const dir of candidates) {
    if (await IOUtils.exists(PathUtils.join(dir, "full.md"))) return dir;
  }
  return null;
}

export function getStagingDir(): string {
  let p = "";
  try {
    p =
      (Zotero.Prefs.get(
        `extensions.zotero.${config.addonRef}.stagingDir`,
        true,
      ) as string) || "";
  } catch (_) {
    p = "";
  }
  return p || PathUtils.join(Zotero.DataDirectory.dir, "zrb-upload-staging");
}

async function readCache(
  attachmentId: number,
  attachmentKey: string,
): Promise<{
  fullMd: string;
  manifest: any | null;
  origin: string | null;
  contentHash: string | null;
  images: { name: string; bytes: Uint8Array }[];
} | null> {
  const dir =
    (await resolveCacheDir(attachmentId, attachmentKey)) ||
    cacheDirFor(attachmentId);
  const fullMdPath = PathUtils.join(dir, "full.md");
  if (!(await IOUtils.exists(fullMdPath))) return null;
  const fullMd = await IOUtils.readUTF8(fullMdPath);
  let manifest: any = null;
  let origin: string | null = null;
  let contentHash: string | null = null;
  const srcPath = PathUtils.join(dir, "_llm_source.json");
  if (await IOUtils.exists(srcPath)) {
    try {
      const src = JSON.parse(await IOUtils.readUTF8(srcPath));
      origin = src.origin ?? null;
      contentHash = src.cacheContentHash ?? null;
    } catch (_) {
      /* 忽略损坏的来源文件 */
    }
  }
  const manifestPath = PathUtils.join(dir, "manifest.json");
  if (await IOUtils.exists(manifestPath)) {
    try {
      manifest = JSON.parse(await IOUtils.readUTF8(manifestPath));
    } catch (_) {
      /* 忽略 */
    }
  }
  const images: { name: string; bytes: Uint8Array }[] = [];
  try {
    const imgDir = PathUtils.join(dir, "images");
    if (await IOUtils.exists(imgDir)) {
      const names = await IOUtils.getChildren(imgDir);
      for (const n of names) {
        try {
          images.push({
            name: PathUtils.filename(n),
            bytes: await IOUtils.read(n),
          });
        } catch (_) {
          /* 跳过不可读文件 */
        }
      }
    }
  } catch (_) {
    /* images 目录缺失 */
  }
  return { fullMd, manifest, origin, contentHash, images };
}

function metadataBlock(rec: ledger.LedgerEntry, meta: PaperMeta): string {
  const lines = ["<!-- ZRB-METADATA", `title: ${meta.title || ""}`];
  if (meta.creators.length) {
    lines.push(
      "authors: " +
        meta.creators
          .slice(0, 10)
          .map((c) =>
            `${c.lastName}${c.firstName ? " " + c.firstName : ""}`.trim(),
          )
          .join(", "),
    );
  }
  if (meta.year) lines.push(`year: ${meta.year}`);
  if (meta.doi) lines.push(`doi: ${meta.doi}`);
  if (meta.publication) lines.push(`publication: ${meta.publication}`);
  lines.push(`zotero-item: ${rec.parentItemKey || ""}`);
  lines.push(`zotero-attachment: ${rec.attachmentKey}`);
  lines.push(`library-scope: ${rec.libraryScope}`);
  lines.push("-->");
  return lines.join("\n");
}

function readableHeader(meta: PaperMeta): string {
  const out: string[] = [];
  if (meta.title) out.push(`# ${meta.title}`);
  if (meta.creators.length) {
    const names = meta.creators
      .slice(0, 10)
      .map((c) => `${c.lastName}${c.firstName ? " " + c.firstName : ""}`.trim())
      .join(", ");
    if (names) out.push(`*${names}*`);
  }
  const bits: string[] = [];
  if (meta.year) bits.push(meta.year);
  if (meta.publication) bits.push(meta.publication);
  if (meta.doi) bits.push(`DOI: ${meta.doi}`);
  if (bits.length) out.push(bits.join(" | "));
  out.push("");
  return out.join("\n") + "\n";
}

function rewriteFigures(body: string, nameMap: Map<string, string>): string {
  return body.replace(FIGURE_REF, (m0, alt: string, target: string) => {
    const base = target.split("/").pop()!.split("?")[0]!;
    const newName = nameMap.get(base);
    return newName ? `![${alt}](figures/${newName})` : m0;
  });
}

export interface ExportResult {
  ok: boolean;
  attachmentKey: string;
  status: ledger.TaskStatus;
  message?: string;
}

async function exportOne(
  att: Zotero.Item,
  stagingDir: string,
): Promise<ExportResult> {
  const attachmentKey = att.key;
  const parentId = att.parentItemID;
  const parent = parentId ? Zotero.Items.get(parentId) : null;
  const rec: ledger.LedgerEntry = {
    attachmentKey,
    attachmentId: att.id,
    parentItemKey: parent ? parent.key : null,
    libraryScope: libraryScope(att.libraryID),
    title: parent ? parent.getField("title") : null,
    doi: parent ? parent.getField("DOI") : null,
    year: parent ? extractYear(parent.getField("date")) : null,
    status: "export_failed",
  };
  const cache = await readCache(att.id, attachmentKey);
  if (!cache) {
    rec.status = "not_parsed";
    ledger.upsert(rec);
    return {
      ok: false,
      attachmentKey,
      status: "not_parsed",
      message: "无本地 MinerU 缓存",
    };
  }
  rec.cacheOrigin = cache.origin;
  rec.cacheContentHash = cache.contentHash;
  const meta = parent
    ? metaOf(parent)
    : {
        title: null,
        creators: [],
        year: null,
        doi: null,
        publication: null,
        itemType: null,
      };

  // 导出目录：papers/<scope>/<parentKey|_noparent>/<attKey>/
  const baseDir = PathUtils.join(
    Zotero.DataDirectory.dir,
    "zrb-export",
    "papers",
    rec.libraryScope,
    rec.parentItemKey || "_noparent",
    attachmentKey,
  );
  await Zotero.File.createDirectoryIfMissing(
    PathUtils.join(baseDir, "figures"),
  );

  // 图片：内容哈希命名，防路径穿越（只取文件名、白名单扩展）
  const nameMap = new Map<string, string>();
  for (const img of cache.images) {
    if (!/\.(jpe?g|png|gif|bmp|webp|svg|tiff?)$/i.test(img.name)) continue;
    const digest =
      fnv1a32(img.bytes) +
      fnv1a32(img.bytes.slice(0, Math.min(4096, img.bytes.length)));
    const ext = (img.name.match(/\.(jpe?g|png|gif|bmp|webp|svg|tiff?)$/i) || [
      "",
      ".jpg",
    ])[1]!.toLowerCase();
    const newName = digest + ext;
    const target = PathUtils.join(baseDir, "figures", newName);
    if (!(await IOUtils.exists(target))) await IOUtils.write(target, img.bytes);
    nameMap.set(img.name, newName);
  }

  const body = rewriteFigures(cache.fullMd, nameMap);
  const fulltext =
    metadataBlock(rec, meta) +
    "\n---\n\n" +
    readableHeader(meta) +
    body.trimEnd() +
    "\n";
  const fingerprint = await digestHex(fulltext);
  await IOUtils.writeUTF8(PathUtils.join(baseDir, "fulltext.md"), fulltext);
  if (cache.manifest) {
    await IOUtils.writeUTF8(
      PathUtils.join(baseDir, "manifest.json"),
      JSON.stringify(cache.manifest),
    );
  }

  // 上传暂存区（扁平，一篇一文件，文件名含 key 可回链）
  const stagingName = `${rec.parentItemKey || attachmentKey}__${attachmentKey}__fulltext.md`;
  const stagingPath = PathUtils.join(stagingDir, stagingName);
  await IOUtils.writeUTF8(stagingPath, fulltext);

  // 已上传且内容未变 → 保持 uploaded（避免重新导出把账本状态打回去）
  const prev = ledger.entry(attachmentKey);
  if (
    prev &&
    prev.status === "uploaded" &&
    prev.contentFingerprint === fingerprint
  ) {
    rec.status = "uploaded";
  } else {
    rec.status = "exported";
  }
  rec.contentFingerprint = fingerprint;
  rec.stagingFile = stagingName;
  rec.chunkCount = 1;
  rec.exportedAt = new Date().toISOString();
  rec.error = null;
  ledger.upsert(rec);
  return { ok: true, attachmentKey, status: "exported" };
}

function pdfAttachmentsOf(item: Zotero.Item): Zotero.Item[] {
  if (item.isAttachment()) {
    const ct = item.attachmentContentType;
    return ct === "application/pdf" ? [item] : [];
  }
  if (!item.isRegularItem()) return [];
  return (item.getAttachments() || [])
    .map((id) => Zotero.Items.get(id))
    .filter((a: any) => a && a.attachmentContentType === "application/pdf");
}

export async function exportSelected(win: Window): Promise<void> {
  await exportAttachments(getSelectedPdfAttachments(win), "导出选中");
}

export function getSelectedPdfAttachments(win: Window): Zotero.Item[] {
  const items = win.ZoteroPane.itemsView.getSelectedItems() || [];
  const atts: Zotero.Item[] = [];
  const seen = new Set<number>();
  for (const it of items) {
    for (const a of pdfAttachmentsOf(it as Zotero.Item)) {
      if (!seen.has(a.id)) {
        atts.push(a);
        seen.add(a.id);
      }
    }
  }
  return atts;
}

export async function exportEntries(
  keys: string[],
  progress: { changeLine: (o: { text?: string; progress?: number }) => void },
): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}> {
  await ledger.load();
  const atts: Zotero.Item[] = [];
  for (const key of keys) {
    const e = ledger.entry(key);
    const att = e?.attachmentId ? Zotero.Items.get(e.attachmentId) : null;
    if (att) atts.push(att);
  }
  return runExportInner(atts, "导出文献", progress);
}

export async function exportAttachments(
  atts: Zotero.Item[],
  label: string,
): Promise<void> {
  await runExport(atts, `${label}（${atts.length} 个 PDF）`);
}

export async function exportAllMissing(): Promise<void> {
  await ledger.load();
  const atts: Zotero.Item[] = [];
  const libs = Zotero.Libraries.getAll().filter(
    (l: any) => l.libraryType === "user",
  );
  for (const lib of libs) {
    const items = await (Zotero.Items.getAll(
      lib.libraryID,
      false,
      false,
    ) as unknown as Promise<Zotero.Item[]>);
    for (const it of items) {
      for (const a of pdfAttachmentsOf(it)) {
        const e = ledger.entry(a.key);
        if (
          !e ||
          ["not_parsed", "export_failed", "parsed", "sync_failed"].includes(
            e.status,
          )
        )
          atts.push(a);
      }
    }
  }
  await runExport(atts, `导出全库缺失（${atts.length} 个 PDF）`);
}

async function runExport(atts: Zotero.Item[], label: string) {
  const d = addon.data as any;
  if (d.zrbBusy) {
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({
        text: "ZRB 已有任务在运行，请等其完成",
        type: "fail",
        progress: 100,
      })
      .startCloseTimer(5000);
    return;
  }
  d.zrbBusy = true;
  try {
    return await runExportInner(atts, label);
  } finally {
    d.zrbBusy = false;
  }
}

export async function exportMissingWithProgress(progress: {
  changeLine: (o: { text?: string; progress?: number; type?: string }) => void;
}) {
  await ledger.load();
  const atts: Zotero.Item[] = [];
  const libs = Zotero.Libraries.getAll().filter(
    (l: any) => l.libraryType === "user",
  );
  for (const lib of libs) {
    const items = await (Zotero.Items.getAll(
      lib.libraryID,
      false,
      false,
    ) as unknown as Promise<Zotero.Item[]>);
    for (const it of items) {
      for (const a of pdfAttachmentsOf(it)) {
        const e = ledger.entry(a.key);
        if (
          !e ||
          ["not_parsed", "export_failed", "parsed", "sync_failed"].includes(
            e.status,
          )
        )
          atts.push(a);
      }
    }
  }
  return runExportInner(atts, "导出待处理", progress);
}

async function runExportInner(
  atts: Zotero.Item[],
  label: string,
  providedProgress?: {
    changeLine: (o: {
      text?: string;
      progress?: number;
      type?: string;
    }) => void;
  },
): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}> {
  await ledger.load();
  const stagingDir = getStagingDir();
  await Zotero.File.createDirectoryIfMissing(stagingDir);
  const progress =
    providedProgress ||
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: false })
      .createLine({
        text: label,
        type: "default",
        progress: 0,
      })
      .show();
  let done = 0;
  let ok = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const att of atts) {
    progress.changeLine({
      text: `${label}：${att.key}（${done + 1}/${atts.length}）`,
      progress: Math.round((done / Math.max(1, atts.length)) * 100),
    });
    try {
      const prev = ledger.entry(att.key);
      const r = await exportOne(att, stagingDir);
      if (r.ok) {
        ok++;
        if (
          prev?.status === "uploaded" &&
          ledger.entry(att.key)?.status === "uploaded"
        )
          skipped++;
      } else if (r.status === "not_parsed")
        failed.push(`${r.attachmentKey}: 无缓存`);
      else failed.push(`${r.attachmentKey}: ${r.message || "失败"}`);
    } catch (e: any) {
      failed.push(`${att.key}: ${e?.message || e}`);
      ledger.upsert({
        attachmentKey: att.key,
        status: "export_failed",
        error: String(e?.message || e),
      });
    }
    done++;
    await ledger.persist();
    progress.changeLine({
      text: `${label} — ${done}/${atts.length}`,
      progress: Math.round((done / Math.max(1, atts.length)) * 100),
    });
  }
  await ledger.persist();
  const text = `导出完成：成功 ${ok}，失败/无缓存 ${failed.length}`;
  progress.changeLine({
    text,
    type: failed.length ? "fail" : "success",
    progress: 100,
  });
  if (!providedProgress) (progress as any).startCloseTimer?.(8000);
  if (failed.length && failed.length <= 10) {
    ztoolkit.log("[zrb] export failures:", failed.join("; "));
  }
  return { attempted: done, succeeded: ok, failed: failed.length, skipped };
}

export async function showStatus(): Promise<void> {
  await ledger.load();
  const s = ledger.stats();
  const total = Object.values(s).reduce((a, b) => a + b, 0);
  const detail =
    Object.entries(s)
      .map(([k, v]) => `${k}: ${v}`)
      .join("，") || "（空）";
  const text = `ZRB 任务账本：共 ${total} 个附件。${detail}`;
  Zotero.log(`[zrb] ${text}`);
  const progress = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
  })
    .createLine({ text: `账本共 ${total} 项`, type: "default", progress: 100 })
    .show();
  progress.startCloseTimer(6000);
  // 完整明细写入日志（帮助→调试输出日志 可见）
  const lines = Object.entries(s)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  Zotero.debug(`[zrb] ledger stats: total=${total}; ${lines}`);
}
