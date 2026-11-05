// 文献补全（0.8.0）：损坏/截断 PDF 的自动修复链路
// 移植自 paper-lookup skill 的开放接口（无需任何 API Key）：
//   Crossref（标题→DOI）→ Unpaywall（DOI→OA PDF）→ OpenAlex（兜底 OA 链接）
// 下载后做完整性校验（%PDF 头 + %%EOF 尾 + pdf-lib 可读），通过才替换附件。
// 替换用 Zotero 官方 API：新附件挂到原父条目（或保持独立），旧附件进回收站。

import * as ledger from "./ledger";
import { PDFDocument } from "pdf-lib";

export interface RepairProgress {
  changeLine: (o: { text?: string; progress?: number; type?: string }) => void;
}

export interface RepairResult {
  ok: boolean;
  message: string;
  newAttachmentKey?: string;
  doi?: string | null;
}

const UA = "ZoteroResearchBridge/0.8 (mailto:zrb@local)";

async function getJSON(url: string): Promise<any> {
  const r = await Zotero.HTTP.request("GET", url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    responseType: "text",
    timeout: 30000,
  });
  return JSON.parse(r.responseText || "{}");
}

// ---- 1) Crossref：标题 → DOI + 规范题录 ----
export async function crossrefByTitle(
  title: string,
): Promise<{ doi: string; title: string } | null> {
  const q = encodeURIComponent(title.slice(0, 300));
  const j = await getJSON(
    `https://api.crossref.org/works?query.bibliographic=${q}&rows=3`,
  );
  const items = j?.message?.items || [];
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
  const want = norm(title);
  for (const it of items) {
    const t = it.title?.[0] || "";
    // 标题前缀匹配即可（Zotero 文件名常把标题截断）
    const got = norm(t);
    if (
      got &&
      (got.startsWith(want.slice(0, 60)) || want.startsWith(got.slice(0, 60)))
    ) {
      return { doi: it.DOI, title: t };
    }
  }
  return null;
}

