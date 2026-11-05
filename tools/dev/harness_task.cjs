// 离线验证任务进度适配器与并发互锁；不发起网络请求。
"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const dataDir = path.join(__dirname, "tmp", "task-test");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const ledger = { version: 1, entries: {} };
fs.writeFileSync(path.join(dataDir, "zrb-ledger.json"), JSON.stringify(ledger));
globalThis.Zotero = {
  DataDirectory: { dir: dataDir },
  File: { putContentsAsync: (p, s) => fs.promises.writeFile(p, s) },
  logError: (e) => { throw e; },
};
globalThis.IOUtils = {
  exists: (p) => fs.promises.stat(p).then(() => true, () => false),
  readUTF8: (p) => fs.promises.readFile(p, "utf8"),
};
globalThis.PathUtils = { join: (...p) => path.join(...p) };
globalThis.addon = { data: { config: { addonName: "ZRB" } } };
globalThis.ztoolkit = { ProgressWindow: class {} };
const events = [];
globalThis.zrbDashboardProgress = (report) => {
  const info = { title: "", detail: "", progress: 0 };
  report(info);
  if (!info.refresh) events.push(info);
};
const bundle = path.join(__dirname, "task.bundle.cjs");
const esbuild = process.platform === "win32"
  ? path.join(root, "src", "node_modules", "@esbuild", "win32-x64", "esbuild.exe")
  : path.join(root, "src", "node_modules", ".bin", "esbuild");
execFileSync(esbuild, [
  path.join(root, "src", "src", "modules", "task.ts"), "--bundle", "--format=cjs",
  "--platform=node", "--outfile=" + bundle,
], { stdio: "inherit", shell: false });
const task = require(bundle);
(async () => {
  const result = await task.runTask(async (progress) => {
    progress({ title: "解析文献", detail: "1 / 2", progress: 50 });
    return { succeeded: 1 };
  });
  assert.deepEqual(result, { succeeded: 1 });
  assert.equal(events[0].title, "解析文献");
  assert.equal(events[0].progress, 50);
  assert.equal(addon.data.zrbBusy, false);
  let parallelRan = false;
  const first = task.runTask(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "done";
  }, () => {});
  const second = await task.runTask(async () => { parallelRan = true; }, () => {});
  await first;
  assert.equal(second, undefined);
  assert.equal(parallelRan, false);
  assert.equal(addon.data.zrbBusy, false);
  console.log("PASS: progress adaptation, task result, busy lock and lock release");
})().catch((e) => { console.error(e); process.exitCode = 1; });
