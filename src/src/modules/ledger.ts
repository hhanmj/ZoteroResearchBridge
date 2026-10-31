// ZRB 任务账本：记录每个 PDF 附件的导出/同步状态（P2 MVP）
// 持久化于 <DataDir>/zrb-ledger.json

export type TaskStatus =
  | "not_parsed" // 无本地 MinerU 缓存
  | "parsing" // API 解析进行中
  | "parsed" // 有缓存（本地或 API 解析产出）
  | "exported" // 已导出到上传暂存区
  | "queued_upload" // 待 S3 上传（P3）
  | "uploaded" // 已上传（P3）
  | "indexed_verified" // 云端已索引（P4）
  | "export_failed";

export interface LedgerEntry {
  attachmentKey: string;
  attachmentId?: number;
  parentItemKey: string | null;
  libraryScope: string;
  title: string | null;
  doi: string | null;
  year: string | null;
  status: TaskStatus;
  cacheOrigin?: string | null;
  cacheContentHash?: string | null;
  contentFingerprint?: string | null; // fulltext 指纹（sha256 或 fnv1a32 对）
  stagingFile?: string | null;
  chunkCount?: number;
  exportedAt?: string | null;
  figuresUploaded?: boolean;
  parseEngine?: string | null;
  parseTime?: string | null;
  s3Prefix?: string | null;
  uploadedAt?: string | null;
  error?: string | null;
}

export interface Ledger {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

function ledgerPath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, "zrb-ledger.json");
}

let cache: Ledger | null = null;

export async function load(force = false): Promise<Ledger> {
  if (cache && !force) return cache;
  const p = ledgerPath();
  try {
    if (await IOUtils.exists(p)) {
      const raw = await IOUtils.readUTF8(p);
      cache = JSON.parse(raw) as Ledger;
    }
  } catch (e) {
    Zotero.logError(new Error(`[zrb] ledger load failed: ${e}`));
  }
  if (!cache || !cache.entries) cache = { version: 1, entries: {} };
  return cache;
}

export async function save(): Promise<void> {
  if (!cache) return;
  await Zotero.File.putContentsAsync(ledgerPath(), JSON.stringify(cache, null, 1));
}

export function get(): Ledger {
  if (!cache) cache = { version: 1, entries: {} };
  return cache;
}

export function entry(attachmentKey: string): LedgerEntry | undefined {
  return get().entries[attachmentKey];
}

export function upsert(e: Partial<LedgerEntry> & { attachmentKey: string }): void {
  const led = get();
  const prev = led.entries[e.attachmentKey] || ({} as LedgerEntry);
  led.entries[e.attachmentKey] = { ...prev, ...e } as LedgerEntry;
}

export async function persist(): Promise<void> {
  await save();
}

export function stats(): Record<string, number> {
  const led = get();
  const out: Record<string, number> = {};
  for (const k of Object.keys(led.entries)) {
    const s = led.entries[k].status;
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

