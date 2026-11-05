// 解析引擎端到端测试台：node harness_parser.mjs <engine> [--real-pdf]
// engine: mineru | oxr
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const shim = require("./zrb_shim.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
// 通过环境变量指定本机路径（避免把个人目录写进仓库）：
//   ZRB_PREFS_JS=<Zotero Profile>/prefs.js  ZRB_ZOTERO_DIR=<Zotero 数据目录>  ZRB_SAMPLE_PDF=<测试 PDF>
const PREFS_JS = process.env.ZRB_PREFS_JS || "";
const ZOTERO_DIR = process.env.ZRB_ZOTERO_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", "Zotero");
const LEDGER_REAL = path.join(ZOTERO_DIR, "zrb-ledger.json");

// 1. 从 prefs.js 读真实 Key
if (!PREFS_JS || !fs.existsSync(PREFS_JS)) {
  console.error("请设置环境变量 ZRB_PREFS_JS 指向 Zotero Profile 的 prefs.js");
  process.exit(1);
}
const prefsSrc = fs.readFileSync(PREFS_JS, "utf-8");
function pref(name) {
  const m = prefsSrc.match(new RegExp(`user_pref\\("extensions\\.zotero\\.zrb\\.${name}",\\s*"?(.*?)"?\\);`));
  return m ? m.group || m[1] : "";
}
const keys = {
  parseEngine: process.argv[2] || "mineru",
  mineruToken: pref("mineruToken"),
  oxrApiKey: pref("oxrApiKey"),
  parseMaxDaily: pref("parseMaxDaily") || "20",
  parseConfirmed: "true",
  stagingDir: "",
};

// 2. 准备测试 PDF（真实论文前 2 页，快速上传）
const sampleDir = path.join(__dirname, "tmp");
fs.mkdirSync(sampleDir, { recursive: true });
const samplePdf = path.join(sampleDir, "zrb-harness-sample.pdf");
if (!fs.existsSync(samplePdf)) {
  const sourcePdf = process.env.ZRB_SAMPLE_PDF || "";
  if (!sourcePdf || !fs.existsSync(sourcePdf)) {
    console.error("请设置环境变量 ZRB_SAMPLE_PDF 指向一篇本机 PDF（取前 2 页做样本）");
    process.exit(1);
  }
  console.log("生成 2 页样本 PDF（来自真实文献库）...");
  execSync(
    `python -c "import pymupdf,sys; src=pymupdf.open(r'${sourcePdf.replace(/\\/g, "/")}'); out=pymupdf.open(); out.insert_pdf(src, from_page=0, to_page=1); out.save(r'${samplePdf.replace(/\\/g, "/")}'); print('pages:', out.page_count)"`,
    { stdio: "inherit" },
  );
}
const pdfSize = fs.statSync(samplePdf).size;
console.log(`样本 PDF: ${samplePdf} (${(pdfSize / 1024 / 1024).toFixed(2)} MB)`);

// 3. 构造账本（一条 not_parsed，指向样本 PDF）
const dataDir = path.join(sampleDir, "zrb-datadir");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const ledger = {
  version: 1,
  entries: {
    TESTATT01: {
      attachmentKey: "TESTATT01",
      attachmentId: 90001,
      parentItemKey: "TESTPARENT",
      libraryScope: "u1",
      title: "ZRB Harness Test Paper",
      doi: null,
      year: "2009",
      status: "not_parsed",
    },
  },
};

// 4. 安装 shim
shim.install({
  dataDir,
  ledger,
  pdfPath: samplePdf,
  pdfFilename: "zrb-harness-sample.pdf",
  prefs: keys,
  log: (m) => console.log(m),
});

// 5. 运行真实 parser 代码（现场用 esbuild 打包，产物不入库）
const bundle = path.join(__dirname, "parser.bundle.cjs");
const esbuild = process.platform === "win32"
  ? path.join(ROOT, "src", "node_modules", "@esbuild", "win32-x64", "esbuild.exe")
  : path.join(ROOT, "src", "node_modules", ".bin", "esbuild");
require("node:child_process").execFileSync(esbuild, [
  path.join(ROOT, "src", "src", "modules", "parser.ts"), "--bundle", "--format=cjs",
  "--platform=node", "--outfile=" + bundle,
], { stdio: "inherit", shell: false });
const parser = require(bundle);

(async () => {
  const t0 = Date.now();
  try {
    await parser.parseMissing();
  } catch (e) {
    console.error("FATAL:", e?.stack || e);
    process.exit(1);
  }
  console.log(`\n耗时 ${(Date.now() - t0) / 1000}s`);

  // 6. 验证产出
  const cacheDir = path.join(dataDir, "zrb-cache", "90001");
  const mdPath = path.join(cacheDir, "full.md");
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, "utf-8");
    console.log(`\n✓ full.md 产出: ${md.length} 字符`);
    console.log("  前 300 字:", md.slice(0, 300).replace(/\n/g, " | "));
    const imgs = fs.existsSync(path.join(cacheDir, "images")) ? fs.readdirSync(path.join(cacheDir, "images")) : [];
    console.log(`  images: ${imgs.length} 张`);
    const led = JSON.parse(fs.readFileSync(path.join(dataDir, "zrb-ledger.json"), "utf-8"));
    console.log("  账本状态:", led.entries.TESTATT01.status, "| engine:", led.entries.TESTATT01.parseEngine);
    process.exit(0);
  }
  console.error("✗ 未产出 full.md");
  process.exit(1);
})();