// ---- 2) Unpaywall：DOI → 最佳 OA PDF ----
export async function unpaywallPdf(doi: string): Promise<string | null> {
  try {
    const j = await getJSON(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=zrb@local`,
    );
    const locs = [j?.best_oa_location, ...(j?.oa_locations || [])].filter(
      Boolean,
    );
    for (const loc of locs) {
      if (loc.url_for_pdf) return loc.url_for_pdf;
    }
    for (const loc of locs) {
      if (loc.url) return loc.url; // 落地页兜底（下载时再探 PDF）
    }
  } catch (_) {
    /* 404 = 无 OA 记录 */
  }
  return null;
}

// ---- 3) OpenAlex：兜底 OA 链接 ----
export async function openalexPdf(doi: string): Promise<string | null> {
  try {
    const j = await getJSON(
      `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`,
    );
    const locs = [j?.best_oa_location, ...(j?.locations || [])].filter(Boolean);
    for (const loc of locs) {
      if (loc.pdf_url) return loc.pdf_url;
    }
    for (const loc of locs) {
      if (loc.landing_page_url) return loc.landing_page_url;
    }
  } catch (_) {
    /* 无记录 */
  }
  return null;
}

// ---- 3b) Semantic Scholar：第三兜底（共享池限速，429 时静默跳过）----
export async function semanticScholarPdf(doi: string): Promise<string | null> {
  try {
    const j = await getJSON(
      `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=openAccessPdf`,
    );
    return j?.openAccessPdf?.url || null;
  } catch (_) {
    return null;
  }
}

// ---- 4) 下载 + 完整性校验 ----
export function isPdfComplete(bytes: Uint8Array): boolean {
  // 极小的合法 PDF（单页空白）可能不足 1KB，只设最低防线
  if (bytes.length < 100) return false;
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 8));
  if (!head.includes("%PDF")) return false;
  const tail = new TextDecoder("latin1").decode(bytes.slice(-2048));
  return tail.includes("%%EOF");
}

export async function downloadPdf(url: string): Promise<Uint8Array> {
  const r = await Zotero.HTTP.request("GET", url, {
    headers: { "User-Agent": UA },
    responseType: "arraybuffer",
    timeout: 180000,
    successCodes: false,
    followRedirects: true,
  } as any);
  if (r.status < 200 || r.status >= 300)
    throw new Error(`下载失败 HTTP ${r.status}`);
  const bytes = new Uint8Array(r.response as ArrayBuffer);
  if (!isPdfComplete(bytes)) {
    // 可能是落地页 HTML：从中找 citation_pdf_url / .pdf 链接再试一次
    const ct = String(r.getResponseHeader?.("content-type") || "");
    if (ct.includes("text/html")) {
      const html = new TextDecoder().decode(bytes.slice(0, 200000));
      const meta = html.match(
        /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i,
      );
      const link = meta?.[1] || html.match(/href=["']([^"']+\.pdf[^"']*)["']/i)?.[1];
      if (link) {
        const abs = new URL(link, url).href;
        return downloadPdf(abs);
      }
    }
    throw new Error("下载内容不是完整 PDF（可能需登录或无开放全文）");
  }
  // pdf-lib 终验：能打开才算数
  await PDFDocument.load(bytes, { updateMetadata: false });
  return bytes;
}

// ---- 5) 主流程：修复一个账本条目 ----
export async function repairEntry(
  attachmentKey: string,
  progress: RepairProgress,
): Promise<RepairResult> {
  await ledger.load();
  const e = ledger.entry(attachmentKey);
  if (!e) return { ok: false, message: "账本中无此条目" };
  const att = e.attachmentId ? Zotero.Items.get(e.attachmentId) : null;
  if (!att) return { ok: false, message: "附件已不存在，请刷新工作台" };

  const say = (text: string, pct: number) =>
    progress.changeLine({ text, progress: pct });

  // 5.1 确定 DOI：账本/父条目 → Crossref 标题检索
  say("查找 DOI…", 10);
  let doi = e.doi;
  const parent = att.parentItemID ? Zotero.Items.get(att.parentItemID) : null;
  if (!doi && parent) doi = parent.getField("DOI") || null;
  if (!doi) {
    const title =
      parent?.getField("title") || att.getField("title") || e.title || "";
    if (!title) return { ok: false, message: "无标题也无 DOI，无法检索" };
    const hit = await crossrefByTitle(title);
    if (!hit)
      return { ok: false, message: `Crossref 未找到匹配：${title.slice(0, 60)}…` };
    doi = hit.doi;
    say(`Crossref 命中 DOI ${doi}`, 25);
  }
  if (!doi) return { ok: false, message: "无法确定 DOI" };

  // 顺手把查到的 DOI 写回账本与父条目（独立附件则记在账本）
  if (!e.doi) {
    ledger.upsert({ attachmentKey, doi });
    if (parent && !parent.getField("DOI")) {
      parent.setField("DOI", doi);
      await parent.saveTx();
    }
    await ledger.persist();
  }

  // 5.2 找开放 PDF：Unpaywall → OpenAlex → Semantic Scholar
  say("查询开放获取链接（Unpaywall/OpenAlex/S2）…", 35);
  const url =
    (await unpaywallPdf(doi)) ||
    (await openalexPdf(doi)) ||
    (await semanticScholarPdf(doi));
  if (!url)
    return {
      ok: false,
      doi,
      message: `DOI ${doi} 无开放获取版本（闭源期刊）。请通过机构访问下载后拖入 Zotero 替换；DOI 已记录`,
    };

  // 5.3 下载 + 校验
  say(`下载 PDF：${url.slice(0, 80)}…`, 50);
  let bytes: Uint8Array;
  try {
    bytes = await downloadPdf(url);
  } catch (err: any) {
    return { ok: false, doi, message: `下载/校验失败：${err?.message || err}` };
  }
  say(`下载完成（${(bytes.length / 1048576).toFixed(1)} MB），替换附件…`, 75);

  // 5.4 落盘 + 导入为新附件，旧附件进回收站
  const tmpDir = PathUtils.join(Zotero.DataDirectory.dir, "zrb-export", "repair");
  await IOUtils.makeDirectory(tmpDir, { ignoreExisting: true });
  const safe = (doi || attachmentKey).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const tmpPath = PathUtils.join(tmpDir, `${safe}.pdf`);
  await IOUtils.write(tmpPath, bytes);
  const newAtt = await Zotero.Attachments.importFromFile({
    file: tmpPath,
    libraryID: att.libraryID,
    parentItemID: att.parentItemID || undefined,
    title: parent?.getField("title") || att.getField("title") || e.title || undefined,
  });
  await IOUtils.remove(tmpPath).catch(() => {});
  // 旧附件移入回收站（可恢复，不直接删除）
  att.deleted = true;
  await att.saveTx();

  // 5.5 账本迁移到新 key，回到待解析
  ledger.upsert({
    attachmentKey: newAtt.key,
    attachmentId: newAtt.id,
    parentItemKey: e.parentItemKey,
    libraryScope: e.libraryScope,
    title: e.title,
    doi,
    year: e.year,
    status: "not_parsed",
    error: null,
  });
  delete ledger.get().entries[attachmentKey];
  await ledger.persist();
  say("附件已替换，可重新解析", 100);
  return {
    ok: true,
    doi,
    newAttachmentKey: newAtt.key,
    message: `已补全：DOI ${doi}，新附件 ${newAtt.key}（旧文件在回收站）`,
  };
}