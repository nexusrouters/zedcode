/**
 * ZedCode device-flow authentication + zedmux provider wiring for OpenCode.
 *
 * OpenChamber is a GUI on top of the OpenCode CLI. AI providers are configured
 * in OpenCode, not OpenChamber, via two files in the HOME of the process that
 * runs `opencode serve`:
 *
 *   - Config:      ~/.config/opencode/opencode.json  (provider registry)
 *   - Credentials: ~/.local/share/opencode/auth.json (api keys / tokens)
 *
 * This module lets a user log in ONCE through the ZedCode device-flow (no API
 * key paste). The short-lived JWT it returns is injected as the "zedmux"
 * provider credential so the OpenChamber agent talks to zedmux transparently.
 *
 * All writes MERGE: existing providers / auth entries / settings are preserved.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Auth service host (device-flow) is a DIFFERENT host from the API host.
const ZEDCODE_AUTH_BASE = 'https://zedmux.tech';
const ZEDMUX_API_BASE = 'https://api.zedmux.tech/v1';
const ZEDCODE_CLIENT_ID = 'zedcode';
const ZEDMUX_PROVIDER_ID = 'zedmux';
const ZEDMUX_PROVIDER_NAME = 'ZedCode (zedmux)';
// Refresh the access token when it is within this many ms of expiry.
const TOKEN_REFRESH_SKEW_MS = 60_000;

// --- Paths ---------------------------------------------------------------

const OPENCHAMBER_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'openchamber');
const ZEDCODE_AUTH_FILE = path.join(OPENCHAMBER_DATA_DIR, 'zedcode-auth.json');

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), '.config', 'opencode');
const OPENCODE_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const OPENCODE_AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

// --- Small JSON helpers --------------------------------------------------

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[ZedCode] Failed to read ${filePath}: ${error?.message || error}`);
    return null;
  }
}

function writeJsonFileSecure(filePath, data, mode) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, mode); } catch { /* best effort */ }
  }
}

// --- Token store ---------------------------------------------------------

/**
 * @typedef {Object} ZedcodeTokens
 * @property {string} access_token
 * @property {string} [refresh_token]
 * @property {number} exp_ms   absolute epoch ms when access_token expires
 */

/** Reads the stored device-flow tokens, or null when not logged in. */
function readStoredTokens() {
  const data = readJsonFile(ZEDCODE_AUTH_FILE);
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    return null;
  }
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    exp_ms: Number.isFinite(data.exp_ms) ? data.exp_ms : 0,
  };
}

/** Persists device-flow tokens to a 0600 file in the OpenChamber data dir. */
function writeStoredTokens(tokens) {
  writeJsonFileSecure(ZEDCODE_AUTH_FILE, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    exp_ms: tokens.exp_ms,
  }, 0o600);
}

/** Removes the stored token file. Safe to call when already logged out. */
function clearStoredTokens() {
  try {
    if (fs.existsSync(ZEDCODE_AUTH_FILE)) fs.rmSync(ZEDCODE_AUTH_FILE);
  } catch (error) {
    console.warn(`[ZedCode] Failed to remove token file: ${error?.message || error}`);
  }
}

function expiresInToExpMs(expiresInSeconds) {
  const seconds = Number.isFinite(expiresInSeconds) ? expiresInSeconds : 0;
  return Date.now() + Math.max(0, seconds) * 1000;
}

function isLoggedIn() {
  return readStoredTokens() !== null;
}

// --- Device-flow HTTP ----------------------------------------------------

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await response.json(); } catch { /* ignore parse error */ }
  return { ok: response.ok, status: response.status, json };
}

/**
 * Starts a device-flow login. Returns the fields the UI needs to prompt the
 * user; never returns tokens.
 */
async function startDeviceLogin() {
  const { ok, status, json } = await postJson(`${ZEDCODE_AUTH_BASE}/auth/device/code`, {
    client_id: ZEDCODE_CLIENT_ID,
  });
  if (!ok || !json || typeof json.device_code !== 'string') {
    throw new Error(`Device code request failed (status ${status})`);
  }
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    verification_uri_complete: json.verification_uri_complete,
    interval: Number.isFinite(json.interval) ? json.interval : 5,
    expires_in: Number.isFinite(json.expires_in) ? json.expires_in : 900,
  };
}

