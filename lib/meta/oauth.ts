import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { getEncryptionKeyHex, requireEnv } from "@/lib/env";

// Instagram API with Instagram Login authorizes on www.instagram.com. The old
// api.instagram.com/oauth/authorize host belonged to the retired Basic Display
// API and now 404s ("Sorry, this page isn't available"), which looks like a bad
// link rather than a wrong endpoint. The token exchange below still lives on
// api.instagram.com — only the authorize hop moved.
const INSTAGRAM_OAUTH_URL = "https://www.instagram.com/oauth/authorize";
const INSTAGRAM_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface OAuthStatePayload {
  workspaceId: string;
  ts: number;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signState(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(payload)
    .digest("base64url");
}

export function createOAuthState(workspaceId: string): string {
  const payload = base64UrlEncode(
    JSON.stringify({ workspaceId, ts: Date.now() } satisfies OAuthStatePayload)
  );
  return `${payload}.${signState(payload)}`;
}

export function verifyOAuthState(state: string | null): OAuthStatePayload | null {
  if (!state) return null;

  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;

  const expected = signState(payload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as OAuthStatePayload;
    if (typeof parsed.workspaceId !== "string" || !parsed.workspaceId) {
      return null;
    }

    // Reject a missing or non-numeric timestamp. `Date.now() - "abc"` is NaN,
    // and every comparison against NaN is false, so a non-numeric ts would
    // otherwise pass the age check and never expire. A ts in the future is
    // rejected for the same reason: it has not aged at all.
    if (typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) {
      return null;
    }

    const age = Date.now() - parsed.ts;
    if (age < 0 || age > STATE_MAX_AGE_MS) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function getAuthorizationUrl(redirectUri: string, state: string): string {
  const configId = process.env.INSTAGRAM_LOGIN_CONFIG_ID;
  if (configId) {
    // Newer Meta apps only get Unified login: a Facebook Login for Business
    // configuration instead of the Instagram Login product.
    const fb = new URLSearchParams({
      client_id: requireEnv("INSTAGRAM_APP_ID"),
      config_id: configId,
      redirect_uri: redirectUri,
      response_type: "code",
      override_default_response_type: "true",
      state,
    });
    return `https://www.facebook.com/dialog/oauth?${fb.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    redirect_uri: redirectUri,
    scope:
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights",
    response_type: "code",
    state,
  });

  return `${INSTAGRAM_OAUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; userId: string }> {
  const body = new URLSearchParams({
    client_id: requireEnv("INSTAGRAM_APP_ID"),
    client_secret: requireEnv("INSTAGRAM_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(INSTAGRAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Token exchange failed: ${error.error_message || JSON.stringify(error)}`
    );
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    userId: String(data.user_id),
  };
}

// PROBE: reports what a Unified login code yields, without storing anything.
// Never includes a token in the output.
export async function probeUnifiedLogin(
  code: string,
  redirectUri: string
): Promise<string> {
  const v = process.env.META_GRAPH_API_VERSION ?? "v25.0";
  const get = async (url: string) => {
    const r = await fetch(url);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let tok = { status: 0, body: {} as Record<string, any> };
  let used = "none";
  const tried: string[] = [];
  for (const name of ["FACEBOOK_APP_SECRET", "INSTAGRAM_APP_SECRET"]) {
    const secret = process.env[name]?.trim();
    if (!secret) continue;
    tok = await get(
      `https://graph.facebook.com/${v}/oauth/access_token?` +
        new URLSearchParams({
          client_id: requireEnv("INSTAGRAM_APP_ID"),
          client_secret: secret,
          redirect_uri: redirectUri,
          code,
        })
    );
    tried.push(`${name}=${tok.status}`);
    if (tok.body?.access_token) {
      used = name;
      break;
    }
  }
  const token = tok.body?.access_token as string | undefined;
  if (!token)
    return `exchange ${tried.join(",")} ${JSON.stringify(tok.body?.error?.message ?? tok.body)}`;
  const fb = "https://graph.facebook.com";
  const q = (path: string, fields: string) =>
    get(`${fb}/${v}/${path}?${new URLSearchParams({ fields, access_token: token })}`);
  const dbg = await get(
    `${fb}/${v}/debug_token?${new URLSearchParams({
      input_token: token,
      access_token: `${requireEnv("INSTAGRAM_APP_ID")}|${process.env[used]!.trim()}`,
    })}`
  );
  const d = dbg.body?.data ?? {};
  const scopes: { permission: string; target_ids?: string[] }[] = d.granular_scopes ?? [];
  const igIds = [...new Set(scopes.flatMap((x) => x.target_ids ?? []))];
  const per = [];
  for (const id of igIds.slice(0, 2)) {
    const acct = await q(id, "username,name");
    const conv = await get(
      `${fb}/${v}/${id}/conversations?${new URLSearchParams({ platform: "instagram", limit: "1", access_token: token })}`
    );
    per.push({
      id,
      acct: acct.body?.error ? acct.body.error.message : acct.body?.username,
      conv: conv.body?.error ? conv.body.error.message : "ok",
    });
  }
  return JSON.stringify({
    secret: used,
    exp: d.expires_at,
    scopes: scopes.map((x) => `${x.permission}:${x.target_ids?.length ?? 0}`),
    per,
    dbgErr: dbg.body?.error?.message,
  });
}

function getEncryptionKey(): Buffer {
  return Buffer.from(getEncryptionKeyHex(), "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, authTag, encrypted]);

  return combined.toString("base64");
}

export function decryptToken(encryptedBase64: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(encryptedBase64, "base64");

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}
