import { useEffect, useState } from 'react';
import { UnauthorizedError } from '../api';
import { login } from '../store';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Device approval (docs/identity.md): the password was right, but an owner must approve this browser first. The page
  // asks again every 10 seconds, for up to 30 minutes, and signs in once they have.
  const [pending, setPending] = useState<{ text: string; since: number } | null>(null);

  const attempt = async (quiet: boolean) => {
    if (!quiet) {
      setBusy(true);
      setErr(null);
    }
    try {
      const r = await login(username.trim(), password);
      setPending(r.pending ? (p) => p ?? { text: r.pending!, since: Date.now() } : null);
    } catch (ex) {
      setPending(null);
      setErr(ex instanceof UnauthorizedError ? 'Wrong username or password.' : ex instanceof Error ? ex.message : String(ex));
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  useEffect(() => {
    if (!pending) return;
    if (Date.now() - pending.since > 30 * 60_000) {
      setPending(null);
      setErr('Nobody approved this device yet. Sign in again once an owner has.');
      return;
    }
    const t = setTimeout(() => void attempt(true), 10_000);
    return () => clearTimeout(t);
  });

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!username.trim() || !password) return;
          await attempt(false);
        }}
      >
        <svg viewBox="0 0 32 32" width="44" height="44" aria-hidden>
          <rect width="32" height="32" rx="7" fill="var(--panel-2)" />
          <path d="M8 23V9h13M8 16h9" stroke="var(--accent)" strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="24" cy="22" r="3" fill="var(--accent)" />
        </svg>
        <h1>FF Factory</h1>
        <label className="field">
          <span>Username</span>
          <input
            className="input"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {err && <div className="login-err">{err}</div>}
        {pending && (
          <div className="login-pending" role="status">
            <span className="spinner spinner-sm" /> {pending.text}
          </div>
        )}
        <button className="btn btn-primary btn-block" disabled={busy || !!pending || !username.trim() || !password}>
          {busy ? 'Checking…' : pending ? 'Waiting for approval…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