/**
 * Polls the device-flow token endpoint ONCE.
 * @returns {Promise<{status:'ok'|'pending'|'error', reason?:string}>}
 */
async function pollDeviceLogin(deviceCode) {
  if (!deviceCode || typeof deviceCode !== 'string') {
    return { status: 'error', reason: 'missing_device_code' };
  }
  const { ok, json } = await postJson(`${ZEDCODE_AUTH_BASE}/auth/device/token`, {
    device_code: deviceCode,
  });

  if (ok && json && typeof json.access_token === 'string') {
    writeStoredTokens({
      access_token: json.access_token,
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      exp_ms: expiresInToExpMs(json.expires_in),
    });
    return { status: 'ok' };
  }

  const reason = json && typeof json.error === 'string' ? json.error : 'unknown';
  if (reason === 'authorization_pending' || reason === 'slow_down') {
    return { status: 'pending' };
  }
  return { status: 'error', reason };
}

/**
 * Refreshes the access token using the stored refresh token.
 * @returns {Promise<ZedcodeTokens|null>} the refreshed tokens, or null when the
 *   refresh failed (the caller must treat this as "needs re-login").
 */
async function refreshAccessToken(refreshToken) {
  if (!refreshToken) return null;
  try {
    const { ok, json } = await postJson(`${ZEDCODE_AUTH_BASE}/auth/device/refresh`, {
      refresh_token: refreshToken,
    });
    if (!ok || !json || typeof json.access_token !== 'string') {
      return null;
    }
    return {
      access_token: json.access_token,
      // The endpoint rotates the refresh token; fall back to the old one if
      // the response omits it.
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : refreshToken,
      exp_ms: expiresInToExpMs(json.expires_in),
    };
  } catch (error) {
    console.warn(`[ZedCode] Token refresh failed: ${error?.message || error}`);
    return null;
  }
}

/**
 * Returns a valid access token, refreshing (and re-persisting) if it is within
 * the skew window of expiry. Returns null when there is no session or the
 * refresh failed (caller should surface "please log in again").
 */
async function getValidAccessToken() {
  const tokens = readStoredTokens();
  if (!tokens) return null;

  const needsRefresh = tokens.exp_ms - Date.now() < TOKEN_REFRESH_SKEW_MS;
  if (!needsRefresh) {
    return tokens.access_token;
  }

  const refreshed = await refreshAccessToken(tokens.refresh_token);
  if (!refreshed) {
    return null;
  }
  writeStoredTokens(refreshed);
  return refreshed.access_token;
}

// --- Model discovery -----------------------------------------------------

/**
 * Fetches the zedmux model catalog. Returns an OpenCode-shaped
 * { <modelId>: { name } } map, or {} on any failure (OpenCode can still use
 * arbitrary model ids without an entry here).
 */
