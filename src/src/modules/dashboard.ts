import * as ledger from "./ledger";
import * as parser from "./parser";
import * as exporter from "./exporter";
import * as sync from "./sync";
import * as task from "./task";
import { isWindowAlive } from "../utils/window";
import { sidebarMarkup } from "./sidebarMarkup";

type Filter =
  | "all"
  | "pending"
  | "parsing"
  | "parsed"
  | "ready"
  | "synced"
  | "failed";

let dashboardWindow: Window | null = null;
const sidebarBodies = new Set<any>();
const bodyHosts = new Map<any, HTMLElement>();
let registeredPaneID: string | false = false;
let filter: Filter = "all";
let query = "";
let sort = "attention";
let scanBusy = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function openDashboard(): Promise<void> {
  const win = Zotero.getMainWindow();
  if (!registeredPaneID) registerSidebar();
  const body = [...sidebarBodies].find((b) => b.ownerDocument === win.document);
  const host = body ? bodyHosts.get(body) : undefined;
  if (!body) {
    const items = (win.ZoteroPane.itemsView as any)?.getSelectedItems() || [];
    if (!items.length) {
      const all = (await Zotero.Items.getAll(1, true, false, false)) as any;
      const regular = Array.isArray(all)
        ? all.find((it: any) => it.isRegularItem())
        : null;
      if (regular) {
        await win.ZoteroPane.selectItem(regular.id);
        for (let i = 0; i < 50 && !sidebarBodies.size; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return openDashboard();
      }
    }
  }
  const section = (body?.closest("item-pane-custom-section") ||
    [...win.document.querySelectorAll("item-pane-custom-section")].find(
      (n) => n.getAttribute("data-pane") === registeredPaneID,
    )) as any;
  if (section)
    bodyHosts.set(
      body || section,
      bodyHosts.get(body) || section.querySelector("#zrb-app"),
    );
  const paneID = section?.getAttribute("data-pane");
  if (paneID) {
    const navButton = [
      ...win.document.querySelectorAll("#zotero-view-item-sidenav [data-pane]"),
    ].find((n) => n.getAttribute("data-pane") === paneID) as any;
    navButton?.click();
    section?.scrollIntoView({ block: "start" });
    (
      win.document.getElementById("zotero-item-details") as any
    )?.renderCustomSections?.();
  }
  if (body) void render(false, host);
}

function mountMarkup(doc: Document): HTMLElement {
  const xml = `<div xmlns="http://www.w3.org/1999/xhtml">${sidebarMarkup}</div>`;
  const parsed = new (doc.defaultView as any).DOMParser().parseFromString(
    xml,
    "application/xml",
  );
  if (parsed.querySelector("parsererror"))
    throw new Error("侧栏 XHTML 解析失败");
  return doc.importNode(parsed.documentElement, true) as HTMLElement;
}

export function registerSidebar(): string | false {
  if (registeredPaneID) return registeredPaneID;
  const existing = (
    Zotero.ItemPaneManager as any
  ).customSectionData?.options?.find(
    (o: any) =>
      o.pluginID === addon.data.config.addonID &&
      o.paneID.endsWith("zrb-parsing-dashboard"),
  );
  if (existing) return (registeredPaneID = existing.paneID);
  registeredPaneID = Zotero.ItemPaneManager.registerSection({
    paneID: "zrb-parsing-dashboard",
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: "zrb-sidebar-title",
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    },
    sidenav: {
      l10nID: "zrb-sidebar-tooltip",
      icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
    },
    onInit: ({ setEnabled }) => setEnabled(true),
    onRender: ({ body, doc }) => {
      if (bodyHosts.has(body)) return;
      const link = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "link",
      ) as HTMLLinkElement;
      link.rel = "stylesheet";
      link.href = `chrome://${addon.data.config.addonRef}/content/dashboard.css`;
      body.appendChild(link);
      const host = mountMarkup(doc);
      body.appendChild(host);
      body.classList.add("zrb-sidebar-body");
      sidebarBodies.add(body);
      bodyHosts.set(body, host);
      const win = doc.defaultView as Window;
      onLoad(win, body).catch((e) => Zotero.logError(e));
    },
    onItemChange: ({ setEnabled }) => setEnabled(true),
    onDestroy: ({ body }) => {
      sidebarBodies.delete(body);
      bodyHosts.delete(body);
      if (dashboardWindow === body.ownerDocument?.defaultView)
        dashboardWindow = null;
    },
  });
  return registeredPaneID;
}

