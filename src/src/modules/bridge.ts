// ZRB 菜单与通知器注册
// 菜单只保留工作台一个入口；导出/解析/同步都在工作台面板内操作，
// 图片同步与账本诊断收进设置页"高级"区，避免工具菜单被插件刷屏。

import * as ledger from "./ledger";
import * as dashboard from "./dashboard";
import { autoBackup } from "./sync";

export function registerMenu(win?: _ZoteroTypes.MainWindow): void {
  const target = win || Zotero.getMainWindow();
  const popup = target.document.getElementById("menu_ToolsPopup");
  if (!popup) return;
  // 清理旧版本注册的冗余菜单项（含 ztoolkit 注册的无 id 项）
  for (const el of popup.querySelectorAll(
    "menuitem[label^='ZRB:'], menuitem[label^='Research Bridge:']",
  )) {
    el.remove();
  }
  if (!target.document.getElementById("zrb-dashboard-menu")) {
    const item = target.document.createXULElement("menuitem");
    item.id = "zrb-dashboard-menu";
    item.setAttribute("label", "Research Bridge: 文献解析工作台");
    item.addEventListener("command", () => dashboard.openDashboard());
    popup.appendChild(item);
  }
}

// 差量通知：条目新增/修改后标记账本待复核（P2 MVP：仅登记，防抖后刷新缓存状态）
const pendingIds = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const ids = [...pendingIds];
    pendingIds.clear();
    try {
      await ledger.load();
      let changed = 0;
      for (const id of ids) {
        const item = Zotero.Items.get(id);
        if (
          !item ||
          !item.isAttachment() ||
          item.attachmentContentType !== "application/pdf"
        )
          continue;
        const e = ledger.entry(item.key);
        // 已导出的不动；未导出的刷新缓存探测
        if (
          e &&
          (e.status === "exported" ||
            e.status === "uploaded" ||
            e.status === "indexed_verified")
        )
          continue;
        const hasCache = await IOUtils.exists(
          PathUtils.join(
            Zotero.DataDirectory.dir,
            "llm-for-zotero-mineru",
            String(id),
            "full.md",
          ),
        );
        ledger.upsert({
          attachmentKey: item.key,
          attachmentId: id,
          parentItemKey: item.parentItemID
            ? Zotero.Items.get(item.parentItemID)?.key || null
            : null,
          libraryScope: "u" + item.libraryID,
          status: hasCache ? "parsed" : "not_parsed",
        });
        changed++;
      }
      if (changed) {
        await ledger.persist();
        await autoBackup(); // 自动备份开启时：导出缺失 + S3 增量同步
      }
    } catch (err) {
      Zotero.logError(new Error(`[zrb] notify flush: ${err}`));
    }
  }, 5000) as any;
}

export function registerNotifier(): void {
  const cb = {
    notify: async (
      event: string,
      type: string,
      ids: (string | number)[],
      _extraData: { [k: string]: any },
    ) => {
      if (type !== "item") return;
      if (!["add", "modify"].includes(event)) return;
      for (const id of ids) {
        if (typeof id === "number") pendingIds.add(id);
      }
      scheduleFlush();
    },
  };
  const id = Zotero.Notifier.registerObserver(cb, ["item"], "zrb", 1);
  (addon.data as any).notifierID = id;
}

export function unregister(): void {
  const id = (addon.data as any).notifierID;
  if (id) Zotero.Notifier.unregisterObserver(id);
}