async function fetchZedmuxModels(accessToken) {
  try {
    const response = await fetch(`${ZEDMUX_API_BASE}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!response.ok) return {};
    const json = await response.json().catch(() => null);
    const list = Array.isArray(json?.data) ? json.data : [];
    /** @type {Record<string, { name: string }>} */
    const models = {};
    for (const entry of list) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) continue;
      models[id] = { name: entry?.name && typeof entry.name === 'string' ? entry.name : id };
    }
    return models;
  } catch (error) {
    console.warn(`[ZedCode] Model discovery failed: ${error?.message || error}`);
    return {};
  }
}

// --- OpenCode config / auth merge ---------------------------------------

/**
 * Merges the "zedmux" provider into ~/.config/opencode/opencode.json without
 * disturbing any other provider or top-level setting. Model list is populated
 * from the zedmux catalog when a token is available; on failure models stay
 * empty (OpenCode still accepts any model id).
 */
async function ensureOpencodeZedmuxConfig(accessToken) {
  const config = readJsonFile(OPENCODE_CONFIG_FILE) || {};
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    console.warn('[ZedCode] opencode.json is not an object; skipping provider merge');
    return false;
  }

  const provider = (config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider))
    ? config.provider
    : {};

  const existing = (provider[ZEDMUX_PROVIDER_ID] && typeof provider[ZEDMUX_PROVIDER_ID] === 'object')
    ? provider[ZEDMUX_PROVIDER_ID]
    : {};
  const existingOptions = (existing.options && typeof existing.options === 'object') ? existing.options : {};
  const existingModels = (existing.models && typeof existing.models === 'object') ? existing.models : {};

  let models = existingModels;
  if (accessToken) {
    const fetched = await fetchZedmuxModels(accessToken);
    if (Object.keys(fetched).length > 0) {
      // Merge discovered models over existing ones (do not drop user-added ids).
      models = { ...existingModels, ...fetched };
    }
  }

  provider[ZEDMUX_PROVIDER_ID] = {
    ...existing,
    npm: '@ai-sdk/openai-compatible',
    name: ZEDMUX_PROVIDER_NAME,
    options: { ...existingOptions, baseURL: ZEDMUX_API_BASE },
    models,
  };

  config.provider = provider;

  try {
    writeJsonFileSecure(OPENCODE_CONFIG_FILE, config, 0o644);
    return true;
  } catch (error) {
    console.warn(`[ZedCode] Failed to write opencode.json: ${error?.message || error}`);
    return false;
  }
}

/**
 * Merges { zedmux: { type:'api', key:<token> } } into auth.json (0600),
 * preserving every other credential entry.
 */
function syncOpencodeAuth(accessToken) {
  if (!accessToken) return false;
  const auth = readJsonFile(OPENCODE_AUTH_FILE) || {};
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
    console.warn('[ZedCode] auth.json is not an object; skipping auth merge');
    return false;
  }
  auth[ZEDMUX_PROVIDER_ID] = { type: 'api', key: accessToken };
  try {
    writeJsonFileSecure(OPENCODE_AUTH_FILE, auth, 0o600);
    return true;
  } catch (error) {
    console.warn(`[ZedCode] Failed to write auth.json: ${error?.message || error}`);
    return false;
  }
}

/** Removes the zedmux credential entry from auth.json (leaves others intact). */
function removeOpencodeZedmuxAuth() {
  const auth = readJsonFile(OPENCODE_AUTH_FILE);
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return false;
  if (!auth[ZEDMUX_PROVIDER_ID]) return false;
  delete auth[ZEDMUX_PROVIDER_ID];
  try {
    writeJsonFileSecure(OPENCODE_AUTH_FILE, auth, 0o600);
    return true;
  } catch (error) {
    console.warn(`[ZedCode] Failed to update auth.json on logout: ${error?.message || error}`);
    return false;
  }
}

/**
 * Full sync: refresh (if needed) the token, then write the zedmux provider
 * into opencode.json and the credential into auth.json. Best-effort and never
 * throws — safe to call on every server / OpenCode startup.
 * @returns {Promise<boolean>} true when a token was available and synced.
 */
async function syncZedmux() {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return false;
    await ensureOpencodeZedmuxConfig(accessToken);
    syncOpencodeAuth(accessToken);
    return true;
  } catch (error) {
    console.warn(`[ZedCode] syncZedmux failed: ${error?.message || error}`);
    return false;
  }
}

/** Logs out: drop the stored session and the zedmux auth.json entry. */
function logout() {
  clearStoredTokens();
  removeOpencodeZedmuxAuth();
}

export {
  ZEDMUX_PROVIDER_ID,
  ZEDCODE_AUTH_FILE,
  isLoggedIn,
  startDeviceLogin,
  pollDeviceLogin,
  getValidAccessToken,
  fetchZedmuxModels,
  ensureOpencodeZedmuxConfig,
  syncOpencodeAuth,
  removeOpencodeZedmuxAuth,
  syncZedmux,
  logout,
};
