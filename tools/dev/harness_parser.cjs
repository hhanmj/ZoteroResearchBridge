// 解析引擎端到端测试台：node harness_parser.mjs <engine> [--real-pdf]
// engine: mineru | oxr
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const shim = require("./zrb_shim.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const PREFS_JS = "<Zotero Profile>/prefs.js";
const LEDGER_REAL = "%USERPROFILE%/Zotero/zrb-ledger.json";

// 1. 从 prefs.js 读真实 Key
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
  console.log("生成 2 页样本 PDF（来自真实文献库）...");
  execSync(
    `python -c "import pymupdf,sys; src=pymupdf.open(r'%USERPROFILE%/Zotero/storage/RDFI7MQ3/Wang和Li - 2009 - Landslide disaster mitigation in three gorges reservoir, china.pdf'); out=pymupdf.open(); out.insert_pdf(src, from_page=0, to_page=1); out.save(r'${samplePdf.replace(/\\/g, "/")}'); print('pages:', out.page_count)"`,
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

// 5. 运行真实 parser 代码
const parser = require(path.join(__dirname, "parser.bundle.cjs"));

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
