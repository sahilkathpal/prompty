import Store from "electron-store";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/types";

const store = new Store<AppSettings>({
  name: "prompty-settings",
  defaults: DEFAULT_SETTINGS,
});

// One-shot, idempotent migration: strip now-removed keys from pre-Ruby settings
// files (`focusMode`, `compact`, `headsUpBar` — the gem replaced the
// teleprompter/heads-up-bar split, so the toggle is gone). Runs on every load
// but only writes when a legacy key is actually present.
(function migrateLegacySettings(): void {
  const raw = store.store as unknown as Record<string, unknown>;
  for (const key of ["focusMode", "compact", "headsUpBar"] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      store.delete(key as keyof AppSettings);
    }
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

export function setPanelSize(size: { width: number; height: number }): void {
  updateSettings({ panelSize: size });
}
