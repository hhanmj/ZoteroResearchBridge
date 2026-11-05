import { config } from "../../package.json";
import * as ledger from "./ledger";

export type ProgressCallback = (info: {
  title: string;
  detail: string;
  progress: number;
  done?: boolean;
}) => void;

export interface WorkSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped?: number;
}

export type WorkRunner<T> = (progress: ProgressCallback) => Promise<T>;

// 任务窗口也会随着 Zotero 退出销毁；更新前必须检查 DOM，避免异步任务访问死窗口。
function notifyDashboard(progress: Parameters<WorkRunner<unknown>>[0]): void {
  try {
    (globalThis as any).zrbDashboardProgress?.(progress);
  } catch (_) {
    /* 面板已关闭时，任务本身仍继续执行 */
  }
}

export async function runTask<T>(
  runner: WorkRunner<T>,
  notify: (result: { ok: boolean; message: string }) => void = showResult,
): Promise<T | undefined> {
  const d = addon.data as any;
  if (d.zrbBusy) {
    notify({
      ok: false,
      message: "已有解析或同步任务在运行，请等待当前任务完成",
    });
    return undefined;
  }
  d.zrbBusy = true;
  const progress: ProgressCallback = (info) => {
    notifyDashboard((target) => Object.assign(target, info));
  };
  try {
    const result = await runner(progress);
    await ledger.persist();
    return result;
  } catch (e: any) {
    const message = `任务异常：${e?.message || e}`;
    Zotero.logError(e);
    progress({
      title: "任务未完成",
      detail: message,
      progress: 100,
      done: true,
    });
    notify({ ok: false, message });
    return undefined;
  } finally {
    d.zrbBusy = false;
    notifyDashboard({
      title: "状态已更新",
      detail: "",
      progress: 0,
      done: true,
      refresh: true,
    } as any);
  }
}

export function showResult(result: { ok: boolean; message: string }): void {
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
  });
  pw.createLine({
    text: result.message.slice(0, 400),
    type: result.ok ? "success" : "fail",
    progress: 100,
  })
    .show()
    .startCloseTimer(10000);
}

export function isBusy(): boolean {
  return !!(addon.data as any).zrbBusy;
}
