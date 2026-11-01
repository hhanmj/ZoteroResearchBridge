// 解析引擎（P3.5）：OXR / MinerU API 直连
// 设计要点：
//  - 费用护栏：首次使用需确认（parseConfirmed）、每日上限（parseMaxDaily）、启动前查询余额（OXR）
//  - 结果落盘：zrb-cache/<attachmentId>/（full.md + images/），随后复用导出管线
//  - 状态机：not_parsed → parsing → parsed → (导出) exported

import { config } from "../../package.json";
import * as ledger from "./ledger";
import { md5 } from "./md5";

const MINERU_BASE = "https://mineru.net/api/v4";

// 插件沙箱无 FormData 全局 → 手工构建 multipart/form-data 字节体
function buildMultipart(
  fields: Record<string, string>,
  file?: { field: string; filename: string; bytes: Uint8Array; contentType?: string },
): { body: Uint8Array; contentType: string } {
  const boundary = "----ZRBForm" + Math.random().toString(16).slice(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`,
    ));
    parts.push(file.bytes);
    parts.push(enc.encode(`\r\n`));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
// OXR 部署分国内/国际站：国内用户 Key 来自 somark.cn，Base URL 可在设置页改
const OXR_BASE_DEFAULT = "https://somark.cn/api/v1";

function oxrBase(): string {
  return getPref("oxrBaseUrl") || OXR_BASE_DEFAULT;
}

export type Engine = "mineru" | "oxr";

function getPref(name: string, dflt = ""): string {
  try {
    return ((Zotero.Prefs.get(`extensions.zotero.${config.addonRef}.${name}`, true) as string) || dflt);
  } catch (_) {
    return dflt;
  }
}

function getBoolPref(name: string): boolean {
  try {
    return (Zotero.Prefs.get(`extensions.zotero.${config.addonRef}.${name}`, true) as boolean) === true;
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
    const p = PathUtils.join(Zotero.DataDirectory.dir, "zrb-export", "zrb-debug.log");
    const prev = (await IOUtils.exists(p)) ? await IOUtils.readUTF8(p) : "";
    await IOUtils.writeUTF8(p, prev + line);
  } catch (_) { /* ignore */ }
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
function extractZip(zipPath: string, destDir: string): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const CC = Components.classes as any;
    const CI = Components.interfaces as any;
    const zip = CC["@mozilla.org/zip;1"]
    .createInstance(CI.nsIZipReader);
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
        const bis: any = CC["@mozilla.org/binaryinputstream;1"].createInstance(CI.nsIBinaryInputStream);
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
  token: string, pdfBytes: Uint8Array, filename: string,
  progress: { changeLine: (o: any) => void },
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: applyBody,
    responseType: "text",
    timeout: 60000,
  });
  const j1 = JSON.parse(r1.responseText || "{}");
  if (j1.code !== 0) throw new Error(`MinerU 申请上传链接失败: ${j1.msg || (r1.responseText || "").slice(0, 200)}`);
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
    progress.changeLine({ text: `MinerU 解析中（${state || "?"}，已等待 ${i * 10}s）`, progress: 40 });
    if (state === "done") {
      const zipUrl = item.full_zip_url as string;
      const zr = await Zotero.HTTP.request("GET", zipUrl, { responseType: "text", timeout: 300000 });
      // responseType text + binary zip → 需要 arraybuffer；改用二进制请求
      const zrBin = await Zotero.HTTP.request("GET", zipUrl, { responseType: "arraybuffer", timeout: 300000 });
      void zr;
      const zipBytes = new Uint8Array(zrBin.response as ArrayBuffer);
      const zipPath = PathUtils.join(Zotero.DataDirectory.dir, "zrb-export", `mineru-${batchId}.zip`);
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
  apiKey: string, pdfBytes: Uint8Array, filename: string,
  progress: { changeLine: (o: any) => void },
): Promise<{ md: string; images: { name: string; bytes: Uint8Array }[] }> {
  const mp = buildMultipart({ api_key: apiKey }, {
    field: "file", filename, bytes: pdfBytes, contentType: "application/pdf",
  });
  const r1 = await Zotero.HTTP.request("POST", `${oxrBase()}/parse/async`, {
    body: mp.body, headers: { "Content-Type": mp.contentType },
    responseType: "text",
    timeout: 300000,
  });
  const j1 = JSON.parse(r1.responseText || "{}");
  if (j1.code !== 0) throw new Error(`OXR 提交失败: ${j1.msg || JSON.stringify(j1).slice(0, 200)}`);
  const taskId = j1.data?.task_id || j1.task_id;
  if (!taskId) throw new Error("OXR 未返回 task_id");

  for (let i = 0; i < 120; i++) {
    await sleep(10000);
    const fq = buildMultipart({ api_key: apiKey, task_id: taskId });
    const rq = await Zotero.HTTP.request("POST", `${oxrBase()}/parse/async_check`, {
      body: fq.body, headers: { "Content-Type": fq.contentType },
      responseType: "text",
      timeout: 60000,
    });
    const jq = JSON.parse(rq.responseText || "{}");
    const state = String(jq?.data?.state || jq?.state || "").toLowerCase();
    progress.changeLine({ text: `OXR 解析中（${state || "?"}，已等待 ${i * 10}s）`, progress: 40 });
    if (["done", "success", "completed"].includes(state)) {
      // 结果 JSON 结构以实际返回为准：优先取 markdown 字段
      const d = jq.data || jq;
      const mdText = d.markdown || d.result?.markdown || d.content?.markdown || "";
      if (!mdText) {
        await debugLog(`oxr result keys: ${Object.keys(d).join(",")}; 原文前 300: ${JSON.stringify(d).slice(0, 300)}`);
        throw new Error("OXR 结果中未找到 markdown 字段（结构见 zrb-debug.log，需适配）");
      }
      return { md: mdText, images: [] }; // OXR 图片导出待首次真机返回后适配
    }
    if (["failed", "error"].includes(state)) {
      throw new Error(`OXR 解析失败: ${jq.msg || "未知"}`);
    }
  }
  throw new Error("OXR 解析超时（20 分钟）");
}

// ---- 主入口 ----
async function preflightKey(engine: Engine, key: string): Promise<{ ok: boolean; msg: string }> {
  try {
    if (engine === "oxr") {
      const mp = buildMultipart({ api_key: key });
      const r = await Zotero.HTTP.request("POST", `${oxrBase()}/usage`, {
        body: mp.body, headers: { "Content-Type": mp.contentType },
        responseType: "text", timeout: 30000,
      });
      const j = JSON.parse(r.responseText || "{}");
      if (j.code !== 0) return { ok: false, msg: `OXR Key 无效（code=${j.code} ${j.msg || ""}）` };
      const d = j.data || {};
      const quota = `今日免费余 ${d.remaining_free_pages_today ?? "?"} 页 / 本月余 ${d.remaining_free_pages_this_month ?? "?"} 页`;
      return { ok: true, msg: `OXR Key 有效（${quota}）` };
    }
    // mineru：空批量探测（有效="file list is empty"，过期=A0211）
    const r = await Zotero.HTTP.request("POST", `${MINERU_BASE}/file-urls/batch`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ files: [] }),
      responseType: "text",
      timeout: 30000,
    });
    const j = JSON.parse(r.responseText || "{}");
    if (j.msgCode === "A0211") return { ok: false, msg: "MinerU Token 已过期，请到 API 管理页重新生成" };
    if (j.msgCode === "A0202") return { ok: false, msg: "MinerU Token 错误" };
    return { ok: true, msg: "MinerU Token 有效" };
  } catch (e: any) {
    return { ok: false, msg: `Key 预检请求失败：${e?.message || e}` };
  }
}

export async function parseMissing(): Promise<void> {
  await debugLog("parse: clicked");
  const d = addon.data as any;
  if (d.zrbBusy) {
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({ text: "ZRB 已有任务在运行", type: "fail", progress: 100 })
      .startCloseTimer(5000);
    return;
  }
  const engine = getPref("parseEngine") as Engine;
  const oxrKey = getPref("oxrApiKey");
  const mineruToken = getPref("mineruToken");
  if (!engine || (engine === "oxr" && !oxrKey) || (engine === "mineru" && !mineruToken)) {
    await debugLog(`parse abort: engine=${engine || "（空）"} oxrKey=${oxrKey ? "有" : "无"} mineruToken=${mineruToken ? "有" : "无"}`);
    const pw0 = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true });
    pw0.createLine({ text: "请先在设置页选择解析引擎（下拉框）并填写对应 API Key", type: "fail", progress: 100 });
    pw0.show();
    pw0.startCloseTimer(15000);
    return;
  }
  // 费用护栏：首次确认
  if (!getBoolPref("parseConfirmed")) {
    const win = Zotero.getMainWindow();
    let ok = true;
    try {
      ok = !!(win as any).confirm(
        "即将调用付费解析 API（OXR/MinerU）。\n\n" +
        "· 每篇 PDF 会消耗你的 API 额度\n" +
        "· 仅解析【无本地 MinerU 缓存】的条目\n" +
        "· 每日上限可在设置页调整\n\n确认继续？",
      );
    } catch (_) { ok = true; }
    if (!ok) {
      await debugLog("parse: user cancelled");
      return;
    }
    setPref("parseConfirmed", "true");
  }
  const pf = await preflightKey(engine, engine === "oxr" ? oxrKey : mineruToken);
  await debugLog(`parse preflight(${engine}): ${pf.msg}`);
  if (!pf.ok) {
    const pwK = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true });
    pwK.createLine({ text: pf.msg, type: "fail", progress: 100 });
    pwK.show();
    pwK.startCloseTimer(15000);
    return;
  }
  const maxDaily = parseInt(getPref("parseMaxDaily", "20"), 10) || 20;
  const quota = dailyCheck(maxDaily);
  if (!quota.allowed) {
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({ text: `已达今日解析上限 ${maxDaily} 篇（已用 ${quota.used}），明日自动恢复`, type: "fail", progress: 100 })
      .startCloseTimer(8000);
    return;
  }

  await ledger.load();
  const targets = Object.values(ledger.get().entries).filter((e) => e.status === "not_parsed");
  if (!targets.length) {
    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({ text: "没有待解析条目（全部有缓存或已解析）", type: "default", progress: 100 })
      .startCloseTimer(6000);
    return;
  }
  const budget = Math.min(targets.length, maxDaily - quota.used);
  const ok = win2Confirm(`本次将解析 ${budget} 篇（今日已用 ${quota.used}/${maxDaily}）。继续？`);
  if (!ok) return;

  d.zrbBusy = true;
  const progress = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: false })
    .createLine({ text: `ZRB 解析（${engine}）`, type: "default", progress: 0 })
    .show();
  let done = 0;
  let failed = 0;
  try {
    for (const e of targets.slice(0, budget)) {
      try {
        const att = e.attachmentId ? Zotero.Items.get(e.attachmentId) : null;
        if (!att) throw new Error("附件不存在");
        const path = await (att as any).getFilePathAsync?.();
        if (!path || !(await IOUtils.exists(path))) throw new Error("PDF 本地文件不存在");
        const pdfBytes = await IOUtils.read(path);
        const filename = PathUtils.filename(path) || `${e.attachmentKey}.pdf`;
        ledger.upsert({ attachmentKey: e.attachmentKey, status: "parsing" });
        await ledger.persist();

        const result = engine === "mineru"
          ? await mineruParse(mineruToken, pdfBytes, filename, progress)
          : await oxrParse(oxrKey, pdfBytes, filename, progress);

        // 落盘：zrb-cache/<attachmentId>/
        const cdir = PathUtils.join(Zotero.DataDirectory.dir, "zrb-cache", String(e.attachmentId));
        await Zotero.File.createDirectoryIfMissing(PathUtils.join(cdir, "images"));
        await IOUtils.writeUTF8(PathUtils.join(cdir, "full.md"), result.md);
        for (const img of result.images) {
          const digest = md5(img.bytes).slice(0, 16);
          const ext = (img.name.match(/\.(jpe?g|png|gif|bmp|webp|svg|tiff?)$/i) || ["", ".jpg"])[1]!.toLowerCase();
          await IOUtils.write(PathUtils.join(cdir, "images", digest + ext), img.bytes);
        }
        ledger.upsert({
          attachmentKey: e.attachmentKey,
          status: "parsed",
          parseEngine: engine,
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
        text: `解析 ${done + failed}/${Math.min(targets.length, budget)}（成功 ${done}，失败 ${failed}）`,
        progress: Math.round(((done + failed) / Math.max(1, budget)) * 100),
      });
    }
    progress.changeLine({
      text: `解析完成：成功 ${done}，失败 ${failed}。下一步：工具 → 导出全库缺失`,
      type: failed ? "fail" : "success",
      progress: 100,
    });
    progress.startCloseTimer(10000);
    await debugLog(`parse done: engine=${engine} ok=${done} fail=${failed}`);
  } finally {
    d.zrbBusy = false;
  }
}

function win2Confirm(text: string): boolean {
  const win = Zotero.getMainWindow();
  return win.confirm(text);
}
