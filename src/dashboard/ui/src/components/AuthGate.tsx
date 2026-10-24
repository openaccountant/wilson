import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dispatchAuthSession } from '@webmcp-session';
import { App } from '@/App';
import { api, getBaseUrl } from '@/api';
import {
  bearerHeader,
  coalesced,
  isSessionStorageChange,
  migrateLegacyAuthToken,
  onSessionChange,
  readAuthToken,
  settleAuthCheck,
  writeAuthToken,
  type AuthCheck,
  type AuthGateView,
  type AuthStatusResponse,
} from '@/lib/authSession';
import { apiErrorMessage, firstAdminBody, validateFirstAdmin } from '@/lib/firstAdmin';
import { AGENT_ACCESS_HINT, signInBlockedReason, whatThisIs } from '@/lib/signInCopy';
import { lockMirror, suspendMirror, unlockMirror } from '@/store/mirror-client';
import { noteAuthEnabled, offlineLoginRequired, readMirrorOwner, writeMirrorOwner } from '@/store/mirror-session';

function localStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * GET /api/auth/status with the stored token. A raw fetch rather than api(): an unreachable server must read as
 * "offline" (the app then serves the mirror), never as a mirror answer for this path.
 */
async function checkAuth(): Promise<AuthCheck> {
  const sentToken = readAuthToken();
  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}/api/auth/status`, { headers: bearerHeader(sentToken) });
  } catch {
    return { kind: 'network-error' };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { kind: 'http-error', message: apiErrorMessage(new Error(`API ${res.status}: ${body}`), `The dashboard server answered ${res.status}.`) };
  }
  try {
    return { kind: 'status', status: (await res.json()) as AuthStatusResponse, sentToken };
  } catch {
    return { kind: 'http-error', message: 'The dashboard server sent an unreadable answer.' };
  }
}

/**
 * The dashboard's front door. With auth on and no valid login it shows the login form (or, for a profile with
 * auth on and no users, the first-admin setup) instead of the app; it re-checks whenever a request comes back 401,
 * this tab changes auth, or another tab logs in or out. The app mounts only once a check lets it, and is rebuilt
 * for a new login, so nothing loaded for the old session survives.
 *
 * The offline mirror follows the same decision: it is unlocked only for the app, and wiped before every login or
 * setup screen and before the app opens for a different login (or one whose copy has no known owner, as a pre-0.10
 * mirror). Offline, a profile with auth on and no stored login
 * gets the login form, never the mirror.
 */
export function AuthGate() {
  const [view, setView] = useState<AuthGateView>({ kind: 'checking' });
  const [generation, setGeneration] = useState(0);
  const viewRef = useRef(view);
  // Whose login the mirror was last unlocked for, whatever screen shows now (settleAuthCheck wipes on a change).
  const mirrorOwnerRef = useRef(readMirrorOwner(localStore()));

  const recheck = useMemo(
    () =>
      coalesced(async () => {
        const check = await checkAuth();
        const storage = localStore();
        // Only "on" is recorded: the status names no profile, and an "off" for the server's active one must not
        // unlock another profile's offline copy (only a sync pull, which knows its profile, clears a flag).
        if (check.kind === 'status' && check.status.authEnabled) noteAuthEnabled(storage);
        const offlineLocked = offlineLoginRequired(storage, readAuthToken() !== null);
        const { view: next, remount, wipe, session, mirrorOwner } = settleAuthCheck(
          check, viewRef.current, undefined, offlineLocked, mirrorOwnerRef.current,
        );
        if (session === 'ended') dispatchAuthSession('ended');
        // Wipe before the login view shows (or before the app opens for another login); unlock before the app
        // mounts and starts its first sync. No other screen reads the mirror, so it stays shut behind them.
        if (wipe) await lockMirror();
        mirrorOwnerRef.current = mirrorOwner;
        writeMirrorOwner(storage, mirrorOwner);
        if (next.kind === 'app') await unlockMirror();
        else if (!wipe) suspendMirror();
        if (remount) setGeneration((g) => g + 1);
        viewRef.current = next;
        setView(next);
        if (session === 'started') dispatchAuthSession('started');
      }),
    [],
  );

  useEffect(() => {
    migrateLegacyAuthToken();
    void recheck();
  }, [recheck]);

  useEffect(() => onSessionChange(() => void recheck()), [recheck]);

  // Back online: the offline login form (or an app serving the mirror) checks again.
  useEffect(() => {
    const onOnline = () => void recheck();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [recheck]);

  // Another tab logged in or out (storage events only reach the OTHER tabs of this origin).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (isSessionStorageChange(e.key)) void recheck();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [recheck]);

  const loggedIn = useCallback((token: string) => {
    writeAuthToken(token);
    void recheck();
  }, [recheck]);

  switch (view.kind) {
    case 'checking':
      return <div className="h-screen bg-bg" aria-busy="true" />;
    case 'app':
      return <App key={generation} />;
    case 'login':
      return <LoginView sessionEnded={view.sessionEnded} offline={view.offline === true} onLoggedIn={loggedIn} onRecheck={() => void recheck()} />;
    case 'setup':
      return <SetupView onLoggedIn={loggedIn} onRecheck={() => void recheck()} />;
    case 'unavailable':
      return (
        <GateCard title="Dashboard unavailable">
          <p role="alert" className="text-sm text-text-muted">{view.message}</p>
          <button
            type="button"
            onClick={() => void recheck()}
            className="w-full bg-border-muted text-text border border-border rounded-md px-3 py-2 text-sm cursor-pointer hover:bg-surface"
          >
            Try again
          </button>
        </GateCard>
      );
  }
}

function GateCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="h-screen bg-bg flex items-center justify-center px-4 overflow-auto">
      <div className="w-full max-w-sm bg-surface-raised border border-border rounded-lg p-6 space-y-4">
        <div>
          <div className="text-lg font-semibold text-text">
            <span className="text-green">$</span> Wilson
          </div>
          <p className="text-sm text-text-muted mt-1">{whatThisIs(window.location.hostname)}</p>
          <h1 className="text-xs text-text-secondary uppercase tracking-wide mt-3">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputClass = 'w-full bg-surface border border-border rounded-md px-3 py-2 text-sm text-text';
const submitClass =
  'w-full bg-green text-black rounded-md px-3 py-2 text-sm font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed';

function LoginView({
  sessionEnded,
  offline,
  onLoggedIn,
  onRecheck,
}: {
  sessionEnded: boolean;
  offline: boolean;
  onLoggedIn: (token: string) => void;
  onRecheck: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocked = signInBlockedReason(username, password);

  async function submit() {
    if (blocked) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setPassword('');
      onLoggedIn(res.token);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not sign in.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateCard title="Sign in">
      {offline ? (
        <div role="status" className="space-y-2">
          <p className="text-sm text-text-muted">
            You're offline. This profile requires a sign-in, and its offline copy is never shown without one. Sign
            in when the Wilson server is reachable.
          </p>
          <button
            type="button"
            onClick={onRecheck}
            className="w-full bg-border-muted text-text border border-border rounded-md px-3 py-2 text-sm cursor-pointer hover:bg-surface"
          >
            Try again
          </button>
        </div>
      ) : sessionEnded && (
        <p className="text-sm text-text-muted">Your session has ended. Sign in to continue.</p>
      )}
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          autoComplete="username"
          aria-label="Username"
          autoFocus
          className={inputClass}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          aria-label="Password"
          className={inputClass}
        />
        <button
          type="submit"
          disabled={busy || blocked !== null}
          aria-describedby={blocked ? 'sign-in-blocked' : undefined}
          className={submitClass}
        >
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        {blocked && !busy && <p id="sign-in-blocked" className="text-xs text-text-muted">{blocked}</p>}
        {error && <div role="alert" className="text-xs text-red">{error}</div>}
      </form>
      <p className="text-xs text-text-muted border-t border-border pt-3">{AGENT_ACCESS_HINT}</p>
    </GateCard>
  );
}

/**
 * Auth is on but the profile has no users, so nobody can log in: the only way in is POST /api/auth/setup, which
 * the server allows exactly while no user exists. Losing a race to another setup re-checks (and lands on login).
 */
function SetupView({ onLoggedIn, onRecheck }: { onLoggedIn: (token: string) => void; onRecheck: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    const input = { username, password, confirm };
    const problem = validateFirstAdmin(input);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token?: string }>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify(firstAdminBody(input)),
      });
      setPassword('');
      setConfirm('');
      if (res.token) onLoggedIn(res.token);
      else onRecheck();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the admin account.'));
      // Someone else may have created the first user meanwhile; the status check then offers the login form.
      onRecheck();
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateCard title="Create the admin account">
      <p className="text-sm text-text-muted">
        Authentication is on for this profile but it has no accounts yet. Create the first admin to sign in.
      </p>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          autoComplete="username"
          aria-label="Admin username"
          autoFocus
          className={inputClass}
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="new-password"
          aria-label="Admin password"
          className={inputClass}
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm password"
          autoComplete="new-password"
          aria-label="Confirm admin password"
          className={inputClass}
        />
        <button type="submit" disabled={busy || !username.trim() || !password || !confirm} className={submitClass}>
          {busy ? 'Creating...' : 'Create admin & sign in'}
        </button>
        {error && <div role="alert" className="text-xs text-red">{error}</div>}
      </form>
    </GateCard>
  );
}
