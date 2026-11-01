// ZRB 菜单与通知器注册（P2 MVP）

import * as exporter from "./exporter";
import * as sync from "./sync";
import * as parser from "./parser";
import { autoBackup } from "./sync";
import * as ledger from "./ledger";

export function registerMenu(): void {
  ztoolkit.Menu.register("menuTools", {
    tag: "menuseparator",
  });
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: "ZRB: 导出选中条目的 MinerU 缓存",
    commandListener: () => {
      const win = Zotero.getMainWindow();
      exporter.exportSelected(win).catch((e) => Zotero.logError(e));
    },
  });
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: "ZRB: 导出全库缺失缓存",
    commandListener: () => {
      exporter.exportAllMissing().catch((e) => Zotero.logError(e));
    },
  });
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: "ZRB: 解析无缓存条目（OXR/MinerU · 消耗额度）",
    commandListener: () => {
      parser.parseMissing().catch((e) => Zotero.logError(e));
    },
  });
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: "ZRB: 同步到中国科技云 S3（增量）",
    commandListener: () => {
      sync.syncToS3().catch((e) => Zotero.logError(e));
    },
  });
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: "ZRB: 同步图片文件到 S3（较慢）",
    commandListener: () => {
      sync.syncFigures().catch((e) => Zotero.logError(e));
    },
  });
  ztoolkit.Menu.register("menuTools", {
    tag: "menuitem",
    label: "ZRB: 查看任务账本状态",
    commandListener: () => {
      exporter.showStatus().catch((e) => Zotero.logError(e));
    },
  });
}

// 差量通知：条目新增/修改后标记账本待复核（P2 MVP：仅登记，防抖后刷新缓存状态）
let pendingIds = new Set<number>();
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
        if (!item || !item.isAttachment() || item.attachmentContentType !== "application/pdf") continue;
        const e = ledger.entry(item.key);
        // 已导出的不动；未导出的刷新缓存探测
        if (e && (e.status === "exported" || e.status === "uploaded" || e.status === "indexed_verified")) continue;
        const hasCache = await IOUtils.exists(
          PathUtils.join(Zotero.DataDirectory.dir, "llm-for-zotero-mineru", String(id), "full.md"),
        );
        ledger.upsert({
          attachmentKey: item.key,
          attachmentId: id,
          parentItemKey: item.parentItemID ? Zotero.Items.get(item.parentItemID)?.key || null : null,
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
