// The content-scrub guardrail (RUBY_OBSERVABILITY_PLAN §4 + §6.2).
//
// Ruby records audio, transcripts, prep, and memory. Before ANY event or
// exception leaves the device, its property bag must be reduced to safe
// metadata. This module is that single boundary, applied in two places:
//   - as the PostHog client `before_send` hook (the guaranteed backstop that
//     runs on every event, including autocaptured `$exception`), and
//   - as a first-pass on our own capture()/captureException() property bags
//     (belt-and-suspenders, and the only pass that runs under E2E where no
//     client exists).
//
// The philosophy (§4): a stack trace is code (safe — redact paths/tokens but
// keep it); everything the code was *operating on* is content (drop it). We
// can't know every event's schema, so the backstop is structural: redact home
// paths + token-like runs from every string, and DROP any free-text string that
// exceeds a sane metadata length — a careless `track(e, { title: draft.title })`
// can't sail through.

import os from "node:os";

const HOME = os.homedir();

// Free-text string values longer than this are treated as likely content and
// dropped. Real metadata (event names, enums, ids, versions, emails, short
// reasons) is far shorter; call transcripts / prep / memory are far longer.
const MAX_VALUE_LEN = 200;

// Keys whose subtree is code/diagnostics, not user content: the exception stack
// and message live here. Strings inside are redacted (paths/tokens) but never
// length-dropped — a stack frame or a fixed error string can legitimately be
// long, and dropping it would gut the issue.
const CODE_CONTEXT_KEYS = new Set([
  "$exception_list",
  "$exception_stack_trace_raw",
  "$exception_message",
  "stack",
]);

/**
 * Redact a single string: home dir → `~`, and any long token-like run (JWT
 * segment, API key, base64/hex secret) → `[redacted]`. Used on stack frames and
 * error messages, where the string is kept but must not carry a path or secret.
 */
export function redactString(s: string): string {
  let out = HOME && HOME.length > 1 ? s.split(HOME).join("~") : s;
  // Long unbroken alphanumeric runs are almost never prose — they're tokens,
  // keys, or hashes. Normal words and stack symbols are well under 40 chars.
  out = out.replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
  return out;
}

function scrubValue(value: unknown, inCode: boolean): { keep: boolean; value: unknown } {
  if (typeof value === "string") {
    // Drop on the ORIGINAL length: a long value is content regardless of what
    // redaction would collapse it to (e.g. "token token" → two [redacted] runs
    // would otherwise read as short). Then redact whatever we keep.
    if (!inCode && value.length > MAX_VALUE_LEN) return { keep: false, value: undefined };
    return { keep: true, value: redactString(value) };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { keep: true, value };
  }
  if (Array.isArray(value)) {
    return { keep: true, value: value.map((v) => scrubValue(v, inCode).value) };
  }
  if (typeof value === "object") {
    return { keep: true, value: scrubObject(value as Record<string, unknown>, inCode) };
  }
  // functions / symbols / undefined — never metadata; drop.
  return { keep: false, value: undefined };
}

function scrubObject(obj: Record<string, unknown>, inCode: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const childInCode = inCode || CODE_CONTEXT_KEYS.has(k);
    const r = scrubValue(v, childInCode);
    if (r.keep) out[k] = r.value;
  }
  return out;
}

/**
 * First-pass scrub of one of our own property bags (events + exception context).
 * Redacts every string and drops free-text values that exceed the metadata
 * length budget. Pure — returns a new object, never mutates the input.
 */
export function scrubProps(props: Record<string, unknown>): Record<string, unknown> {
  return scrubObject(props, false);
}

/** The minimal shape `scrubEvent` needs — any PostHog outbound event carries this. */
export interface ScrubbableEvent {
  properties?: Record<string, unknown>;
}

/**
 * Scrub a whole outbound PostHog event's property bag — the `before_send`
 * backstop (§4). Covers our named events, wrapper exceptions, and any
 * autocaptured `$exception` (whose `$exception_list` stack frames + message are
 * scrubbed as code). Mutates `event.properties` in place and returns the same
 * event so it registers directly as `before_send`; `null` passes through.
 */
export function scrubEvent<E extends ScrubbableEvent | null>(event: E): E {
  if (event && event.properties) {
    event.properties = scrubProps(event.properties);
  }
  return event;
}
