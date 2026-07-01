export interface Env {
  // KV bindings
  GOOGLE_JWKS_CACHE: KVNamespace;
  RATE_LIMITS: KVNamespace;
  SESSIONS: KVNamespace;

  // Secrets (set via `wrangler secret put`)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  PROMPTY_JWT_SECRET: string;
  DEEPGRAM_MASTER_KEY: string;
  DEEPGRAM_PROJECT_ID: string;

  // Plain vars (from wrangler.toml [vars])
  DAILY_MINT_LIMIT?: string;
  // App config links served by GET /config — editable via wrangler.toml + deploy
  // (no app rebuild). Optional so a missing var falls back in the handler.
  FOUNDERS_URL?: string;
  HOW_IT_WORKS_URL?: string;
  // STOPGAP (remove after desktop app persists session JWT + wires refresh):
  // if set to a positive integer, /auth/google will accept expired Google ID
  // tokens whose signature is still valid and whose iat is within N days of
  // now. Every other check stays strict. Unset/"" = today's behavior.
  ALLOW_STALE_GOOGLE_IDTOKEN_DAYS?: string;
}

export interface PromptySessionClaims {
  sub: string;
  iat: number;
  exp: number;
  iss: "prompty-relay";
}

export interface GoogleIdentityClaims {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  hd?: string;
}
