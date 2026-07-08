// Product analytics via PostHog (main-process only).
//
// We capture from the MAIN process, never the renderers, so:
//   - the project key lives in one place and is never injected into a window,
//   - every event is an explicit, code-reviewed name + property bag (no
//     autocapture), so call direction / transcript / nudge text physically
//     cannot leak — only the metadata we name here ever leaves the device,
//   - there's one distinct_id (the signed-in Google user, or a persisted
//     anonymous device id before sign-in).
//
// Renderers reach this through the `analytics:capture` IPC (see ipc-handlers).
//
// Disabled — a hard no-op, no client created — when:
//   - running under E2E (PROMPTY_E2E) or with PROMPTY_NO_ANALYTICS=1,
//   - no project key is configured, or
//   - the user has opted out (settings.analyticsOptOut).

import { app } from "electron";
import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import { getSettings, updateSettings } from "./settings-store";

// PostHog project "ruby". This is a WRITE-ONLY project key, designed to ship
// inside client apps — not a secret. An env var overrides it for other envs.
const DEFAULT_PROJECT_KEY = "phc_vD3kkPRuVKWiprunApFSzPnMFcFZ49r4TWczYX5ajZHq";
const PROJECT_KEY = process.env.POSTHOG_API_KEY?.trim() || DEFAULT_PROJECT_KEY;
const HOST = process.env.POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

const E2E = process.env.PROMPTY_E2E === "1";
// No real network in E2E, when explicitly disabled, or without a key.
const NETWORK_DISABLED = E2E || process.env.PROMPTY_NO_ANALYTICS === "1" || !PROJECT_KEY;

let client: PostHog | null = null;
let initFailed = false;

// E2E-only ring buffer: under PROMPTY_E2E, capture() records here instead of
// hitting the network, so specs can assert events fired with the right shape.
// Exposed via getRecentEvents(); empty/unused in production.
const recorded: { event: string; properties: Record<string, unknown> }[] = [];
export function getRecentEvents(): { event: string; properties: Record<string, unknown> }[] {
  return recorded;
}

function getClient(): PostHog | null {
  if (NETWORK_DISABLED || initFailed) return null;
  if (client) return client;
  try {
    // flushAt: 1 — send each event promptly. Desktop event volume is low, so the
    // lost batching is negligible, and events still arrive if a hard kill skips
    // the quit-time flush. flushInterval is a backstop.
    client = new PostHog(PROJECT_KEY, { host: HOST, flushAt: 1, flushInterval: 10_000 });
    return client;
  } catch (e) {
    initFailed = true;
    console.error("[analytics] init failed:", (e as Error).message);
    return null;
  }
}

/** Runtime opt-out (Settings → Privacy). Honored in every mode, including E2E. */
function optedOut(): boolean {
  try {
    return getSettings().analyticsOptOut === true;
  } catch {
    return false;
  }
}

/** Stable per-install id used before sign-in; persisted so it survives restarts. */
function anonId(): string {
  const s = getSettings();
  if (s.analyticsAnonId) return s.analyticsAnonId;
  const id = `anon_${randomUUID()}`;
  updateSettings({ analyticsAnonId: id });
  return id;
}

/** The signed-in Google user id if present, else the anonymous device id. */
function distinctId(): string {
  try {
    return getSettings().signedInUserId || anonId();
  } catch {
    return anonId();
  }
}

function baseProps(): Record<string, unknown> {
  return {
    app_version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Record an event. Properties must be metadata only — never call content
 * (direction text, transcript, nudge copy). No-op when suppressed.
 */
export function capture(event: string, properties: Record<string, unknown> = {}): void {
  if (optedOut()) return;
  const enriched = { ...baseProps(), ...properties };
  if (E2E) {
    recorded.push({ event, properties: enriched });
    return; // never touch the network in tests
  }
  const c = getClient();
  if (!c) return;
  try {
    c.capture({ distinctId: distinctId(), event, properties: enriched });
  } catch (e) {
    console.error(`[analytics] capture(${event}) failed:`, (e as Error).message);
  }
}

/**
 * Tie the anonymous pre-sign-in device id to the signed-in user, then identify.
 * Call ONLY at the sign-in moment (auth:google-sign-in): alias() enqueues a real
 * $create_alias every time it runs, and re-aliasing an already-identified anon id
 * into a *different* user is PostHog's documented person-merge hazard. Returning
 * users re-mark themselves identified via identifyUser() (no alias) on launch.
 */
export function aliasAndIdentify(userId: string, properties: Record<string, unknown> = {}): void {
  if (optedOut()) return;
  const anon = anonId();
  if (E2E) {
    // Record the identity ops so specs can assert the sequence without network.
    recorded.push({ event: "$create_alias", properties: { distinct_id: userId, alias: anon } });
    recorded.push({ event: "$identify", properties: { distinct_id: userId, ...properties } });
    return;
  }
  const c = getClient();
  if (!c) return;
  try {
    c.alias({ distinctId: userId, alias: anon });
    c.identify({ distinctId: userId, properties });
  } catch (e) {
    console.error("[analytics] alias+identify failed:", (e as Error).message);
  }
}

/**
 * Mark an already-known signed-in user as identified WITHOUT aliasing. Called on
 * every launch for a returning user so is_identified stays true — but never
 * aliases (that path is sign-in only, see aliasAndIdentify): a per-launch alias
 * both wastes volume and, for a second account on one device, risks a merge.
 */
export function identifyUser(userId: string, properties: Record<string, unknown> = {}): void {
  if (optedOut()) return;
  if (E2E) {
    recorded.push({ event: "$identify", properties: { distinct_id: userId, ...properties } });
    return;
  }
  const c = getClient();
  if (!c) return;
  try {
    c.identify({ distinctId: userId, properties });
  } catch (e) {
    console.error("[analytics] identify failed:", (e as Error).message);
  }
}

/**
 * Rotate the anonymous device id. Called on sign-out so that a DIFFERENT account
 * signing in next on this device aliases a FRESH anon person — instead of
 * re-aliasing the previous user's already-identified id into the new user
 * (PostHog's person-merge hazard). Not gated on opt-out: it only mutates a local
 * setting, sends nothing, and keeps the identity invariant correct regardless.
 */
export function rotateAnonId(): void {
  const id = `anon_${randomUUID()}`;
  updateSettings({ analyticsAnonId: id });
  if (E2E) recorded.push({ event: "$rotate_anon_id", properties: { anon_id: id } });
}

/** Flush queued events and close the client. Awaited on quit so nothing drops. */
export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (e) {
    console.error("[analytics] shutdown failed:", (e as Error).message);
  } finally {
    client = null;
  }
}
