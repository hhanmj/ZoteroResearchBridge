// ZRB 测试台：在 Node 里模拟 Zotero 环境，运行真实的 parser.ts 代码
// 用途：不重启 Zotero 即可端到端验证解析引擎（OXR/MinerU）
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

function install(opts) {
  // opts: { dataDir, ledger, pdfPath, pdfFilename, attachmentId, attachmentKey, parentKey,
  //         prefs: {parseEngine, mineruToken, oxrApiKey, parseMaxDaily, parseConfirmed}, keys: {mineruToken, oxrApiKey}, log }
  const log = opts.log || ((m) => console.log("[zrb]", m));
  const DataDir = opts.dataDir;

  // ---------- IOUtils ----------
  const IOUtils = {
    exists: (p) => fsp.stat(p).then(() => true, () => false),
    read: (p) => fsp.readFile(p),
    readUTF8: (p) => fsp.readFile(p, "utf-8"),
    write: (p, data) => fsp.mkdir(path.dirname(p), { recursive: true }).then(() => fsp.writeFile(p, data)),
    writeUTF8: (p, s) => fsp.mkdir(path.dirname(p), { recursive: true }).then(() => fsp.writeFile(p, s, "utf-8")),
    remove: (p) => fsp.rm(p, { force: true }),
    getChildren: (p) => fsp.readdir(p).then((names) => names.map((n) => path.join(p, n))),
  };

  const PathUtils = {
    join: (...p) => path.join(...p),
    filename: (p) => path.basename(p),
  };

  // ---------- Zotero.HTTP ----------
  const HTTP = {
    async request(method, url, options = {}) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), options.timeout || 30000);
      try {
        const headers = { ...(options.headers || {}) };
        let body = options.body ?? null;
        if (typeof body === "string") body = Buffer.from(body, "utf-8");
        const resp = await fetch(url, { method, headers, body, signal: ctl.signal });
        const rt = options.responseType === "arraybuffer" ? "arraybuffer" : "text";
        const buf = Buffer.from(await resp.arrayBuffer());
        const text = buf.toString("utf-8");
        return {
          status: resp.status,
          responseText: rt === "text" ? text : null,
          response: rt === "arraybuffer" ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : null,
          getResponseHeader: (h) => resp.headers.get(h),
        };
      } finally {
        clearTimeout(t);
      }
    },
  };

  // ---------- nsIZipReader shim（纯 JS ZIP 读取）----------
  function readZip(bytes) {
    bytes = Buffer.from(bytes);
    // EOCD
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("zip EOCD not found");
    const count = bytes.readUInt16LE(eocd + 10);
    let off = bytes.readUInt32LE(eocd + 16);
    const entries = new Map(); // name -> {method, compSize, uncompSize, localOff}
    const byName = {};
    for (let i = 0; i < count; i++) {
      if (bytes.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central dir at " + off);
      const method = bytes.readUInt16LE(off + 10);
      const compSize = bytes.readUInt32LE(off + 20);
      const uncompSize = bytes.readUInt32LE(off + 24);
      const nameLen = bytes.readUInt16LE(off + 28);
      const extraLen = bytes.readUInt16LE(off + 30);
      const commentLen = bytes.readUInt16LE(off + 32);
      const localOff = bytes.readUInt32LE(off + 42);
      const name = bytes.slice(off + 46, off + 46 + nameLen).toString("utf-8");
      entries.set(name, { method, compSize, uncompSize, localOff });
      byName[name] = { method, compSize, uncompSize, localOff };
      off += 46 + nameLen + extraLen + commentLen;
    }
    return {
      dataOf(name) {
        const e = entries.get(name);
        if (!e) throw new Error("no entry " + name);
        const ln = bytes.readUInt16LE(e.localOff + 26);
        const le = bytes.readUInt16LE(e.localOff + 28);
        const start = e.localOff + 30 + ln + le;
        const raw = bytes.slice(start, start + e.compSize);
        return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
      },
      names: [...entries.keys()],
      _entries: byName,
    };
  }

  const Components = {
    classes: new Proxy({}, { get: (_, k) => ({ createInstance: () => null }) }),
    interfaces: new Proxy({}, { get: (_, k) => ({}), set: () => true }),
  };
  // 覆盖 zip 相关：让 parser.ts 的 extractZip 走 shim
  Components.classes = {
    "@mozilla.org/zip;1": { createInstance: () => makeZipReader() },
    "@mozilla.org/binaryinputstream;1": { createInstance: () => makeBIS() },
  };
  Components.interfaces = { nsIZipReader: {}, nsIBinaryInputStream: {} };

  function makeZipReader() {
    let zip = null;
    return {
      open(fileLike) {
        zip = readZip(Buffer.from(fs.readFileSync(fileLike.path)));
      },
      findEntries(pattern) {
        const names = zip.names.filter((n) => !n.endsWith("/"));
        let i = 0;
        return { hasMore: () => i < names.length, getNext: () => names[i++] };
      },
      getEntry(name) {
        const e = zip.names.includes(name) ? zip._entries[name] : null;
        return e ? { realSize: e.uncompSize, size: e.uncompSize } : null;
      },
      getInputStream(name) {
        const data = zip.dataOf(name);
        return {
          readByteArray: (n) => data.buffer.slice(data.byteOffset, data.byteOffset + Math.min(n, data.length)),
          close: () => {},
        };
      },
      close() { zip = null; },
    };
  }
  function makeBIS() {
    let stream = null;
    return {
      setInputStream(is) { stream = is; },
      readByteArray(n) { return stream.readByteArray(n); },
    };
  }

  // ---------- Zotero ----------
  const Zotero = {
    DataDirectory: { dir: DataDir },
    HTTP,
    logError: (e) => log("logError: " + (e?.message || e)),
    log: (m) => log(m),
    debug: (m) => log("debug: " + m),
    File: {
      createDirectoryIfMissing: (p) => fs.mkdirSync(p, { recursive: true }),
      pathToFile: (p) => ({ path: p }),
      putContentsAsync: (p, s2) => fsp.writeFile(p, s2, 'utf-8'),
    },
    Items: {
      get: (id) => ({
        getFilePathAsync: async () => opts.pdfPath,
        attachmentFilename: opts.pdfFilename,
      }),
    },
    Prefs: {
      get: (name, _global) => {
        const short = String(name).replace("extensions.zotero.zrb.", "");
        return opts.prefs[short] ?? "";
      },
      set: (name, v, _global) => {
        const short = String(name).replace("extensions.zotero.zrb.", "");
        opts.prefs[short] = String(v);
      },
    },
    getMainWindow: () => ({ confirm: () => true }),
    Promise: { delay: (ms) => new Promise((r) => setTimeout(r, ms)) },
  };

  // ---------- 全局 ----------
  globalThis.Zotero = Zotero;
  globalThis.IOUtils = IOUtils;
  globalThis.PathUtils = PathUtils;
  globalThis.Components = Components;
  globalThis.addon = { data: { config: require(path.resolve(__dirname, "..", "..", "src", "package.json")) }, alive: true };
  globalThis.ztoolkit = {
    ProgressWindow: class {
      createLine(o) { this.line = o; console.log(`[progress ${o.progress ?? ""}] ${o.text}`); return this; }
      changeLine(o) { if (o.text) console.log(`[progress ${o.progress ?? ""}] ${o.text}`); Object.assign(this.line, o); return this; }
      show() { return this; }
      startCloseTimer() { return this; }
    },
    log: (...a) => log(a.join(" ")),
  };
  globalThis.rootURI = "";

  // ---------- ledger ----------
  fs.mkdirSync(DataDir, { recursive: true });
  fs.writeFileSync(path.join(DataDir, "zrb-ledger.json"), JSON.stringify(opts.ledger, null, 1));

  return { log };
}

module.exports = { install };
