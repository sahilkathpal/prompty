import type { Env } from "./types";

const DEEPGRAM_KEY_TTL_SECONDS = 60 * 60; // 1h

export interface MintedDeepgramKey {
  key: string;
  expiresAt: number; // epoch seconds
}

interface DeepgramCreateKeyResponse {
  api_key_id?: string;
  key: string;
  comment?: string;
  scopes?: string[];
  expiration_date?: string;
}

/**
 * Mints a short-lived Deepgram API key scoped for usage:write, valid for 1h.
 * Uses the master admin key + project id from env.
 */
export async function mintDeepgramKey(
  env: Env,
  sub: string
): Promise<MintedDeepgramKey> {
  const ts = Math.floor(Date.now() / 1000);
  const url = `https://api.deepgram.com/v1/projects/${env.DEEPGRAM_PROJECT_ID}/keys`;
  const body = {
    comment: `prompty-${sub}-${ts}`,
    scopes: ["usage:write"],
    time_to_live_in_seconds: DEEPGRAM_KEY_TTL_SECONDS,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${env.DEEPGRAM_MASTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`deepgram key creation failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as DeepgramCreateKeyResponse;
  if (!data.key) {
    throw new Error("deepgram key creation returned no key");
  }
  return {
    key: data.key,
    expiresAt: ts + DEEPGRAM_KEY_TTL_SECONDS,
  };
}