async function onLoad(win: Window, host?: HTMLElement): Promise<void> {
  dashboardWindow = win;
  (globalThis as any).zrbDashboardProgress = (report: (info: any) => void) => {
    if (!isWindowAlive(win) || (host && !host.isConnected)) return;
    const info: any = { title: "正在处理", detail: "", progress: 0 };
    report(info);
    if (info.refresh) {
      void render(false, host);
      return;
    }
    updateTask(win, info, host);
  };
  if (host) {
    bind(win, host);
  } else {
    bind(win);
  }
  await render(true, host);
  refreshTimer = setInterval(() => {
    if (!task.isBusy() && isWindowAlive(win)) void render();
  }, 15000);
  win.addEventListener(
    "unload",
    () => {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
      if ((globalThis as any).zrbDashboardProgress)
        delete (globalThis as any).zrbDashboardProgress;
      if (dashboardWindow === win) dashboardWindow = null;
    },
    { once: true },
  );
}

function el<T = any>(win: Window, id: string, host?: ParentNode): T {
  return (host || win.document).querySelector(`#${id}`) as T;
}

function bind(win: Window, host?: HTMLElement): void {
  const listen = (id: string, event: string, fn: (ev: Event) => void) => {
    el(win, id, host).addEventListener(event, fn);
  };
  listen("zrb-refresh", "click", () => void render(true));
  listen("zrb-parse", "click", () => void parsePending());
  listen("zrb-export", "click", () => void exportPending());
  listen("zrb-sync", "click", () => void syncPending());
  listen("zrb-settings", "click", () => {
    void import("./settings").then((m) => m.openSettings());
  });
  listen("zrb-search", "input", (ev) => {
    query = ((ev.target as any).value || "").trim().toLowerCase();
    renderList(win, host);
  });
  listen("zrb-sort", "change", (ev) => {
    sort = (ev.target as any).value;
    renderList(win, host);
  });
  (host || win.document)
    .querySelectorAll("[data-filter]")
    .forEach((node: any) => {
      node.addEventListener("click", () =>
        setFilter(node.dataset.filter, host),
      );
    });
}

function setFilter(value: Filter, host?: HTMLElement): void {
  filter = value;
  if (dashboardWindow) renderList(dashboardWindow, host);
}

export async function mountForTest(body: HTMLElement): Promise<void> {
  const doc = body.ownerDocument as Document;
  const win = doc.defaultView as Window;
  const host = mountMarkup(doc);
  body.appendChild(host);
  bodyHosts.set(body, host);
  await onLoad(win, host);
}

