// Single source of truth for the relay base URL, shared by relay-client.ts
// (session JWT + Deepgram keys) and google-auth.ts (OAuth token brokering).
// Kept in its own module so the two don't have to import from each other.

const DEFAULT_RELAY_URL = "https://prompty-relay.sahil-847.workers.dev";

export function relayBaseUrl(): string {
  return process.env.PROMPTY_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
}
