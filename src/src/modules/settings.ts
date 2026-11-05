import { config } from "../../package.json";
import { isWindowAlive } from "../utils/window";
import { OXR_SITES, preflightKey } from "./parser";
import { resolveS3Config } from "./sync";
import * as s3 from "./s3";

let settingsWindow: Window | null = null;
const textPrefs = [
  "parseEngineOrder",
  "mineruToken",
  "oxrApiKey",
  "oxrSite",
  "s3Endpoint",
  "s3Region",
  "s3Bucket",
  "s3AccessKey",
  "s3Secret",
  "uaApp",
  "s3SecretFile",
  "stagingDir",
];
const boolPrefs = [
  "parseConfirmed",
  "allowPaidQuota",
  "autoSync",
  "figuresSync",
  "verifyUpload",
];

function prefName(name: string): string {
  return `extensions.zotero.${config.addonRef}.${name}`;
}

function load(win: Window): void {
  for (const name of textPrefs) {
    let value = "";
    try {
      value = String(Zotero.Prefs.get(prefName(name), true) ?? "");
    } catch (_) {
      /* default */
    }
    // 旧配置迁移：单引擎选择 → 优先级列表
    if (name === "parseEngineOrder" && !value) {
      const legacy = String(
        Zotero.Prefs.get(prefName("parseEngine"), true) ?? "",
      );
      value = legacy === "oxr" ? "oxr,mineru" : "mineru,oxr";
    }
    const node = win.document.getElementById(name) as any;
    if (!node) continue;
    node.value = value;
    node.setAttribute("value", value);
    node.addEventListener("input", (event: Event) => {
      const input = event.target as any;
      input.setAttribute("value", input.value ?? "");
    });
    node.addEventListener("change", (event: Event) => {
      const input = event.target as any;
      input.setAttribute("value", input.value ?? "");
    });
  }
  for (const name of boolPrefs) {
    let value = false;
    try {
      value = Zotero.Prefs.get(prefName(name), true) === true;
    } catch (_) {
      /* default */
    }
    const node = win.document.getElementById(name) as any;
    if (!node) continue;
    node.checked = value;
    node.setAttribute("checked", String(value));
    node.addEventListener("change", (event: Event) => {
      const input = event.target as any;
      input.setAttribute("checked", String(!!input.checked));
    });
  }
}

function fieldValue(win: Window, name: string): string {
  const node = win.document.getElementById(name) as any;
  return String(node?.value || node?.getAttribute("value") || "").trim();
}

function setTestResult(
  win: Window,
  id: string,
  state: "busy" | "ok" | "fail",
  text: string,
): void {
  const node = win.document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  node.setAttribute("data-state", state);
}

// 分别测试两个引擎；读表单当前值（未保存也能测）
async function testOneEngine(
  win: Window,
  engine: "mineru" | "oxr",
): Promise<void> {
  const buttonId = engine === "mineru" ? "test-mineru" : "test-oxr";
  const resultId = `${buttonId}-result`;
  const button = win.document.getElementById(buttonId) as any;
  const key =
    engine === "mineru"
      ? fieldValue(win, "mineruToken")
      : fieldValue(win, "oxrApiKey");
  if (!key) {
    setTestResult(
      win,
      resultId,
      "fail",
      engine === "mineru" ? "请填写 MinerU Token" : "请填写 OXR API Key",
    );
    return;
  }
  button.disabled = true;
  setTestResult(win, resultId, "busy", "正在测试…");
  try {
    const base =
      engine === "oxr"
        ? OXR_SITES[fieldValue(win, "oxrSite") || "cn"]
        : undefined;
    const result = await preflightKey(engine, key, base);
    setTestResult(win, resultId, result.ok ? "ok" : "fail", result.msg);
  } catch (e: any) {
    setTestResult(win, resultId, "fail", `测试异常：${e?.message || e}`);
  } finally {
    button.disabled = false;
  }
}

