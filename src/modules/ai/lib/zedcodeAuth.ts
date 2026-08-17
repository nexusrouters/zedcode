import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { KEYRING_SERVICE } from "../config";

/**
 * ZedCode OAuth Device Flow + JWT auto-refresh.
 *
 * ZedCode does not use a manually-pasted API key. The user logs in once via
 * the device flow; the resulting JWT (access + refresh) is stored in the OS
 * keychain and transparently refreshed before it expires. The transport reads
 * a valid access token through `getValidAccessToken()` on every request.
 *
 * Backend (https://api.zedmux.tech):
 *   POST /auth/device/code    { client_id }                -> device_code, user_code, verification_uri(_complete), interval, expires_in
 *   POST /auth/device/token   { device_code }              -> poll: {error:"authorization_pending"} | {error:"access_denied"} | success tokens
 *   POST /auth/device/refresh { refresh_token }            -> rotated tokens | 401/403 (must re-login)
 */

export const ZEDCODE_API_BASE = "https://api.zedmux.tech";
export const ZEDCODE_V1_BASE = `${ZEDCODE_API_BASE}/v1`;
const CLIENT_ID = "zedcode";

// Keychain accounts (service is the shared zedcode-ai keyring).
const ACCOUNT_TOKEN = "zedcode-token"; // access JWT
const ACCOUNT_REFRESH = "zedcode-refresh"; // refresh token
const ACCOUNT_EXP = "zedcode-token-exp"; // access-token expiry, epoch ms

/** Refresh when the access token has less than this many ms of life left. */
const REFRESH_SKEW_MS = 60_000;

type SecretsGet = (account: string) => Promise<string | null>;
type SecretsSet = (account: string, password: string) => Promise<void>;
type SecretsDelete = (account: string) => Promise<void>;

const secretGet: SecretsGet = async (account) => {
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account,
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
};

const secretSet: SecretsSet = async (account, password) => {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account,
    password,
  });
};

const secretDelete: SecretsDelete = async (account) => {
  try {
    await invoke("secrets_delete", { service: KEYRING_SERVICE, account });
  } catch {
    // already absent — fine
  }
};

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type TokenSuccess = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
};

type TokenError = {
  error: string;
  error_description?: string;
};

async function postJson<T>(path: string, body: unknown): Promise<{
  status: number;
  data: T;
}> {
  const res = await fetch(`${ZEDCODE_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  return { status: res.status, data };
}

async function persistTokens(t: TokenSuccess): Promise<void> {
  const expMs = Date.now() + Math.max(0, t.expires_in) * 1000;
  await secretSet(ACCOUNT_TOKEN, t.access_token);
  await secretSet(ACCOUNT_REFRESH, t.refresh_token);
  await secretSet(ACCOUNT_EXP, String(expMs));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type DeviceLoginCallbacks = {
  /** Called once the device code is issued, so the UI can show the user code. */
  onCode?: (info: DeviceCodeResponse) => void;
  abortSignal?: AbortSignal;
};

export type DeviceLoginResult =
  | { ok: true }
  | { ok: false; reason: "denied" | "expired" | "aborted" | "error"; message?: string };

/**
 * Full device-flow login: request a code, open the verification page, poll for
 * the token, and persist it. Resolves once login succeeds or terminally fails.
 */
export async function startDeviceLogin(
  cb: DeviceLoginCallbacks = {},
): Promise<DeviceLoginResult> {
  const { status, data } = await postJson<DeviceCodeResponse | TokenError>(
    "/auth/device/code",
    { client_id: CLIENT_ID },
  );
  if (status >= 400 || !(data as DeviceCodeResponse).device_code) {
    const err = data as TokenError;
    return { ok: false, reason: "error", message: err.error_description || err.error };
  }
  const code = data as DeviceCodeResponse;
  cb.onCode?.(code);

  const verifyUrl = code.verification_uri_complete || code.verification_uri;
  if (verifyUrl) {
    try {
      await openUrl(verifyUrl);
    } catch {
      // Non-fatal: the UI still shows the URL + user code to enter manually.
    }
  }

  const deadline = Date.now() + Math.max(1, code.expires_in) * 1000;
  let intervalMs = Math.max(1, code.interval || 5) * 1000;

  while (Date.now() < deadline) {
    if (cb.abortSignal?.aborted) return { ok: false, reason: "aborted" };
    await sleep(intervalMs);
    if (cb.abortSignal?.aborted) return { ok: false, reason: "aborted" };

    const poll = await postJson<TokenSuccess | TokenError>(
      "/auth/device/token",
      { device_code: code.device_code },
    );
    const body = poll.data as TokenSuccess & TokenError;
    if (body.access_token) {
      await persistTokens(body as TokenSuccess);
      return { ok: true };
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5_000;
        continue;
      case "access_denied":
        return {
          ok: false,
          reason: "denied",
          message:
            body.error_description ||
            "Access denied — this account has no active Coding Plan.",
        };
      case "expired_token":
        return { ok: false, reason: "expired" };
      default:
        // Unknown transient error — keep polling until the deadline.
        continue;
    }
  }
  return { ok: false, reason: "expired" };
}

/** Try to swap the refresh token for a fresh access token. */
async function refreshTokens(refreshToken: string): Promise<string | null> {
  const { status, data } = await postJson<TokenSuccess | TokenError>(
    "/auth/device/refresh",
    { refresh_token: refreshToken },
  );
  if (status === 401 || status === 403 || status >= 400) {
    // Refresh rejected — the stored session is dead; force a re-login.
    await logoutZedcode();
    return null;
  }
  const t = data as TokenSuccess;
  if (!t.access_token) {
    await logoutZedcode();
    return null;
  }
  await persistTokens(t);
  return t.access_token;
}

/**
 * Return a currently-valid access token, refreshing it first when it is within
 * `REFRESH_SKEW_MS` of expiry. Returns null when the user is not logged in or
 * the refresh failed (caller should prompt for login).
 */
export async function getValidAccessToken(): Promise<string | null> {
  const [access, expRaw, refresh] = await Promise.all([
    secretGet(ACCOUNT_TOKEN),
    secretGet(ACCOUNT_EXP),
    secretGet(ACCOUNT_REFRESH),
  ]);
  if (!access) return null;

  const expMs = expRaw ? Number(expRaw) : 0;
  const fresh = Number.isFinite(expMs) && expMs - Date.now() > REFRESH_SKEW_MS;
  if (fresh) return access;

  if (refresh) {
    const next = await refreshTokens(refresh);
    if (next) return next;
    return null;
  }
  // No refresh token but access still nominally present — use it as-is.
  return access;
}

/** Remove all three stored ZedCode secrets. */
export async function logoutZedcode(): Promise<void> {
  await Promise.all([
    secretDelete(ACCOUNT_TOKEN),
    secretDelete(ACCOUNT_REFRESH),
    secretDelete(ACCOUNT_EXP),
  ]);
}

/** Whether a ZedCode access token is stored (does not validate it remotely). */
export async function isLoggedIn(): Promise<boolean> {
  return (await secretGet(ACCOUNT_TOKEN)) !== null;
}

export type ZedcodeModel = { id: string; label?: string };

/** Fetch the model list the user's Coding Plan grants. Never hardcoded. */
export async function fetchZedcodeModels(): Promise<ZedcodeModel[]> {
  const token = await getValidAccessToken();
  if (!token) return [];
  try {
    const res = await fetch(`${ZEDCODE_V1_BASE}/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => ({ id: m.id, label: m.id }));
  } catch {
    return [];
  }
}
