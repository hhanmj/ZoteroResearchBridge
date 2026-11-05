// 解析引擎（P3.5）：OXR / MinerU API 直连
// 设计要点：
//  - 费用护栏：首次使用需确认（parseConfirmed）、免费额度开关（allowPaidQuota）、启动前查询余额（OXR）
//  - 结果落盘：zrb-cache/<attachmentId>/（full.md + images/），随后复用导出管线
//  - 状态机：not_parsed → parsing → parsed → (导出) exported

import { config } from "../../package.json";
import * as ledger from "./ledger";
import { md5 } from "./md5";
import * as task from "./task";
import * as exporter from "./exporter";
import { splitPdfForParsing } from "./pdf";

export interface ProgressReporter {
  changeLine: (o: { text?: string; progress?: number; type?: string }) => void;
}

const MINERU_BASE = "https://mineru.net/api/v4";

// 插件沙箱无 FormData 全局 → 手工构建 multipart/form-data 字节体
function buildMultipart(
  fields: Record<string, string>,
  file?: {
    field: string;
    filename: string;
    bytes: Uint8Array;
    contentType?: string;
  },
): { body: Uint8Array; contentType: string } {
  const boundary = "----ZRBForm" + Math.random().toString(16).slice(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  if (file) {
    parts.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`,
      ),
    );
    parts.push(file.bytes);
    parts.push(enc.encode(`\r\n`));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
// OXR 双站内置：国内 somark.cn / 海外 somark.ai，设置页选站点，不再手填 URL
export const OXR_SITES: Record<string, string> = {
  cn: "https://somark.cn/api/v1",
  intl: "https://somark.ai/api/v1",
};

function oxrBase(): string {
  const site = getPref("oxrSite");
  if (OXR_SITES[site]) return OXR_SITES[site]!;
  // 兼容旧配置：手填过 Base URL 的继续尊重
  return getPref("oxrBaseUrl") || OXR_SITES.cn!;
}

export type Engine = "mineru" | "oxr";

function getPref(name: string, dflt = ""): string {
  try {
    return (
      (Zotero.Prefs.get(
        `extensions.zotero.${config.addonRef}.${name}`,
        true,
      ) as string) || dflt
    );
  } catch (_) {
    return dflt;
  }
}

function getBoolPref(name: string): boolean {
  try {
    return (
      (Zotero.Prefs.get(
        `extensions.zotero.${config.addonRef}.${name}`,
        true,
      ) as boolean) === true
    );
  } catch (_) {
    return false;
  }
}

function setPref(name: string, value: string): void {
  Zotero.Prefs.set(`extensions.zotero.${config.addonRef}.${name}`, value, true);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function debugLog(msg: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  Zotero.debug(`[zrb] ${msg}`);
  try {
    const p = PathUtils.join(
      Zotero.DataDirectory.dir,
      "zrb-export",
      "zrb-debug.log",
    );
    const prev = (await IOUtils.exists(p)) ? await IOUtils.readUTF8(p) : "";
    await IOUtils.writeUTF8(p, prev + line);
  } catch (_) {
    /* ignore */
  }
}

// ---- 每日额度护栏 ----
function dailyCheck(maxDaily: number): { allowed: boolean; used: number } {
  const today = new Date().toISOString().slice(0, 10);
  if (getPref("parseDailyDate") !== today) {
    setPref("parseDailyDate", today);
    setPref("parseDailyUsed", "0");
    return { allowed: true, used: 0 };
  }
  const used = parseInt(getPref("parseDailyUsed", "0"), 10) || 0;
  return { allowed: used < maxDaily, used };
}

function dailyIncr(n: number): void {
  const used = parseInt(getPref("parseDailyUsed", "0"), 10) || 0;
  setPref("parseDailyUsed", String(used + n));
}

// ---- ZIP 解包（nsIZipReader，防路径穿越）----
function extractZip(
  zipPath: string,
  destDir: string,
): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const CC = Components.classes as any;
  const CI = Components.interfaces as any;
  const zip = CC["@mozilla.org/zip;1"].createInstance(CI.nsIZipReader);
  zip.open(Zotero.File.pathToFile(zipPath));
  try {
    const en = zip.findEntries("*");
    while (en.hasMore()) {
      const entryName = en.getNext();
      const safe = entryName.replace(/\\/g, "/").split("/").pop() || "";
      if (!safe || entryName.endsWith("/")) continue;
      const entry = zip.getEntry(entryName);
      if (!entry) continue;
      const is = zip.getInputStream(entryName);
      try {
        const bis: any = CC["@mozilla.org/binaryinputstream;1"].createInstance(
          CI.nsIBinaryInputStream,
        );
        bis!.setInputStream(is);
        const sz = Number(entry.realSize || entry.size || 0);
        // 大文件（origin.pdf 可达数十 MB）不能用 spread 展开，会栈溢出
        out.push({ name: safe, bytes: new Uint8Array(bis!.readByteArray(sz)) });
      } finally {
        is.close();
      }
    }
  } finally {
    zip.close();
  }
  void destDir;
  return out;
}

// ---- MinerU：本地 PDF 上传 → 轮询 → zip ----
async function mineruParse(
  token: string,
  pdfBytes: Uint8Array,
  filename: string,
  progress: ProgressReporter,
): Promise<{ md: string; images: { name: string; bytes: Uint8Array }[] }> {
  // 1) 申请上传链接 + batch_id
  const applyUrl = `${MINERU_BASE}/file-urls/batch`;
  const applyBody = JSON.stringify({
    files: [{ name: filename, is_ocr: true, data_id: filename }],
    model_version: "vlm",
    enable_formula: true,
    enable_table: true,
    language: "ch",
  });
  const r1 = await Zotero.HTTP.request("POST", applyUrl, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: applyBody,
    responseType: "text",
    timeout: 60000,
  });
  const j1 = JSON.parse(r1.responseText || "{}");
  if (j1.code !== 0)
    throw new Error(
      `MinerU 申请上传链接失败: ${j1.msg || (r1.responseText || "").slice(0, 200)}`,
    );
  const batchId = j1.data.batch_id as string;
  const putUrl = j1.data.file_urls[0] as string;

  // 2) PUT 上传 PDF（预签名地址）
  // ⚠️ 实测（2026-11-01）：该预签名 URL 的签名未包含 Content-Type，
  //    任何 Content-Type 头都会导致 OSS 403 SignatureDoesNotMatch → 卡 waiting-file。
  //    必须裸 PUT（无 Content-Type / Expect），并检查响应状态。
  const up = await Zotero.HTTP.request("PUT", putUrl, {
    body: pdfBytes,
    responseType: "text",
    timeout: 600000,
    successCodes: false,
  });
  if (up.status < 200 || up.status >= 300) {
    throw new Error(
      `MinerU 文件上传失败：HTTP ${up.status} ${(up.responseText || "").slice(0, 150)}`,
    );
  }

  // 3) 轮询（10s 间隔，最长 20 分钟）
  const queryUrl = `${MINERU_BASE}/extract-results/batch/${batchId}`;
  for (let i = 0; i < 120; i++) {
    await sleep(10000);
    const rq = await Zotero.HTTP.request("GET", queryUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: "text",
      timeout: 60000,
    });
    const jq = JSON.parse(rq.responseText || "{}");
    const item = jq?.data?.extract_result?.[0];
    const state = item?.state;
    progress.changeLine({
      text: `MinerU 解析中（${state || "?"}，已等待 ${i * 10}s）`,
      progress: 40,
    });
    if (state === "done") {
      const zipUrl = item.full_zip_url as string;
      const zr = await Zotero.HTTP.request("GET", zipUrl, {
        responseType: "text",
        timeout: 300000,
      });
      // responseType text + binary zip → 需要 arraybuffer；改用二进制请求
      const zrBin = await Zotero.HTTP.request("GET", zipUrl, {
        responseType: "arraybuffer",
        timeout: 300000,
      });
      void zr;
      const zipBytes = new Uint8Array(zrBin.response as ArrayBuffer);
      const zipPath = PathUtils.join(
        Zotero.DataDirectory.dir,
        "zrb-export",
        `mineru-${batchId}.zip`,
      );
      await IOUtils.write(zipPath, zipBytes);
      const entries = extractZip(zipPath, "");
      await IOUtils.remove(zipPath);
      const mdEntry = entries.find((e) => e.name === "full.md");
      if (!mdEntry) throw new Error("MinerU zip 中无 full.md");
      const images = entries
        .filter((e) => /\.(jpe?g|png|gif|bmp|webp|svg|tiff?)$/i.test(e.name))
        .map((e) => ({ name: e.name, bytes: e.bytes }));
      return { md: new TextDecoder().decode(mdEntry.bytes), images };
    }
    if (state === "failed") {
      throw new Error(`MinerU 解析失败: ${item?.err_msg || "未知错误"}`);
    }
  }
  throw new Error("MinerU 解析超时（20 分钟）");
}

// ---- OXR（SoMark）：异步提交 → 轮询 ----
async function oxrParse(
  apiKey: string,
  pdfBytes: Uint8Array,
  filename: string,
  progress: ProgressReporter,
): Promise<{ md: string; images: { name: string; bytes: Uint8Array }[] }> {
  const mp = buildMultipart(
    { api_key: apiKey },
    {
      field: "file",
      filename,
      bytes: pdfBytes,
      contentType: "application/pdf",
    },
  );
  const r1 = await Zotero.HTTP.request("POST", `${oxrBase()}/parse/async`, {
    body: mp.body,
    headers: { "Content-Type": mp.contentType },
    responseType: "text",
    timeout: 300000,
  });
  const j1 = JSON.parse(r1.responseText || "{}");
  if (j1.code !== 0)
    throw new Error(
      `OXR 提交失败: ${j1.msg || JSON.stringify(j1).slice(0, 200)}`,
    );
  const taskId = j1.data?.task_id || j1.task_id;
  if (!taskId) throw new Error("OXR 未返回 task_id");

  for (let i = 0; i < 120; i++) {
    await sleep(10000);
    const fq = buildMultipart({ api_key: apiKey, task_id: taskId });
    const rq = await Zotero.HTTP.request(
      "POST",
      `${oxrBase()}/parse/async_check`,
      {
        body: fq.body,
        headers: { "Content-Type": fq.contentType },
        responseType: "text",
        timeout: 60000,
      },
    );
    const jq = JSON.parse(rq.responseText || "{}");
    const state = String(jq?.data?.state || jq?.state || "").toLowerCase();
    progress.changeLine({
      text: `OXR 解析中（${state || "?"}，已等待 ${i * 10}s）`,
      progress: 40,
    });
    if (["done", "success", "completed"].includes(state)) {
      // 结果 JSON 结构以实际返回为准：优先取 markdown 字段
      const d = jq.data || jq;
      const mdText =
        d.markdown || d.result?.markdown || d.content?.markdown || "";
      if (!mdText) {
        await debugLog(
          `oxr result keys: ${Object.keys(d).join(",")}; 原文前 300: ${JSON.stringify(d).slice(0, 300)}`,
        );
        throw new Error(
          "OXR 结果中未找到 markdown 字段（结构见 zrb-debug.log，需适配）",
        );
      }
      return { md: mdText, images: [] }; // OXR 图片导出待首次真机返回后适配
    }
    if (["failed", "error"].includes(state)) {
      throw new Error(`OXR 解析失败: ${jq.msg || "未知"}`);
    }
  }
  throw new Error("OXR 解析超时（20 分钟）");
}

// ---- 服务商免费额度护栏 ----
// MinerU：每账号每天 1000 页最高优先级（docs/api-integration.md），按平均 20 页/篇 ≈ 50 篇
// OXR/SoMark：免费额度按页计（国内站实测 500 页/天），按平均 20 页/篇 ≈ 25 篇
export const FREE_DAILY_DEFAULT: Record<Engine, number> = {
  mineru: 50,
  oxr: 25,
};

export function defaultMaxDaily(engine?: string): number {
  return FREE_DAILY_DEFAULT[(engine as Engine) || "mineru"] ?? 25;
}

// 默认只走免费额度；勾选"允许超出免费额度"后不限篇数（仍受服务商总额度约束）
export function effectiveMaxDaily(): number {
  if (getBoolPref("allowPaidQuota")) return Number.MAX_SAFE_INTEGER;
  return defaultMaxDaily(primaryEngine());
}

// 引擎优先级：parseEngineOrder = "mineru,oxr" 或 "oxr,mineru"，只保留已填 Key 的
export function enginePriority(): Engine[] {
  const raw = getPref("parseEngineOrder") || getPref("parseEngine") || "mineru";
  const order = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Engine => s === "mineru" || s === "oxr");
  const unique = [...new Set(order)];
  for (const e of ["mineru", "oxr"] as Engine[])
    if (!unique.includes(e)) unique.push(e);
  return unique;
}

export function engineKey(engine: Engine): string {
  return engine === "mineru" ? getPref("mineruToken") : getPref("oxrApiKey");
}

export function primaryEngine(): Engine {
  return enginePriority().find((e) => engineKey(e)) || enginePriority()[0]!;
}

// 旧版本迁移：parseMaxDaily 数字上限废弃 → 免费额度开关；
// 同时清理旧代码（FormData 时代）留下的失效错误，让条目回到可重试状态
export function migrateDailyDefault(): void {
  if (getPref("parseQuotaMigrated2")) return;
  const legacy = parseInt(getPref("parseMaxDaily", "0"), 10);
  // 旧默认 20 视为未设置；用户显式设过大值（如 2000）视为愿意超额
  if (Number.isFinite(legacy) && legacy > 50) {
    Zotero.Prefs.set(
      `extensions.zotero.${config.addonRef}.allowPaidQuota`,
      true,
      true,
    );
  }
  setPref("parseMaxDaily", "");
  setPref("parseQuotaMigrated2", "true");
  void ledger.load().then(async () => {
    let cleaned = 0;
    for (const e of Object.values(ledger.get().entries)) {
      if (e.status === "not_parsed" && e.error?.includes("FormData")) {
        ledger.upsert({ attachmentKey: e.attachmentKey, error: null });
        cleaned++;
      }
    }
    if (cleaned) {
      await ledger.persist();
      await debugLog(`migrate: cleared ${cleaned} stale FormData errors`);
    }
  });
}

// ---- 主入口 ----
export async function preflightKey(
  engine: Engine,
  key: string,
  baseUrl?: string,
): Promise<{ ok: boolean; msg: string }> {
  try {
    if (engine === "oxr") {
      const mp = buildMultipart({ api_key: key });
      const r = await Zotero.HTTP.request(
        "POST",
        `${baseUrl || oxrBase()}/usage`,
        {
          body: mp.body,
          headers: { "Content-Type": mp.contentType },
          responseType: "text",
          timeout: 30000,
        },
      );
      const j = JSON.parse(r.responseText || "{}");
      if (j.code !== 0)
        return {
          ok: false,
          msg: `OXR Key 无效（code=${j.code} ${j.msg || ""}）`,
        };
      const d = j.data || {};
      const quota = `今日免费余 ${d.remaining_free_pages_today ?? "?"} 页 / 本月余 ${d.remaining_free_pages_this_month ?? "?"} 页`;
      return { ok: true, msg: `OXR Key 有效（${quota}）` };
    }
    // mineru：空批量探测（有效="file list is empty"，过期=A0211）
    const r = await Zotero.HTTP.request(
      "POST",
      `${MINERU_BASE}/file-urls/batch`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ files: [] }),
        responseType: "text",
        timeout: 30000,
      },
    );
    const j = JSON.parse(r.responseText || "{}");
    if (j.msgCode === "A0211")
      return { ok: false, msg: "MinerU Token 已过期，请到 API 管理页重新生成" };
    if (j.msgCode === "A0202") return { ok: false, msg: "MinerU Token 错误" };
    return { ok: true, msg: "MinerU Token 有效" };
  } catch (e: any) {
    return { ok: false, msg: `Key 预检请求失败：${e?.message || e}` };
  }
}

export async function parseMissing(): Promise<void> {
  await task.runTask(async (progress) => {
    const result = await runParse(progress as any, undefined, false);
    if (result.message)
      task.showResult({ ok: result.failed === 0, message: result.message });
  });
}

export async function parseEntries(
  keys: string[],
  progress: { changeLine: (o: { text?: string; progress?: number }) => void },
): Promise<task.WorkSummary & { message?: string }> {
  await ledger.load();
  const keySet = new Set(keys);
  const targets = Object.values(ledger.get().entries).filter((e) =>
    keySet.has(e.attachmentKey),
  );
  if (
    !targets.length ||
    targets.some(
      (e) =>
        ![
          "parsed",
          "exported",
          "queued_upload",
          "uploaded",
          "indexed_verified",
          "sync_failed",
        ].includes(e.status),
    )
  ) {
    return runParse(progress, keys, false);
  }
  let succeeded = 0;
  let failed = 0;
  for (const e of targets) {
    const att = e.attachmentId ? Zotero.Items.get(e.attachmentId) : null;
    if (!att) {
      failed++;
      continue;
    }
    await exporter.exportAttachments([att], e.title || e.attachmentKey);
    const updated = ledger.entry(e.attachmentKey);
    if (updated?.status === "export_failed") failed++;
    else succeeded++;
  }
  const message = `解析结果已就绪：成功导出 ${succeeded} 篇，失败 ${failed} 篇`;
  progress.changeLine({ text: message, progress: 100 });
  return { attempted: targets.length, succeeded, failed, message };
}

async function runParse(
  progress: ProgressReporter,
  requestedKeys?: string[],
  lockBusy = true,
): Promise<task.WorkSummary & { message?: string }> {
  await debugLog("parse: clicked");
  const d = addon.data as any;
  if (lockBusy && d.zrbBusy) {
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({ text: "ZRB 已有任务在运行", type: "fail", progress: 100 })
      .startCloseTimer(5000);
    return { attempted: 0, succeeded: 0, failed: 0 };
  }
  // 按优先级取第一个已填 Key 的引擎；解析中失败自动降级到下一个
  const candidates = enginePriority().filter((e) => engineKey(e));
  if (!candidates.length) {
    const message = "请先在设置页填写至少一个引擎的 API Key（MinerU 或 OXR）";
    await debugLog("parse abort: no engine key");
    progress.changeLine({ text: message, progress: 100 });
    return { attempted: 0, succeeded: 0, failed: 0, message };
  }
  const engine = candidates[0]!;
  // 费用护栏：首次确认
  if (!getBoolPref("parseConfirmed")) {
    const win = Zotero.getMainWindow();
    let ok = true;
    try {
      ok = !!win.confirm(
        "即将调用解析 API（MinerU/OXR）。\n\n" +
          "· 默认只使用服务商每日免费额度\n" +
          "· 仅解析待处理条目，已有缓存不重复解析\n" +
          "· 可在设置页允许超出免费额度\n\n确认继续？",
      );
    } catch (_) {
      ok = true;
    }
    if (!ok) {
      await debugLog("parse: user cancelled");
      return { attempted: 0, succeeded: 0, failed: 0 };
    }
    setPref("parseConfirmed", "true");
  }
  const pf = await preflightKey(engine, engineKey(engine));
  await debugLog(`parse preflight(${engine}): ${pf.msg}`);
  if (!pf.ok) {
    progress.changeLine({ text: pf.msg, progress: 100 });
    return { attempted: 0, succeeded: 0, failed: 0, message: pf.msg };
  }
  const maxDaily = effectiveMaxDaily();
  const unlimited = getBoolPref("allowPaidQuota");
  const quota = dailyCheck(maxDaily);
  if (!quota.allowed) {
    const message = `已达今日免费额度（约 ${maxDaily} 篇，已用 ${quota.used}），明日自动恢复；如需继续可在设置页开启"允许超出免费额度"`;
    progress.changeLine({ text: message, progress: 100 });
    return { attempted: 0, succeeded: 0, failed: 0, message };
  }

  await ledger.load();
  const requested = requestedKeys ? new Set(requestedKeys) : null;
  const targets = Object.values(ledger.get().entries).filter(
    (e) =>
      (!requested || requested.has(e.attachmentKey)) &&
      (requested ? e.status !== "parsing" : e.status === "not_parsed"),
  );
  if (!targets.length) {
    const message = "没有待解析条目（全部有缓存或已解析）";
    progress.changeLine({ text: message, progress: 100 });
    return { attempted: 0, succeeded: 0, failed: 0, message };
  }
  const budget = Math.min(targets.length, maxDaily - quota.used);
  const ok = win2Confirm(
    unlimited
      ? `本次将解析 ${budget} 篇（已允许超出免费额度，可能产生费用）。继续？`
      : `本次将解析 ${budget} 篇（今日免费额度已用 ${quota.used}/${maxDaily}）。继续？`,
  );
  if (!ok) return { attempted: 0, succeeded: 0, failed: 0 };

  if (lockBusy) d.zrbBusy = true;
  let done = 0;
  let failed = 0;
  try {
    for (const e of targets.slice(0, budget)) {
      progress.changeLine({
        text: `准备解析：${e.title || e.attachmentKey}`,
        progress: Math.round(((done + failed) / budget) * 100),
      });
      try {
        const att = e.attachmentId ? Zotero.Items.get(e.attachmentId) : null;
        if (!att) throw new Error("附件不存在");
        const path = await (att as any).getFilePathAsync?.();
        if (!path || !(await IOUtils.exists(path)))
          throw new Error("PDF 本地文件不存在");
        const pdfBytes = await IOUtils.read(path);
        const filename = PathUtils.filename(path) || `${e.attachmentKey}.pdf`;
        ledger.upsert({
          attachmentKey: e.attachmentKey,
          status: "parsing",
          error: null,
        });
        await ledger.persist();

        const parts = await splitPdfForParsing(pdfBytes, filename);
        const merged: {
          md: string;
          images: { name: string; bytes: Uint8Array }[];
        } = { md: "", images: [] };
        // 逐引擎尝试：首选失败（如 Key 失效/额度耗尽）自动降级到优先级中的下一个
        let usedEngine: Engine | null = null;
        let lastErr: any = null;
        for (const cand of candidates) {
          try {
            merged.md = "";
            merged.images = [];
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i]!;
              if (parts.length > 1) {
                progress.changeLine({
                  text: `分卷 ${i + 1}/${parts.length}：第 ${part.firstPage}–${part.lastPage} 页`,
                  progress: Math.round(
                    ((done + failed + i / parts.length) / budget) * 100,
                  ),
                });
              }
              const result =
                cand === "mineru"
                  ? await mineruParse(
                      engineKey(cand),
                      part.bytes,
                      part.filename,
                      progress,
                    )
                  : await oxrParse(
                      engineKey(cand),
                      part.bytes,
                      part.filename,
                      progress,
                    );
              merged.md +=
                (parts.length > 1
                  ? `\n\n<!-- ZRB 分卷：第 ${part.firstPage}–${part.lastPage} 页 -->\n\n`
                  : "") + result.md;
              merged.images.push(...result.images);
            }
            usedEngine = cand;
            break;
          } catch (err: any) {
            lastErr = err;
            await debugLog(
              `parse engine ${cand} failed for ${e.attachmentKey}: ${err?.message || err}`,
            );
            if (candidates.length > 1 && cand !== candidates[candidates.length - 1]) {
              progress.changeLine({
                text: `${cand} 解析失败，切换到备用引擎重试…`,
                progress: Math.round(((done + failed) / budget) * 100),
              });
            }
          }
        }
        if (!usedEngine) throw lastErr || new Error("所有引擎均解析失败");

        // 落盘：zrb-cache/<attachmentId>/
        const cdir = PathUtils.join(
          Zotero.DataDirectory.dir,
          "zrb-cache",
          String(e.attachmentId),
        );
        await Zotero.File.createDirectoryIfMissing(
          PathUtils.join(cdir, "images"),
        );
        await IOUtils.writeUTF8(PathUtils.join(cdir, "full.md"), merged.md);
        for (const img of merged.images) {
          const digest = md5(img.bytes).slice(0, 16);
          const ext = (img.name.match(
            /\.(jpe?g|png|gif|bmp|webp|svg|tiff?)$/i,
          ) || ["", ".jpg"])[1]!.toLowerCase();
          await IOUtils.write(
            PathUtils.join(cdir, "images", digest + ext),
            img.bytes,
          );
        }
        ledger.upsert({
          attachmentKey: e.attachmentKey,
          status: "parsed",
          parseEngine:
            parts.length > 1
              ? `${usedEngine}（${parts.length} 分卷）`
              : usedEngine,
          parseTime: new Date().toISOString(),
          error: null,
        });
        dailyIncr(1);
        done++;
      } catch (err: any) {
        failed++;
        ledger.upsert({
          attachmentKey: e.attachmentKey,
          status: "not_parsed",
          error: `解析失败: ${err?.message || err}`,
        });
        await debugLog(`parse fail ${e.attachmentKey}: ${err?.message || err}`);
      }
      await ledger.persist();
      progress.changeLine({
        text: `解析 ${done + failed}/${budget}（成功 ${done}，失败 ${failed}）`,
        progress: Math.round(((done + failed) / Math.max(1, budget)) * 100),
      });
    }
    const message = `解析完成：成功 ${done}，失败 ${failed}。可继续导出并同步到知识胶囊`;
    progress.changeLine({
      text: message,
      type: failed ? "fail" : "success",
      progress: 100,
    });
    await debugLog(`parse done: engine=${engine} ok=${done} fail=${failed}`);
    return { attempted: done + failed, succeeded: done, failed, message };
  } finally {
    if (lockBusy) d.zrbBusy = false;
  }
}

function win2Confirm(text: string): boolean {
  const win = Zotero.getMainWindow();
  return win.confirm(text);
}
