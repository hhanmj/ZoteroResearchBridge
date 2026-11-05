// P3 设置页注册与偏好读取

import { config } from "../../package.json";
import { getString } from "../utils/locale";

export function registerPrefs(): void {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: `chrome://${addon.data.config.addonRef}/content/settings.xhtml`,
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

export function getPref(name: string, dflt = ""): string {
  try {
    return (
      (Zotero.Prefs.get(
        `extensions.zotero.${config.addonRef}.${name}`,
        true,
      ) as string) || dflt
    );
  } catch (_) {
    return dflt;
  }
}

export function setPref(name: string, value: string): void {
  try {
    Zotero.Prefs.set(
      `extensions.zotero.${config.addonRef}.${name}`,
      value,
      true,
    );
  } catch (e) {
    Zotero.logError(new Error(`[zrb] setPref ${name}: ${e}`));
  }
}
