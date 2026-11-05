import { PDFDocument } from "pdf-lib";

export interface PdfPart {
  bytes: Uint8Array;
  filename: string;
  firstPage: number;
  lastPage: number;
}

// OXR 单文件上限为 300 页；保留 20 页余量，避免外部规则变化。
const MAX_PAGES_PER_PART = 280;
const MAX_BYTES_PER_PART = 180 * 1024 * 1024;

export async function splitPdfForParsing(
  bytes: Uint8Array,
  filename: string,
): Promise<PdfPart[]> {
  // 截断下载快速判定：完整 PDF 必有 %%EOF 尾标记。
  // 这类文件 pdf-lib 会报晦涩的流错误，提前给出可行动的提示。
  const tail = new TextDecoder("latin1").decode(bytes.slice(-2048));
  if (!tail.includes("%%EOF")) {
    throw new Error(
      "PDF 文件不完整（缺少 %%EOF 结束标记，通常是下载中断）。请在 Zotero 中删除此附件并重新下载原文后再解析",
    );
  }
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e: any) {
    throw new Error(`PDF 无法读取，文件可能损坏或加密：${e?.message || e}`);
  }
  const count = source.getPageCount();
  if (!count) throw new Error("PDF 没有可解析的页面");
  if (count <= 280 && bytes.length <= MAX_BYTES_PER_PART) {
    return [{ bytes, filename, firstPage: 1, lastPage: count }];
  }
  if (count <= 280) {
    throw new Error("PDF 超过 200 MB 且无法仅按页数压缩，请先压缩后重试");
  }
  const parts: PdfPart[] = [];
  const base = filename.replace(/\.pdf$/i, "");
  for (let start = 0; start < count; start += MAX_PAGES_PER_PART) {
    const end = Math.min(count, start + MAX_PAGES_PER_PART);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(
      source,
      Array.from({ length: end - start }, (_, i) => start + i),
    );
    for (const page of pages) out.addPage(page);
    const partBytes = await out.save();
    if (partBytes.length > MAX_BYTES_PER_PART) {
      throw new Error(
        `PDF 第 ${start + 1}–${end} 页分卷仍超过 200 MB，请压缩源文件`,
      );
    }
    parts.push({
      bytes: partBytes,
      filename: `${base}-part${parts.length + 1}.pdf`,
      firstPage: start + 1,
      lastPage: end,
    });
  }
  return parts;
}
