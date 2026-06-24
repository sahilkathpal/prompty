// Dynamic app config served by the relay's GET /config, so links can be changed
// via a wrangler var + deploy without shipping a new signed build. The relay is
// the source of truth; the hardcoded FALLBACK only applies before the first
// successful fetch or when the relay is unreachable.

import { relayBaseUrl } from "./relay-config";

export interface RemoteConfig {
  foundersUrl: string;
  howItWorksUrl: string;
}

// Offline/first-launch fallbacks. Keep these pointed at sane live URLs — they're
// the last resort if /config can't be reached.
const FALLBACK: RemoteConfig = {
  foundersUrl: "https://cal.com/team/revise-ai/quick-chat",
  howItWorksUrl: "https://howrubyworks.codeongrass.com",
};

let cached: RemoteConfig | null = null;

/** Current best-known config — the fetched value, or the fallback before/if the
 *  fetch fails. Synchronous so UI-triggered opens never block. */
export function getRemoteConfig(): RemoteConfig {
  return cached ?? FALLBACK;
}

/** Fetch /config once on launch and cache it. Best-effort: any failure leaves the
 *  fallback (or last good cache) in place — never throws. */
export async function fetchRemoteConfig(): Promise<void> {
  // Stay hermetic in E2E — no network; UI uses the fallback links.
  if (process.env.PROMPTY_E2E === "1") return;
  try {
    const resp = await fetch(`${relayBaseUrl()}/config`);
    if (!resp.ok) throw new Error(`/config ${resp.status}`);
    const data = (await resp.json()) as Partial<RemoteConfig>;
    const str = (v: unknown, fallback: string) =>
      typeof v === "string" && v.length > 0 ? v : fallback;
    cached = {
      foundersUrl: str(data.foundersUrl, FALLBACK.foundersUrl),
      howItWorksUrl: str(data.howItWorksUrl, FALLBACK.howItWorksUrl),
    };
  } catch (e) {
    console.warn("[remote-config] fetch failed, using fallback:", (e as Error).message);
  }
}