async function testS3(win: Window): Promise<void> {
  const button = win.document.getElementById("test-s3") as any;
  button.disabled = true;
  setTestResult(win, "test-s3-result", "busy", "正在测试…");
  try {
    // 表单值优先，缺项回退到已保存配置/密钥文件
    const saved = await resolveS3Config();
    const cfg: s3.S3Config = {
      endpoint: fieldValue(win, "s3Endpoint") || saved?.endpoint || "",
      region: fieldValue(win, "s3Region") || saved?.region || "us-east-1",
      bucket: fieldValue(win, "s3Bucket") || saved?.bucket || "",
      accessKeyId: fieldValue(win, "s3AccessKey") || saved?.accessKeyId || "",
      secretAccessKey: fieldValue(win, "s3Secret") || saved?.secretAccessKey || "",
      pathStyle: true,
      uaApp: fieldValue(win, "uaApp") || saved?.uaApp || "S3Drive",
    };
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
      setTestResult(
        win,
        "test-s3-result",
        "fail",
        "配置不完整：需要 Endpoint、Bucket、AccessKey ID 与 Secret",
      );
      return;
    }
    const result = await s3.ping(cfg);
    setTestResult(
      win,
      "test-s3-result",
      result.ok ? "ok" : "fail",
      result.ok ? `连接成功：${result.detail}` : `连接失败：${result.detail}`,
    );
  } catch (e: any) {
    setTestResult(win, "test-s3-result", "fail", `测试异常：${e?.message || e}`);
  } finally {
    button.disabled = false;
  }
}

function save(win: Window): void {
  for (const name of textPrefs) {
    const node = win.document.getElementById(name) as any;
    if (!node) continue;
    // XUL 宿主的 html:select 编程赋值可能不反射 .value，attribute 兜底
    const value = node.value || node.getAttribute("value") || "";
    Zotero.Prefs.set(prefName(name), value, true);
  }
  for (const name of boolPrefs) {
    const node = win.document.getElementById(name) as any;
    if (!node) continue;
    const value = !!node.checked || node.getAttribute("checked") === "true";
    Zotero.Prefs.set(prefName(name), value, true);
  }
  // 兼容旧读取路径：parseEngine 同步为优先级首位
  const order = fieldValue(win, "parseEngineOrder") || "mineru,oxr";
  Zotero.Prefs.set(prefName("parseEngine"), order.split(",")[0]!, true);
  win.document.getElementById("settings-message")!.textContent =
    "设置已保存，新的任务将使用这些配置。";
}

export function openSettings(): void {
  if (isWindowAlive(settingsWindow || undefined)) {
    settingsWindow!.focus();
    return;
  }
  settingsWindow = Zotero.getMainWindow().openDialog(
    `chrome://${config.addonRef}/content/settings.xhtml`,
    "zrb-settings",
    "chrome,centerscreen,resizable,width=720,height=740",
    {
      onLoad: (win: Window) => {
        load(win);
        (win as any).zrbSettingsSave = () => save(win);
        win.document
          .getElementById("test-mineru")!
          .addEventListener("click", () => void testOneEngine(win, "mineru"));
        win.document
          .getElementById("test-oxr")!
          .addEventListener("click", () => void testOneEngine(win, "oxr"));
        win.document
          .getElementById("test-s3")!
          .addEventListener("click", () => void testS3(win));
        win.document
          .getElementById("sync-figures")!
          .addEventListener("click", () => {
            void import("./sync").then((m) => m.syncFigures());
          });
        win.document
          .getElementById("show-ledger")!
          .addEventListener("click", () => {
            void import("./exporter").then((m) => m.showStatus());
          });
        win.document
          .getElementById("settings-save")!
          .addEventListener("click", () => save(win));
        win.document
          .getElementById("settings-cancel")!
          .addEventListener("click", () => win.close());
        win.addEventListener(
          "unload",
          () => {
            settingsWindow = null;
          },
          { once: true },
        );
      },
    },
  ) as Window;
}