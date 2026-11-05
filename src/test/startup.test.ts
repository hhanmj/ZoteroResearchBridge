import { config } from "../package.json";
import { assert } from "chai";
import { sidebarMarkup } from "../src/modules/sidebarMarkup";
import {
  mountForTest,
  openDashboard,
  registerSidebar,
} from "../src/modules/dashboard";
import { openSettings } from "../src/modules/settings";
import { splitPdfForParsing } from "../src/modules/pdf";
import { PDFDocument } from "pdf-lib";

describe("startup", function () {
  it("should have plugin instance defined", async function () {
    const { config } = await import("../package.json");
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should render and filter the sidebar dashboard", async function () {
    this.timeout(15000);
    const win = Zotero.getMainWindow();
    (globalThis as any).addon = Zotero[config.addonInstance];
    (globalThis as any).ztoolkit = Zotero[config.addonInstance].data.ztoolkit;
    await Zotero.File.putContentsAsync(
      PathUtils.join(Zotero.DataDirectory.dir, "zrb-ledger.json"),
      JSON.stringify({
        version: 1,
        entries: {
          SYNCED01: {
            attachmentKey: "SYNCED01",
            parentItemKey: null,
            libraryScope: "u1",
            title: "Cloud synced paper",
            doi: null,
            year: "2026",
            status: "uploaded",
          },
          PENDING1: {
            attachmentKey: "PENDING1",
            parentItemKey: null,
            libraryScope: "u1",
            title: "Paper awaiting parsing",
            doi: null,
            year: "2025",
            status: "not_parsed",
          },
          EXPORT01: {
            attachmentKey: "EXPORT01",
            parentItemKey: null,
            libraryScope: "u1",
            title: "Paper awaiting sync",
            doi: null,
            year: "2024",
            status: "exported",
          },
        },
      }),
    );
    const host = win.document.createXULElement("vbox") as any;
    host.setAttribute("style", "width: 400px; height: 600px;");
    win.document.documentElement.appendChild(host);
    await mountForTest(host);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const q = (id: string) => host.querySelector("#" + id) as any;
    assert.equal(q("zrb-total").textContent, "3", "total");
    assert.equal(q("zrb-parsed").textContent, "2", "parsed");
    assert.equal(q("zrb-synced").textContent, "1", "synced");
    assert.equal(q("zrb-pending").textContent, "1", "pending");
    q("zrb-search").value = "awaiting parsing";
    q("zrb-search").dispatchEvent(
      new (win as any).Event("input", { bubbles: true }),
    );
    assert.include(q("zrb-list-count").textContent, "1 / 3");
    host.remove();
  });

  it("should mount the native item sidebar on first open", async function () {
    this.timeout(15000);
    (globalThis as any).addon = Zotero[config.addonInstance];
    const paneID = registerSidebar();
    assert.isString(paneID);
    const item = new Zotero.Item("journalArticle");
    item.libraryID = 1;
    item.setField("title", "ZRB sidebar integration test");
    await item.saveTx();
    await Zotero.getMainWindow().ZoteroPane.selectItem(item.id);
    await openDashboard();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const section = [
      ...Zotero.getMainWindow().document.querySelectorAll(
        "item-pane-custom-section",
      ),
    ].find((n) => n.getAttribute("data-pane") === paneID);
    assert.isOk(section, "native sidebar section exists");
    assert.isOk(
      section!.querySelector("#zrb-total"),
      "native sidebar dashboard mounted",
    );
    await item.eraseTx();
  });

  it("should open independent settings and save a preference", async function () {
    this.timeout(10000);
    const before = Zotero.Prefs.get(
      "extensions.zotero.zrb.parseEngineOrder",
      true,
    );
    openSettings();
    const win = await new Promise<any>((resolve, reject) => {
      let attempts = 0;
      const timer = setInterval(() => {
        const found = [
          ...(Zotero.getMainWindow() as any).Services.wm.getEnumerator(null),
        ].find((w: any) => w.document?.getElementById("settings-save"));
        if (found) {
          clearInterval(timer);
          resolve(found);
        }
        if (++attempts > 100) {
          clearInterval(timer);
          reject(new Error("settings did not load"));
        }
      }, 100);
    });
    const order = win.document.getElementById("parseEngineOrder");
    order.value = "oxr,mineru";
    order.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
    (win as any).zrbSettingsSave();
    const savedOrder = Zotero.Prefs.get(
      "extensions.zotero.zrb.parseEngineOrder",
      true,
    );
    const savedLegacy = Zotero.Prefs.get(
      "extensions.zotero.zrb.parseEngine",
      true,
    );
    assert.equal(
      savedOrder,
      "oxr,mineru",
      `order saved (select.value=${JSON.stringify(order.value)}, attr=${JSON.stringify(order.getAttribute("value"))}, saved=${JSON.stringify(savedOrder)})`,
    );
    assert.equal(
      savedLegacy,
      "oxr",
      "legacy parseEngine synced to first priority",
    );
    Zotero.Prefs.set("extensions.zotero.zrb.parseEngineOrder", before, true);
    win.close();
  });

  it("should split a PDF above 280 pages and merge page ranges", async function () {
    this.timeout(20000);
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 281; i++) pdf.addPage([200, 200]);
    const parts = await splitPdfForParsing(await pdf.save(), "long.pdf");
    assert.lengthOf(parts, 2);
    assert.equal(parts[0].firstPage, 1);
    assert.equal(parts[0].lastPage, 280);
    assert.equal(parts[1].firstPage, 281);
    const restored = await PDFDocument.load(parts[1].bytes);
    assert.equal(restored.getPageCount(), 1);
  });

  it("should reject truncated PDFs with an actionable message", async function () {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const full = await pdf.save();
    const truncated = full.slice(0, Math.floor(full.length * 0.6));
    try {
      await splitPdfForParsing(truncated, "broken.pdf");
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(e.message, "不完整");
      assert.include(e.message, "重新下载");
    }
  });

  it("should validate PDF completeness for the repair pipeline", async function () {
    const { isPdfComplete } = await import("../src/modules/repair");
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const full = await pdf.save();
    assert.isTrue(isPdfComplete(full), "complete PDF passes");
    assert.isFalse(
      isPdfComplete(full.slice(0, Math.floor(full.length * 0.6))),
      "truncated PDF rejected",
    );
    assert.isFalse(
      isPdfComplete(new TextEncoder().encode("<html>not a pdf</html>" + "x".repeat(2000))),
      "HTML rejected",
    );
  });

  it("should find DOI via Crossref for a real paper title", async function () {
    this.timeout(45000);
    const { crossrefByTitle } = await import("../src/modules/repair");
    const hit = await crossrefByTitle(
      "Geologic Trends in Shear Strength Properties Inferred Through Three-Dimensional Back Analysis",
    );
    // 网络不可用时跳过而不是误报
    if (!hit) {
      this.skip();
      return;
    }
    assert.match(hit.doi, /^10\.1029\/2019jf005461$/i);
  });

  it("should expose the native sidebar markup", function () {
    assert.include(sidebarMarkup, "zrb-sidebar-app");
    assert.include(sidebarMarkup, "zrb-settings");
    assert.include(sidebarMarkup, "zrb-logo");
    assert.notInclude(sidebarMarkup, ">Z</div>", "template logo replaced");
  });

  it("should default daily quota to the provider free tier", async function () {
    const {
      effectiveMaxDaily,
      defaultMaxDaily,
      migrateDailyDefault,
      enginePriority,
      OXR_SITES,
    } = await import("../src/modules/parser");
    const p = (n: string) => `extensions.zotero.zrb.${n}`;
    const saved: Record<string, any> = {};
    for (const n of [
      "allowPaidQuota",
      "parseEngineOrder",
      "parseEngine",
      "mineruToken",
      "oxrApiKey",
      "parseMaxDaily",
      "parseQuotaMigrated2",
    ])
      saved[n] = Zotero.Prefs.get(p(n), true);
    try {
      Zotero.Prefs.set(p("allowPaidQuota"), false, true);
      Zotero.Prefs.set(p("mineruToken"), "test-token", true);
      Zotero.Prefs.set(p("oxrApiKey"), "", true);
      Zotero.Prefs.set(p("parseEngineOrder"), "mineru,oxr", true);
      assert.equal(effectiveMaxDaily(), defaultMaxDaily("mineru"));
      Zotero.Prefs.set(p("parseEngineOrder"), "oxr,mineru", true);
      Zotero.Prefs.set(p("oxrApiKey"), "sk-test", true);
      assert.equal(effectiveMaxDaily(), defaultMaxDaily("oxr"));
      assert.deepEqual(enginePriority(), ["oxr", "mineru"]);
      // 开关打开 → 不限篇数
      Zotero.Prefs.set(p("allowPaidQuota"), true, true);
      assert.isAbove(effectiveMaxDaily(), 1000000);
      // 旧数字上限迁移：大值 → 自动开启超额开关
      Zotero.Prefs.set(p("allowPaidQuota"), false, true);
      Zotero.Prefs.set(p("parseQuotaMigrated2"), "", true);
      Zotero.Prefs.set(p("parseMaxDaily"), "2000", true);
      migrateDailyDefault();
      assert.equal(Zotero.Prefs.get(p("allowPaidQuota"), true), true);
      assert.equal(Zotero.Prefs.get(p("parseMaxDaily"), true), "");
      // 双站内置
      assert.include(OXR_SITES.cn, "somark.cn");
      assert.include(OXR_SITES.intl, "somark.ai");
    } finally {
      for (const [n, v] of Object.entries(saved))
        Zotero.Prefs.set(p(n), v, true);
    }
  });

  it("should show per-engine connection test controls in settings", async function () {
    this.timeout(10000);
    openSettings();
    const win = await new Promise<any>((resolve, reject) => {
      let attempts = 0;
      const timer = setInterval(() => {
        const found = [
          ...(Zotero.getMainWindow() as any).Services.wm.getEnumerator(null),
        ].find((w: any) => w.document?.getElementById("settings-save"));
        if (found) {
          clearInterval(timer);
          resolve(found);
        }
        if (++attempts > 100) {
          clearInterval(timer);
          reject(new Error("settings did not load"));
        }
      }, 100);
    });
    assert.isOk(win.document.getElementById("test-mineru"));
    assert.isOk(win.document.getElementById("test-oxr"));
    assert.isOk(win.document.getElementById("test-s3"));
    assert.isOk(win.document.getElementById("oxrSite"));
    assert.isOk(win.document.getElementById("allowPaidQuota"));
    assert.notOk(
      win.document.getElementById("oxrBaseUrl"),
      "manual base URL removed",
    );
    // 未填 Key 时点击应给出提示而不是发请求
    win.document.getElementById("mineruToken").value = "";
    win.document.getElementById("test-mineru").click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.include(
      win.document.getElementById("test-mineru-result").textContent,
      "Token",
    );
    win.close();
  });
});