export async function render(scan = false, host?: HTMLElement): Promise<void> {
  const win = dashboardWindow as Window;
  if (!isWindowAlive(win || undefined)) return;
  if (scan && !scanBusy && !task.isBusy()) {
    scanBusy = true;
    try {
      await scanLibrary();
    } catch (e: any) {
      Zotero.logError(e);
    } finally {
      scanBusy = false;
    }
  }
  await ledger.load();
  const entries = Object.values(ledger.get().entries);
  const count = (f: Filter) => entries.filter((e) => matches(e, f)).length;
  for (const f of [
    "all",
    "pending",
    "parsing",
    "parsed",
    "ready",
    "synced",
    "failed",
  ] as Filter[]) {
    el(win, `zrb-count-${f}`, host).textContent = String(count(f));
  }
  const parsed = count("parsed");
  const synced = count("synced");
  const pending = count("pending");
  el(win, "zrb-total", host).textContent = String(entries.length);
  el(win, "zrb-parsed", host).textContent = String(parsed);
  el(win, "zrb-synced", host).textContent = String(synced);
  el(win, "zrb-pending", host).textContent = String(pending);
  el(win, "zrb-parsed-note", host).textContent = entries.length
    ? `解析覆盖率 ${Math.round((parsed / entries.length) * 100)}%`
    : "尚未发现 PDF";
  el(win, "zrb-flow-total", host).textContent = `${entries.length} 个附件`;
  el(win, "zrb-flow-parsed", host).textContent = `${parsed} 篇全文已就绪`;
  el(win, "zrb-flow-synced", host).textContent = `${synced} 篇已校验上传`;
  el(win, "zrb-flow-parse", host).style.width =
    `${entries.length ? (parsed / entries.length) * 100 : 0}%`;
  el(win, "zrb-flow-sync", host).style.width =
    `${parsed ? (synced / parsed) * 100 : 0}%`;
  el(win, "zrb-synced-note", host).textContent =
    `同步覆盖率 ${parsed ? Math.round((synced / parsed) * 100) : 0}% · 数据胶囊`;
  el(win, "zrb-parse", host).disabled = pending === 0 || task.isBusy();
  el(win, "zrb-parse", host).textContent = pending
    ? `▷ 解析待处理文献（${pending}）`
    : "✓ 全部文献已解析";
  el(win, "zrb-sync", host).disabled = count("ready") === 0 || task.isBusy();
  el(win, "zrb-footer-text", host).textContent =
    `本地账本 · ${entries.length} 条记录 · 更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  renderList(win, host);
}

function matches(e: ledger.LedgerEntry, f: Filter): boolean {
  switch (f) {
    case "all":
      return true;
    case "pending":
      return e.status === "not_parsed";
    case "parsing":
      return e.status === "parsing";
    case "parsed":
      return [
        "parsed",
        "exported",
        "queued_upload",
        "uploaded",
        "indexed_verified",
        "sync_failed",
      ].includes(e.status);
    case "ready":
      return ["exported", "queued_upload", "sync_failed"].includes(e.status);
    case "synced":
      return e.status === "uploaded" || e.status === "indexed_verified";
    case "failed":
      return (
        e.status === "export_failed" || e.status === "sync_failed" || !!e.error
      );
  }
}

function renderList(win: Window, host?: HTMLElement): void {
  const all = Object.values(ledger.get().entries);
  const visible = all.filter(
    (e) =>
      matches(e, filter) &&
      (!query ||
        `${e.title || ""} ${e.doi || ""} ${e.attachmentKey} ${e.year || ""}`
          .toLowerCase()
          .includes(query)),
  );
  visible.sort((a, b) => {
    if (sort === "title")
      return (a.title || a.attachmentKey).localeCompare(
        b.title || b.attachmentKey,
        "zh-CN",
      );
    if (sort === "year") return (b.year || "0").localeCompare(a.year || "0");
    if (sort === "recent")
      return (b.uploadedAt || b.exportedAt || b.parseTime || "").localeCompare(
        a.uploadedAt || a.exportedAt || a.parseTime || "",
      );
    return (
      attention(a) - attention(b) ||
      (a.title || a.attachmentKey).localeCompare(
        b.title || b.attachmentKey,
        "zh-CN",
      )
    );
  });
  (host || win.document)
    .querySelectorAll(".zrb-nav-item")
    .forEach((node: any) => {
      node.classList.toggle("zrb-active", node.dataset.filter === filter);
    });
  const titles: Record<Filter, string> = {
    all: "全部文献",
    pending: "待解析",
    parsing: "解析中",
    parsed: "已解析",
    ready: "待同步",
    synced: "已同步",
    failed: "需关注",
  };
  el(win, "zrb-list-title", host).textContent = titles[filter];
  el(win, "zrb-list-count", host).textContent =
    `显示 ${visible.length} / ${all.length} 篇`;
  const list = el(win, "zrb-items", host);
  list.textContent = "";
  const limit = 150;
  for (const entry of visible.slice(0, limit))
    list.appendChild(itemRow(win, entry));
  if (!visible.length) {
    const empty = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as any;
    empty.className = "zrb-empty";
    const strong = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "strong",
    );
    strong.textContent = query ? "没有匹配的文献" : "这里暂时没有文献";
    const p = win.document.createElementNS("http://www.w3.org/1999/xhtml", "p");
    p.textContent = query
      ? "试试其他标题、DOI 或附件 Key"
      : filter === "pending"
        ? "所有文献均已完成解析"
        : "点击上方刷新状态，扫描本地文献";
    empty.append(strong, p);
    list.appendChild(empty);
  } else if (visible.length > limit) {
    const more = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    more.className = "zrb-empty";
    more.textContent = `其余 ${visible.length - limit} 篇请通过搜索或筛选查看`;
    list.appendChild(more);
  }
}

function attention(e: ledger.LedgerEntry): number {
  if (e.status === "parsing") return 0;
  if (e.status === "sync_failed" || e.status === "export_failed") return 1;
  if (e.status === "not_parsed") return 2;
  if (e.status === "exported" || e.status === "queued_upload") return 3;
  return 4;
}

function itemRow(win: Window, e: ledger.LedgerEntry): Element {
  const ns = "http://www.w3.org/1999/xhtml";
  const row = win.document.createElementNS(ns, "div") as any;
  row.className = "zrb-item";
  const paper = win.document.createElementNS(ns, "div") as any;
  paper.className = "zrb-paper-info";
  paper.style.minWidth = "0";
  const title = win.document.createElementNS(ns, "div");
  title.className = "zrb-paper-title";
  title.textContent = e.title || e.attachmentKey;
  (title as any).title = e.title || e.attachmentKey;
  const meta = win.document.createElementNS(ns, "div");
  meta.className = "zrb-paper-meta";
  meta.textContent = `${e.year || "年份未知"} · ${e.attachmentKey}${e.doi ? " · " + e.doi : ""}`;
  paper.append(title, meta);
  row.appendChild(paper);
  const parsed = [
    "parsed",
    "exported",
    "queued_upload",
    "uploaded",
    "indexed_verified",
    "sync_failed",
  ].includes(e.status);
  row.appendChild(
    badge(
      win,
      e.status === "parsing"
        ? "解析中"
        : e.status === "export_failed"
          ? "导出失败"
          : parsed
            ? "已解析"
            : e.error
              ? "解析失败"
              : "待解析",
      e.status === "parsing"
        ? "info"
        : e.status === "export_failed" || e.error
          ? "error"
          : parsed
            ? "ok"
            : "wait",
    ),
  );
  row.appendChild(
    badge(
      win,
      e.status === "indexed_verified"
        ? "知识库已验证"
        : e.status === "uploaded"
          ? "已同步 ✓"
          : e.status === "sync_failed"
            ? "同步失败"
            : ["exported", "queued_upload"].includes(e.status)
              ? "待同步"
              : "未同步",
      e.status === "indexed_verified" || e.status === "uploaded"
        ? "info"
        : e.status === "sync_failed"
          ? "error"
          : ["exported", "queued_upload"].includes(e.status)
            ? "wait"
            : "neutral",
    ),
  );
  const action = win.document.createElementNS(ns, "button") as any;
  action.className = "zrb-locate";
  action.title =
    e.status === "not_parsed"
      ? "解析这篇文献"
      : e.status === "sync_failed"
        ? "重试同步"
        : e.status === "export_failed"
          ? "重试导出"
          : "在 Zotero 中打开";
  action.textContent = ["not_parsed", "sync_failed", "export_failed"].includes(
    e.status,
  )
    ? "↻"
    : "↗";
  action.addEventListener("click", (ev: Event) => {
    ev.stopPropagation();
    void rowAction(e);
  });
  row.appendChild(action);
  row.title = e.error || `${e.title || e.attachmentKey}\n${e.status}`;
  if (e.error) {
    const error = win.document.createElementNS(ns, "div");
    error.className = "zrb-error-detail";
    error.textContent = e.error;
    row.appendChild(error);
    // 文件级损坏（截断/无法读取）：提供开放获取补全入口
    if (/不完整|损坏|无法读取|PDF 本地文件不存在/.test(e.error)) {
      const repair = win.document.createElementNS(ns, "button") as any;
      repair.className = "zrb-button zrb-secondary zrb-repair";
      repair.textContent = "⤓ 补全文献（开放获取）";
      repair.title =
        "Crossref 查 DOI → Unpaywall/OpenAlex 找开放 PDF → 下载校验后替换附件";
      repair.addEventListener("click", (ev: Event) => {
        ev.stopPropagation();
        void repairAction(e);
      });
      row.appendChild(repair);
    }
  }
  row.addEventListener("click", () => locate(e));
  return row;
}

function badge(win: Window, text: string, kind: string): Element {
  const node = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "span",
  );
  node.className = `zrb-status zrb-status-${kind}`;
  node.textContent = text;
  return node;
}

async function repairAction(e: ledger.LedgerEntry): Promise<void> {
  const win = Zotero.getMainWindow();
  const ok = win.confirm(
    `尝试补全「${(e.title || e.attachmentKey).slice(0, 60)}」？\n\n` +
      "将通过 Crossref / Unpaywall / OpenAlex 查找开放获取 PDF，\n" +
      "下载校验后替换损坏附件（旧文件移入回收站，可恢复）。",
  );
  if (!ok) return;
  await task.runTask(async (report) => {
    const { repairEntry } = await import("./repair");
    const result = await repairEntry(e.attachmentKey, {
      changeLine: (o: any) =>
        report({
          title: "补全文献",
          detail: o.text || "",
          progress: o.progress ?? 0,
        }),
    });
    report({
      title: result.ok ? "补全完成" : "补全失败",
      detail: result.message,
      progress: 100,
      done: true,
    });
    task.showResult({ ok: result.ok, message: result.message });
  });
  await render(true);
}

async function rowAction(e: ledger.LedgerEntry): Promise<void> {
  if (e.status === "not_parsed") {
    await task.runTask((report) =>
      parser.parseEntries([e.attachmentKey], report as any),
    );
  } else if (e.status === "export_failed") {
    await task.runTask((report) =>
      exporter.exportEntries([e.attachmentKey], report as any),
    );
  } else if (e.status === "sync_failed") {
    await task.runTask((report) =>
      sync.syncEntries([e.attachmentKey], report as any),
    );
  } else locate(e);
  await render();
}

function locate(e: ledger.LedgerEntry): void {
  try {
    const main = Zotero.getMainWindow();
    main.focus();
    const item = e.attachmentId ? Zotero.Items.get(e.attachmentId) : null;
    if (item) void main.ZoteroPane.selectItems([item.parentItemID || item.id]);
  } catch (err: any) {
    Zotero.logError(err);
  }
}

async function parsePending(): Promise<void> {
  await parser.parseMissing();
  await render();
}

async function exportPending(): Promise<void> {
  await task.runTask(async (report) => {
    const result = await exporter.exportMissingWithProgress(report as any);
    report({
      title: "导出完成",
      detail: `成功 ${result.succeeded} 篇，失败 ${result.failed} 篇`,
      progress: 100,
      done: true,
    });
  });
  await render();
}

async function syncPending(): Promise<void> {
  await task.runTask(async (report) => {
    const result = await sync.syncWithProgress(report as any);
    report({
      title: "同步完成",
      detail: `本次上传 ${result.succeeded} 篇，失败 ${result.failed} 篇，跳过 ${result.skipped} 篇`,
      progress: 100,
      done: true,
    });
  });
  await render();
}

function updateTask(win: Window, info: any, host?: HTMLElement): void {
  el(win, "zrb-task", host).removeAttribute("hidden");
  el(win, "zrb-task-title", host).textContent = info.title || "正在处理";
  el(win, "zrb-task-detail", host).textContent = info.detail || "";
  el(win, "zrb-task-progress", host).value = Math.max(
    0,
    Math.min(100, info.progress || 0),
  );
  el(win, "zrb-task-percent", host).textContent =
    `${Math.round(info.progress || 0)}%`;
  const spinner = el(win, "zrb-task-spinner", host);
  spinner.classList.toggle("zrb-done", !!info.done);
  spinner.textContent = info.done ? "✓" : "";
}

async function scanLibrary(): Promise<void> {
  await ledger.load();
  const libs = Zotero.Libraries.getAll().filter(
    (l: any) => l.libraryType === "user",
  );
  for (const lib of libs) {
    const items = await (Zotero.Items.getAll(
      lib.libraryID,
      false,
      false,
    ) as unknown as Promise<Zotero.Item[]>);
    for (const item of items) {
      if (
        !item.isAttachment() ||
        item.attachmentContentType !== "application/pdf"
      )
        continue;
      const parent = item.parentItemID
        ? Zotero.Items.get(item.parentItemID)
        : null;
      const previous = ledger.entry(item.key);
      // 已校验上传是云端事实，扫描只补充题录，绝不把状态倒退。
      const immutable =
        previous && ["uploaded", "indexed_verified"].includes(previous.status);
      if (immutable) {
        ledger.upsert({
          attachmentKey: item.key,
          attachmentId: item.id,
          title: parent?.getField("title") || previous.title,
          doi: parent?.getField("DOI") || previous.doi,
          year: parent?.getField("date") || previous.year,
        });
        continue;
      }
      const hasCache = !!(await exporter.resolveCacheDir(item.id, item.key));
      const keepExported =
        hasCache &&
        previous &&
        ["exported", "queued_upload", "sync_failed"].includes(previous.status);
      ledger.upsert({
        attachmentKey: item.key,
        attachmentId: item.id,
        parentItemKey: parent?.key || null,
        libraryScope: (lib.libraryType === "user" ? "u" : "g") + lib.libraryID,
        title:
          parent?.getField("title") ||
          item.getField("title") ||
          item.attachmentFilename ||
          item.key,
        doi: parent?.getField("DOI") || null,
        // 独立 PDF 附件没有父条目：从文件名提取年份（如 "JGR - 2020 - Bunn"）
        year:
          parent?.getField("date")?.match(/(?:1[5-9]|20)\d{2}/)?.[0] ||
          (item.attachmentFilename || "").match(/(?:1[5-9]|20)\d{2}/)?.[0] ||
          null,
        status: keepExported
          ? previous!.status
          : previous?.status === "parsing"
            ? "parsing"
            : hasCache
              ? "parsed"
              : "not_parsed",
        error:
          keepExported || previous?.status === "parsing"
            ? previous?.error
            : hasCache && previous?.status === "not_parsed"
              ? null
              : previous?.error,
      });
    }
  }
  await ledger.persist();
}
