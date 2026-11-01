# -*- coding: utf-8 -*-
"""0.3.2 补丁：OXR Base URL 可配置（somark.cn）+ Key 预检（含额度显示）+ confirm 加固 + 入口日志。"""
import io
import sys

BASE = r"<repo>\src"


def patch(path, pairs, must=True):
    p = BASE + "\\" + path.replace("/", "\\")
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            print(f"FAIL: not found in {path}: {old[:70]!r}")
            if must:
                sys.exit(1)
            continue
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched", path)


# ---- parser.ts ----
patch("src/modules/parser.ts", [
    ('const OXR_BASE = "https://somark.ai/api/v1";',
     '''// OXR 部署分国内/国际站：国内用户 Key 来自 somark.cn，Base URL 可在设置页改
const OXR_BASE_DEFAULT = "https://somark.cn/api/v1";

function oxrBase(): string {
  return getPref("oxrBaseUrl") || OXR_BASE_DEFAULT;
}'''),
    ('`${OXR_BASE}/parse/async`', '`${oxrBase()}/parse/async`'),
    ('`${OXR_BASE}/parse/async_check`', '`${oxrBase()}/parse/async_check`'),
])

# preflightKey + 入口日志 + confirm 加固
p = BASE + r"\src\modules\parser.ts"
s = io.open(p, encoding="utf-8").read()

if "async function preflightKey" not in s:
    anchor = "export async function parseMissing(): Promise<void> {"
    preflight = '''async function preflightKey(engine: Engine, key: string): Promise<{ ok: boolean; msg: string }> {
  try {
    if (engine === "oxr") {
      const fd = new FormData();
      fd.append("api_key", key);
      const r = await Zotero.HTTP.request("POST", `${oxrBase()}/usage`, {
        body: fd as any, responseType: "text", timeout: 30000,
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

export async function parseMissing(): Promise<void> {'''
    s = s.replace(anchor, preflight)

if 'await debugLog("parse: clicked")' not in s:
    s = s.replace('''export async function parseMissing(): Promise<void> {
  const d = addon.data as any;''',
'''export async function parseMissing(): Promise<void> {
  await debugLog("parse: clicked");
  const d = addon.data as any;''')

if "请先在设置页选择解析引擎并填写 API Key（引擎下拉框必选）" not in s:
    s = s.replace('''    new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true })
      .createLine({ text: "请先在设置页选择解析引擎并填写 API Key", type: "fail", progress: 100 })
      .startCloseTimer(8000);
    return;''',
'''    await debugLog(`parse abort: engine=${engine || "（空）"} oxrKey=${oxrKey ? "有" : "无"} mineruToken=${mineruToken ? "有" : "无"}`);
    const pw0 = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true });
    pw0.createLine({ text: "请先在设置页选择解析引擎（下拉框）并填写对应 API Key", type: "fail", progress: 100 });
    pw0.show();
    pw0.startCloseTimer(15000);
    return;''')

if "const pf = await preflightKey" not in s:
    s = s.replace('''  const maxDaily = parseInt(getPref("parseMaxDaily", "20"), 10) || 20;
  const quota = dailyCheck(maxDaily);''',
'''  const pf = await preflightKey(engine, engine === "oxr" ? oxrKey : mineruToken);
  await debugLog(`parse preflight(${engine}): ${pf.msg}`);
  if (!pf.ok) {
    const pwK = new ztoolkit.ProgressWindow(config.addonName, { closeOnClick: true });
    pwK.createLine({ text: pf.msg, type: "fail", progress: 100 });
    pwK.show();
    pwK.startCloseTimer(15000);
    return;
  }
  const maxDaily = parseInt(getPref("parseMaxDaily", "20"), 10) || 20;
  const quota = dailyCheck(maxDaily);''')

# confirm 加固（主确认 + win2Confirm 两处）
s = s.replace('''    const ok = win.confirm(
      "即将调用付费解析 API（OXR/MinerU）。\\n\\n" +
      "· 每篇 PDF 会消耗你的 API 额度\\n" +
      "· 仅解析【无本地 MinerU 缓存】的条目\\n" +
      "· 每日上限可在设置页调整（默认 20 篇）\\n\\n确认继续？",
    );
    if (!ok) return;''',
'''    let ok = true;
    try {
      ok = !!(win as any).confirm(
        "即将调用付费解析 API（OXR/MinerU）。\\n\\n" +
        "· 每篇 PDF 会消耗你的 API 额度\\n" +
        "· 仅解析【无本地 MinerU 缓存】的条目\\n" +
        "· 每日上限可在设置页调整\\n\\n确认继续？",
      );
    } catch (_) { ok = true; }
    if (!ok) {
      await debugLog("parse: user cancelled");
      return;
    }''')

io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("parser.ts: preflight + logging + confirm hardened")

# ---- prefs.js / xhtml: oxrBaseUrl ----
p = BASE + r"\addon\prefs.js"
s = io.open(p, encoding="utf-8").read()
if "oxrBaseUrl" not in s:
    s += 'pref("oxrBaseUrl", "https://somark.cn/api/v1");\n'
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("prefs.js: oxrBaseUrl added")

p = BASE + r"\addon\content\preferences.xhtml"
s = io.open(p, encoding="utf-8").read()
if "oxrBaseUrl" not in s:
    s = s.replace('''  <hbox align="center">
    <html:label style="width: 160px">OXR API Key（sk-…）</html:label>
    <html:input type="password" preference="oxrApiKey" flex="1" />
  </hbox>''',
'''  <hbox align="center">
    <html:label style="width: 160px">OXR API Key（sk-…）</html:label>
    <html:input type="password" preference="oxrApiKey" flex="1" />
  </hbox>
  <hbox align="center">
    <html:label style="width: 160px">OXR Base URL</html:label>
    <html:input type="text" preference="oxrBaseUrl" flex="1" />
  </hbox>''')
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("xhtml: oxrBaseUrl added")

print("ALL DONE")
