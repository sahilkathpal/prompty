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
import type { EventMessage } from "posthog-node";
import { getSettings, updateSettings } from "./settings-store";
import { scrubProps, redactString } from "./scrub";

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

// E2E-only ring buffer for exceptions (peer of `recorded`). captureException
// records the scrubbed exception shape here under PROMPTY_E2E; exposed via
// getRecentErrors().
const recordedErrors: Record<string, unknown>[] = [];
export function getRecentErrors(): Record<string, unknown>[] {
  return recordedErrors;
}

function getClient(): PostHog | null {
  if (NETWORK_DISABLED || initFailed) return null;
  if (client) return client;
  try {
    // flushAt: 1 — send each event promptly. Desktop event volume is low, so the
    // lost batching is negligible, and events still arrive if a hard kill skips
    // the quit-time flush. flushInterval is a backstop.
    //
    // before_send is the guaranteed content-scrub backstop (§4): it runs on
    // EVERY outbound event — named events, wrapper exceptions, and any
    // autocaptured `$exception` — after the SDK has built it, so nothing bypasses
    // the scrub even if a call site forgets the first-pass.
    client = new PostHog(PROJECT_KEY, {
      host: HOST,
      flushAt: 1,
      flushInterval: 10_000,
      before_send: beforeSend,
    });
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
  // First-pass scrub (§6.2): even under E2E, and belt-and-suspenders for the
  // network path where before_send is the backstop. Enforces content-free in
  // code, not just by convention.
  const enriched = scrubProps({ ...baseProps(), ...properties });
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
 * The PostHog `before_send` backstop. Runs on every outbound event; scrubs the
 * property bag so no content ships even if a call site skipped the first-pass.
 * Returns the (scrubbed) event; never drops in the generic case — the scrubber
 * removes offending keys rather than the whole event.
 */
function beforeSend(event: EventMessage | null): EventMessage | null {
  if (!event) return event;
  if (event.properties) {
    event.properties = scrubProps(event.properties) as EventMessage["properties"];
  }
  return event;
}

// ── Error tracking (RUBY_OBSERVABILITY_PLAN §3, §5) ─────────────────────────

/** Failure domain — the fixed fingerprint dimension (§5.2). */
export type ErrorComponent =
  | "agent"
  | "transcription"
  | "capture"
  | "auth"
  | "relay"
  | "update"
  | "ipc"
  | "renderer-ui"
  | "main";

/** Coarse lifecycle phase an error occurred in (§5.2). */
export type ErrorPhase = "prep" | "in-call" | "post-call" | "idle";

export interface CaptureContext {
  component: ErrorComponent;
  phase?: ErrorPhase;
  skill?: string;
  /**
   * Stable grouping key → `$exception_fingerprint` (§5.3). Set it for
   * synthetic/manufactured issues and for wrappers that would otherwise
   * over-merge distinct causes (e.g. `agent:${subtype}`). Defaults to
   * `component:errorName`.
   */
  fingerprint?: string;
  /** Extra content-free metadata; scrubbed before it ships. */
  extra?: Record<string, unknown>;
}

// Breadcrumbs (§5.5): a short ring of recent STATE TRANSITIONS (never content),
// attached to every exception so an issue carries the run-up to the failure.
interface Breadcrumb {
  t: number;
  type: string;
  message: string;
}
const MAX_BREADCRUMBS = 20;
const breadcrumbs: Breadcrumb[] = [];

/** Record a content-free state transition for the exception breadcrumb trail. */
export function addBreadcrumb(type: string, message: string): void {
  breadcrumbs.push({ t: Date.now(), type, message: String(message).slice(0, 120) });
  if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift();
}

// Per-fingerprint per-session rate limit (§5.6). Desktop apps produce error
// storms (a render or reconnect loop throwing every frame); PostHog dedups into
// one issue but still ingests each, so we cap BEFORE send: N then count-and-drop.
const RATE_CAP = 5;
const exceptionCounts = new Map<string, number>();

/**
 * Report an unexpected, actionable failure to PostHog error tracking (§5.1).
 * Honors the analytics opt-out and E2E/no-network modes exactly like capture().
 * Tags the fixed `component` dimension + optional phase/skill, attaches
 * breadcrumbs, sets a stable `$exception_fingerprint`, first-pass scrubs all
 * context, and rate-limits per fingerprint. Handled/expected outcomes belong in
 * capture() as events, NOT here.
 */
export function captureException(error: unknown, ctx: CaptureContext): void {
  if (optedOut()) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const fingerprint = ctx.fingerprint ?? `${ctx.component}:${err.name}`;

  // Rate limit: cap then count-and-drop so one broken session can't ship
  // thousands of ingested events.
  const n = (exceptionCounts.get(fingerprint) ?? 0) + 1;
  exceptionCounts.set(fingerprint, n);
  if (n > RATE_CAP) return;

  const additional = scrubProps({
    ...baseProps(),
    component: ctx.component,
    ...(ctx.phase ? { phase: ctx.phase } : {}),
    ...(ctx.skill ? { skill: ctx.skill } : {}),
    $exception_fingerprint: fingerprint,
    breadcrumbs: breadcrumbs.slice(-MAX_BREADCRUMBS),
    ...(ctx.extra ?? {}),
  });

  if (E2E) {
    // Record the scrubbed shape (message redacted; before_send doesn't run
    // without a client) so specs can assert tagging + scrubbing offline.
    recordedErrors.push({ name: err.name, message: redactString(err.message), ...additional });
    return;
  }
  const c = getClient();
  if (!c) return;
  try {
    // posthog-node: captureException(error, distinctId?, additionalProperties?).
    // distinctId is the 2nd arg, props the 3rd (NOT the browser 2-arg form).
    c.captureException(err, distinctId(), additional);
  } catch (e) {
    console.error("[analytics] captureException failed:", (e as Error).message);
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
