import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  interval?: number;
  expires_in?: number;
}

interface DevicePollResponse {
  status: 'ok' | 'pending' | 'error';
  reason?: string;
}

type LoginPhase = 'idle' | 'starting' | 'awaiting' | 'success' | 'error';

/**
 * ZedCode device-flow login panel. The user logs in once (no API key paste):
 * we request a device code, show the user_code + a link to the verification
 * page, then poll until the server confirms the token was stored and the
 * zedmux provider wired into OpenCode.
 */
export const ZedCodeLogin: React.FC = () => {
  const [loggedIn, setLoggedIn] = React.useState<boolean | null>(null);
  const [phase, setPhase] = React.useState<LoginPhase>('idle');
  const [userCode, setUserCode] = React.useState<string>('');
  const [verificationUri, setVerificationUri] = React.useState<string>('');
  const [errorReason, setErrorReason] = React.useState<string>('');

  const pollTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlineRef = React.useRef<number>(0);
  const loadProviders = useConfigStore((state) => state.loadProviders);

  const clearPollTimer = React.useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const refreshStatus = React.useCallback(async () => {
    try {
      const response = await runtimeFetch('/api/zedcode/status');
      if (!response.ok) return;
      const body = (await response.json()) as { loggedIn?: boolean };
      setLoggedIn(body.loggedIn === true);
    } catch {
      // Status is advisory; ignore transient failures.
    }
  }, []);

  React.useEffect(() => {
    void refreshStatus();
    return () => clearPollTimer();
  }, [refreshStatus, clearPollTimer]);

  const scheduleNextPoll = React.useCallback(
    (deviceCode: string, intervalMs: number) => {
      clearPollTimer();
      pollTimerRef.current = setTimeout(() => {
        void poll(deviceCode, intervalMs);
      }, intervalMs);
    },
    // poll is defined below; it is stable via useCallback deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearPollTimer],
  );

  const poll = React.useCallback(
    async (deviceCode: string, intervalMs: number) => {
      if (Date.now() > deadlineRef.current) {
        setPhase('error');
        setErrorReason('expired');
        return;
      }
      try {
        const response = await runtimeFetch('/api/zedcode/login/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: deviceCode }),
        });
        const body = (await response.json()) as DevicePollResponse;
        if (body.status === 'ok') {
          setPhase('success');
          setLoggedIn(true);
          setUserCode('');
          setVerificationUri('');
          toast.success('ZedCode connected');
          void loadProviders({ source: 'zedcode-login' });
          return;
        }
        if (body.status === 'error') {
          setPhase('error');
          setErrorReason(body.reason || 'unknown');
          return;
        }
        scheduleNextPoll(deviceCode, intervalMs);
      } catch {
        scheduleNextPoll(deviceCode, intervalMs);
      }
    },
    [loadProviders, scheduleNextPoll],
  );

  const startLogin = React.useCallback(async () => {
    setPhase('starting');
    setErrorReason('');
    try {
      const response = await runtimeFetch('/api/zedcode/login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new Error(`start failed (${response.status})`);
      }
      const body = (await response.json()) as DeviceStartResponse;
      const intervalMs = Math.max(1, body.interval ?? 5) * 1000;
      const expiresInMs = Math.max(30, body.expires_in ?? 900) * 1000;
      deadlineRef.current = Date.now() + expiresInMs;
      setUserCode(body.user_code || '');
      const uri = body.verification_uri_complete || body.verification_uri || '';
      setVerificationUri(uri);
      setPhase('awaiting');
      if (uri && typeof window !== 'undefined') {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }
      scheduleNextPoll(body.device_code, intervalMs);
    } catch (error) {
      setPhase('error');
      setErrorReason(error instanceof Error ? error.message : 'start_failed');
    }
  }, [scheduleNextPoll]);

  const logout = React.useCallback(async () => {
    clearPollTimer();
    try {
      await runtimeFetch('/api/zedcode/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setLoggedIn(false);
      setPhase('idle');
      toast.success('Signed out of ZedCode');
      void loadProviders({ source: 'zedcode-logout' });
    } catch {
      toast.error('Failed to sign out of ZedCode');
    }
  }, [clearPollTimer, loadProviders]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1">
        <span className="typography-settings-section-title text-foreground">ZedCode</span>
        <span className="typography-settings-description text-muted-foreground">
          Sign in once with ZedCode to use the zedmux provider. No API key required.
        </span>
      </div>

      {loggedIn ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-foreground">Connected to ZedCode</span>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {phase === 'awaiting' && userCode ? (
            <div className="flex flex-col gap-2 rounded-md bg-muted p-3">
              <span className="text-sm text-muted-foreground">
                Enter this code on the ZedCode verification page:
              </span>
              <span className="font-mono text-lg font-semibold tracking-widest text-foreground">
                {userCode}
              </span>
              {verificationUri ? (
                <a
                  href={verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary underline"
                >
                  Open verification page
                </a>
              ) : null}
              <span className="text-xs text-muted-foreground">Waiting for approval…</span>
            </div>
          ) : null}

          {phase === 'error' ? (
            <span className="text-sm text-destructive">
              ZedCode login failed: {errorReason || 'unknown error'}
            </span>
          ) : null}

          <Button
            variant="default"
            size="sm"
            disabled={phase === 'starting' || phase === 'awaiting'}
            onClick={() => void startLogin()}
          >
            {phase === 'starting'
              ? 'Starting…'
              : phase === 'awaiting'
                ? 'Waiting for approval…'
                : 'Login with ZedCode'}
          </Button>
        </div>
      )}
    </div>
  );
};
