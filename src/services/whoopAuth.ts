// WHOOP OAuth2 (single user). Tokens live in whoop_tokens (one row).
// Flow: GET /auth/whoop → WHOOP consent → /auth/whoop/callback → store tokens.
// getAccessToken() transparently refreshes when the token is near expiry.

import crypto from 'node:crypto';
import { one, q } from '../lib/db.js';

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const SCOPES = 'read:recovery read:cycles read:sleep read:workout offline';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see .env.example`);
  return v;
}

/** Build the consent URL to redirect the browser to. */
export function authorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: env('WHOOP_CLIENT_ID'),
    redirect_uri: env('WHOOP_REDIRECT_URI'),
    response_type: 'code',
    scope: SCOPES,
    state: crypto.randomBytes(8).toString('hex'), // WHOOP requires ≥8 chars
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

async function requestToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('WHOOP_CLIENT_ID'),
      client_secret: env('WHOOP_CLIENT_SECRET'),
      ...body,
    }),
  });
  if (!res.ok) {
    throw new Error(`WHOOP token request failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

async function storeTokens(t: TokenResponse): Promise<void> {
  await q(
    `INSERT INTO whoop_tokens (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, $1, $2, now() + ($3 || ' seconds')::interval, now())
     ON CONFLICT (id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [t.access_token, t.refresh_token, String(t.expires_in)]
  );
}

/** Exchange the ?code from the callback for tokens and store them. */
export async function handleCallback(code: string): Promise<void> {
  const tokens = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env('WHOOP_REDIRECT_URI'),
  });
  await storeTokens(tokens);
}

/** Get a valid access token, refreshing if it expires within 2 minutes. */
export async function getAccessToken(): Promise<string> {
  const row = await one<{ access_token: string; refresh_token: string; fresh: boolean }>(
    `SELECT access_token, refresh_token,
            (expires_at > now() + interval '2 minutes') AS fresh
     FROM whoop_tokens WHERE id = 1`
  );
  if (!row) throw new Error('WHOOP not connected — visit /auth/whoop first');
  if (row.fresh) return row.access_token;

  const tokens = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
    scope: 'offline',
  });
  await storeTokens(tokens);
  return tokens.access_token;
}
