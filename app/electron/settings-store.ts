import Store from "electron-store";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/types";

const store = new Store<AppSettings>({
  name: "prompty-settings",
  defaults: DEFAULT_SETTINGS,
});

// One-shot, idempotent migration: the old inverted `focusMode` flag became
// `headsUpBar` with flipped polarity (focusMode=false meant the bar was shown,
// which is headsUpBar=true). Also strips the now-removed `compact` key. Runs on
// every load but only writes when a legacy key is actually present.
(function migrateLegacySettings(): void {
  const raw = store.store as unknown as Record<string, unknown>;
  // NOTE: `store.store` merges defaults, so `headsUpBar` always *appears*
  // present. `focusMode`, however, is not a default key — its presence means a
  // pre-migration settings file. The two flags never coexist legitimately (the
  // new app deletes `focusMode` on write), so always derive and overwrite.
  if (Object.prototype.hasOwnProperty.call(raw, "focusMode")) {
    const legacy = raw.focusMode;
    store.set("headsUpBar", legacy === undefined ? true : !legacy);
    store.delete("focusMode" as keyof AppSettings);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "compact")) {
    store.delete("compact" as keyof AppSettings);
  }
})();

export function getSettings(): AppSettings {
  return store.store;
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...store.store, ...patch };
  store.store = next;
  return next;
}

export function setPanelPosition(pos: { x: number; y: number }): void {
  updateSettings({ panelPosition: pos });
}
