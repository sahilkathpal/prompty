import type { Env } from "./types";

// Brokers Google's OAuth token endpoint on the app's behalf so the client
// secret stays server-side and never ships in the Mac app bundle. The app
// runs the PKCE authorize flow itself and posts the resulting code (or a
// refresh token) here; we attach client_id + client_secret and proxy through
// to Google, returning Google's token response verbatim.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  scope?: string;
}

async function postToken(
  env: Env,
  params: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    ...params,
  });
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`google token ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as GoogleTokenResponse;
}

export function exchangeAuthCode(
  env: Env,
  args: { code: string; codeVerifier: string; redirectUri: string },
): Promise<GoogleTokenResponse> {
  return postToken(env, {
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
    grant_type: "authorization_code",
  });
}

export function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<GoogleTokenResponse> {
  return postToken(env, {
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
}
