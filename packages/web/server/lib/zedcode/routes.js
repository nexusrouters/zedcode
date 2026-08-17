/**
 * HTTP endpoints for the ZedCode device-flow login, consumed by the UI.
 *
 * These wrap the device-flow module: they never leak tokens to the client.
 * On a successful poll the access token is stored server-side and the zedmux
 * provider + credential are synced into OpenCode's config/auth files.
 */

import {
  isLoggedIn,
  startDeviceLogin,
  pollDeviceLogin,
  syncZedmux,
  logout,
} from './zedcode-auth.js';

export function registerZedcodeRoutes(app, { express }) {
  // Device codes we have issued this process lifetime. Used only to reject
  // obviously-forged poll requests; the real authority is the auth service.
  const issuedDeviceCodes = new Set();

  // Keep the injected zedmux token fresh while the server runs: getValidAccessToken
  // (inside syncZedmux) refreshes tokens within the skew window and rewrites
  // auth.json. Only does work when a session exists; otherwise it is a cheap
  // no-op. unref() so this never keeps the process alive on its own.
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  const refreshTimer = setInterval(() => {
    if (!isLoggedIn()) return;
    void syncZedmux();
  }, REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();

  // Begin a device-flow login. Returns the user-facing code + verification URL.
  app.post('/api/zedcode/login/start', express.json({ limit: '4kb' }), async (_req, res) => {
    try {
      const info = await startDeviceLogin();
      issuedDeviceCodes.add(info.device_code);
      res.json({
        device_code: info.device_code,
        user_code: info.user_code,
        verification_uri: info.verification_uri,
        verification_uri_complete: info.verification_uri_complete,
        interval: info.interval,
        expires_in: info.expires_in,
      });
    } catch (error) {
      res.status(502).json({ error: error?.message || 'Failed to start ZedCode login' });
    }
  });

  // Poll once for the device-flow result. On success, sync OpenCode config/auth.
  app.post('/api/zedcode/login/poll', express.json({ limit: '4kb' }), async (req, res) => {
    const deviceCode = typeof req.body?.device_code === 'string' ? req.body.device_code.trim() : '';
    if (!deviceCode) {
      res.status(400).json({ status: 'error', reason: 'missing_device_code' });
      return;
    }
    try {
      const result = await pollDeviceLogin(deviceCode);
      if (result.status === 'ok') {
        issuedDeviceCodes.delete(deviceCode);
        // Wire zedmux into OpenCode immediately so a running/next OpenCode
        // picks up the provider without a manual restart step from the user.
        await syncZedmux();
      } else if (result.status === 'error') {
        issuedDeviceCodes.delete(deviceCode);
      }
      res.json(result);
    } catch (error) {
      res.status(502).json({ status: 'error', reason: error?.message || 'poll_failed' });
    }
  });

  // Whether a ZedCode session currently exists on this server.
  app.get('/api/zedcode/status', (_req, res) => {
    res.json({ loggedIn: isLoggedIn() });
  });

  // Drop the stored session and remove the zedmux credential from auth.json.
  app.post('/api/zedcode/logout', express.json({ limit: '1kb' }), (_req, res) => {
    try {
      logout();
      res.json({ status: 'ok' });
    } catch (error) {
      res.status(500).json({ status: 'error', reason: error?.message || 'logout_failed' });
    }
  });
}
