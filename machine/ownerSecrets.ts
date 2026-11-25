/**
 * The machine owner's secrets a fenced worker may not read (w5548, w5553; rogue-worker audit w5451 items 12 and 24):
 * the machine's own gh login (its config folder and, on macOS, the login keychain gh keeps the token in), ~/.ssh, and
 * browser profiles (cookies, saved logins). On a Mac the worker root sits inside the owner's home, so before this a
 * fenced worker read all of them: measured on m5 (2026-11-25), a fenced worker's `env -u GH_TOKEN gh auth status` said
 * "Logged in to github.com account bryding (keyring)".
 *
 * The paths are handed to the fences' own read deny (w5546: WorkerFence.readDenied on macOS, ff-landlock.py --no-read on
 * Linux, labelNoReadUp on Windows): no third mechanism. This file only says WHAT is denied and how a run with no vault
 * GitHub token still gets the machine's gh login (machineGhEnv): the daemon, outside every fence, reads the login's token
 * with `gh auth token` and gives it to that run as GH_TOKEN, as a vault token is given. So the files stay denied to every
 * fenced run, and the login reaches only the runs that have no token of their own (docs/worker-fence.md, "Owner secrets").
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type OwnerSecretKind = 'gh' | 'ssh' | 'browser' | 'keychain';

export interface OwnerSecret {
  path: string;
  kind: OwnerSecretKind;
}

/**
 * gh's config folder for the daemon's user (gh's own order, `gh help environment`): $GH_CONFIG_DIR, else
 * $XDG_CONFIG_HOME/gh, else %AppData%\GitHub CLI on Windows, else ~/.config/gh. machine/ghLogin.ts ghHostsFile reads
 * the same folder's hosts.yml.
 */
export function ghConfigFolder(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const appData = env.APPDATA ?? env.AppData;
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return p.join(env.XDG_CONFIG_HOME, 'gh');
  if (win && appData) return p.join(appData, 'GitHub CLI');
  return p.join(home, '.config', 'gh');
}

/**
 * Every owner secret folder of this OS, whether or not it exists (a fence denies a missing path harmlessly; a browser
 * installed later is covered at the next start). `env` is the daemon's own, before any worker change (APPDATA is the
 * owner's, not the root's moved one).
 */
export function ownerSecretPaths(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv }): OwnerSecret[] {
  const { platform, home, env } = o;
  const gh: OwnerSecret = { path: ghConfigFolder(env, platform, home), kind: 'gh' };
  if (platform === 'win32') {
    const w = path.win32;
    const roaming = env.APPDATA ?? env.AppData ?? w.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? w.join(home, 'AppData', 'Local');
    return [
      gh,
      { path: w.join(home, '.ssh'), kind: 'ssh' },
      { path: w.join(local, 'Google', 'Chrome', 'User Data'), kind: 'browser' },
      { path: w.join(local, 'Microsoft', 'Edge', 'User Data'), kind: 'browser' },
      { path: w.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'), kind: 'browser' },
      { path: w.join(local, 'Chromium', 'User Data'), kind: 'browser' },
      { path: w.join(roaming, 'Mozilla', 'Firefox'), kind: 'browser' },
      { path: w.join(roaming, 'Opera Software'), kind: 'browser' },
    ];
  }
  const p = path.posix;
  const h = (...s: string[]) => p.join(home, ...s);
  if (platform === 'darwin') {
    const support = (s: string) => ({ path: h('Library', 'Application Support', s), kind: 'browser' as const });
    return [
      gh,
      { path: h('.ssh'), kind: 'ssh' },
      support('Google'),
      support('Microsoft Edge'),
      support('Firefox'),
      support('BraveSoftware'),
      support('Chromium'),
      support('Arc'),
      support('Vivaldi'),
      support('com.operasoftware.Opera'),
      { path: h('Library', 'Safari'), kind: 'browser' },
      { path: h('Library', 'Containers', 'com.apple.Safari'), kind: 'browser' },
      { path: h('Library', 'Cookies'), kind: 'browser' },
      // gh keeps its token in the login keychain ("(keyring)"); git's osxkeychain helper keeps github.com there too.
      { path: h('Library', 'Keychains'), kind: 'keychain' },
    ];
  }
  const config = env.XDG_CONFIG_HOME || h('.config');
  return [
    gh,
    { path: h('.ssh'), kind: 'ssh' },
    { path: p.join(config, 'google-chrome'), kind: 'browser' },
    { path: p.join(config, 'chromium'), kind: 'browser' },
    { path: p.join(config, 'microsoft-edge'), kind: 'browser' },
    { path: p.join(config, 'BraveSoftware'), kind: 'browser' },
    { path: h('.mozilla'), kind: 'browser' },
    { path: h('snap', 'firefox'), kind: 'browser' },
    { path: h('snap', 'chromium'), kind: 'browser' },
    // GNOME keyring's files (a Secret Service gh login lives here on a desktop Linux).
    { path: h('.local', 'share', 'keyrings'), kind: 'keychain' },
  ];
}

/**
 * The Keychain's mach services on macOS (w5553: "a Keychain/securityd mach-lookup deny if it tests safe"). Denied only
 * when the daemon's probe shows git over HTTPS and gh still work under it (daemon.ts ownerFenceProbe).
 */
export const KEYCHAIN_MACH_SERVICES = ['com.apple.SecurityServer', 'com.apple.securityd.xpc'];

/** The run's own GitHub credential: a vault token (GH_TOKEN, w868), which also carries any GitHub App (FF_GH_APP_NAMES). */
export const hasOwnGithub = (specEnv: Record<string, string | undefined> | undefined) => Boolean(specEnv?.GH_TOKEN);

/**
 * What a fenced run with no vault GitHub token gets instead of the gh login's files: the login's token as GH_TOKEN, read
 * by the daemon outside the fence (machineGhToken). Runs with their own token get nothing here, so the machine's login
 * reaches only the runs that have no token of their own (w5548 "Keep it only for the runs that have no vault token").
 * Undefined token: the daemon could not read one, and the caller falls back (Windows: GH_CONFIG_DIR as before, w5430).
 */
export function machineGhEnv(specEnv: Record<string, string | undefined> | undefined, token: string | undefined): Record<string, string> {
  if (hasOwnGithub(specEnv) || !token) return {};
  return { GH_TOKEN: token };
}

export type TokenRun = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => { status: number | null; stdout: string };

const realTokenRun: TokenRun = (cmd, args, o) => {
  const r = spawnSync(cmd, args, { env: o.env, timeout: o.timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '' };
};

/**
 * The machine's gh login's token, read by the daemon (never a worker) with `gh auth token`, or undefined. The value is
 * never logged: only whether there was one.
 */
export function machineGhToken(run: TokenRun = realTokenRun): string | undefined {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    const r = run('gh', ['auth', 'token', '--hostname', 'github.com'], { env, timeoutMs: 30_000 });
    const t = r.status === 0 ? r.stdout.trim() : '';
    return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}
