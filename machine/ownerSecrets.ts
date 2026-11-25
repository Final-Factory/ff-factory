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
import fs from 'node:fs';
import path from 'node:path';
import { trustedGh } from './evidenceGate.ts';

export type OwnerSecretKind = 'gh' | 'ssh' | 'browser' | 'keychain' | 'credentials';

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
 * The mach services a fenced Mac run may not look up (w5560, measured on m5 2026-11-25, probe 4): with
 * ~/Library/Keychains unreadable there is no default keychain, and a write (`security add-generic-password`) then has
 * SecurityAgent raise a "keychain not found" dialog on the person's screen and waits for a click (its "Reset To Defaults"
 * would replace their login keychain). Denying com.apple.authd makes the write fail at once ("Unable to obtain
 * authorization", exit 152) but still logged one SecurityAgent dialog line; denying both logged none, and git over
 * HTTPS, gh, codesign, python, uv, node, curl, the Claude CLI and a Unity batch run with its licence update all passed.
 * Denying com.apple.SecurityServer alone still hung. So both, always together with the Keychains read deny.
 */
export const KEYCHAIN_MACH_SERVICES = ['com.apple.authd', 'com.apple.SecurityServer'];

/**
 * The owner-secret paths a fenced run may not read, for this run. The gh login's folder is left out only for a run that
 * has no GitHub token at all (no vault token and the daemon read no machine token): that run still reads the login
 * itself, as before (w5548 "Keep it only for the runs that have no vault token"). Windows gets none: every path is on the
 * system drive, where the fence writes no label (w5548 "Never touch C: on Windows"; handed up, docs/worker-fence.md).
 */
export function ownerReadDenied(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; hasToken: boolean }): string[] {
  if (o.platform === 'win32') return [];
  return ownerSecretPaths(o)
    .filter((s) => o.hasToken || s.kind !== 'gh')
    .map((s) => realOr(s.path));
}

/**
 * w5749 (from w5733's review of #1232): owner secrets the fence leaves open on macOS and Linux, in their WARN stage
 * (lothsahn's lockout rule: warn-only first, enforce in a separate PR). They are not in ownerReadDenied yet: the daemon
 * only says, with the read fence's probe, which of them exist on the machine and that `on` would close them once the
 * enforce PR lands. Each can stop a tool a worker runs (uv and curl read ~/.netrc; git's `store` helper reads
 * ~/.git-credentials), which is what the warn stage is for.
 * - git and curl's stored passwords: `~/.netrc`, `~/.git-credentials` and git's XDG `git/credentials` (git-credential-store(1)).
 * - gh's other config folders: gh reads only one (ghConfigFolder), but a login left in another (`~/.config/gh` when the
 *   daemon has GH_CONFIG_DIR or XDG_CONFIG_HOME set elsewhere) is one `GH_CONFIG_DIR=` away for a worker.
 * - Linux: flatpak browsers' homes (`~/.var/app/<id>`), snap Brave, and the browsers under `~/.config` when
 *   XDG_CONFIG_HOME points elsewhere (ownerSecretPaths looks only under XDG_CONFIG_HOME then).
 * Windows: none. Every such path is in the owner's profile on the system drive, which the fence never labels (handed up to
 * lothsahn as a decision, docs/worker-fence.md "Owner secrets").
 */
export function ownerSecretPathsWarn(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv }): OwnerSecret[] {
  const { platform, home, env } = o;
  if (platform === 'win32') return [];
  const p = path.posix;
  const h = (...s: string[]) => p.join(home, ...s);
  const out: OwnerSecret[] = [];
  const add = (s: OwnerSecret) => {
    if (!out.some((x) => x.path === s.path)) out.push(s);
  };
  const active = ghConfigFolder(env, platform, home);
  for (const g of [env.GH_CONFIG_DIR, env.XDG_CONFIG_HOME ? p.join(env.XDG_CONFIG_HOME, 'gh') : undefined, h('.config', 'gh')])
    if (g && g !== active) add({ path: g, kind: 'gh' });
  add({ path: h('.netrc'), kind: 'credentials' });
  add({ path: h('.git-credentials'), kind: 'credentials' });
  if (env.XDG_CONFIG_HOME) add({ path: p.join(env.XDG_CONFIG_HOME, 'git', 'credentials'), kind: 'credentials' });
  add({ path: h('.config', 'git', 'credentials'), kind: 'credentials' });
  if (platform === 'linux') {
    for (const id of ['org.mozilla.firefox', 'com.google.Chrome', 'org.chromium.Chromium', 'com.brave.Browser', 'com.microsoft.Edge', 'com.vivaldi.Vivaldi', 'com.opera.Opera', 'io.gitlab.librewolf-community'])
      add({ path: h('.var', 'app', id), kind: 'browser' });
    add({ path: h('snap', 'brave'), kind: 'browser' });
    if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== h('.config'))
      for (const b of ['google-chrome', 'chromium', 'microsoft-edge', 'BraveSoftware']) add({ path: h('.config', b), kind: 'browser' });
  }
  const closed = new Set(ownerSecretPaths(o).map((s) => s.path));
  return out.filter((s) => !closed.has(s.path));
}

/**
 * The warn-stage paths of a run, as ownerReadDenied would give them once enforced: gh's other folders stay open to a run
 * with no GitHub token at all, as the gh folder does.
 */
export function ownerReadWarn(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; hasToken: boolean }): string[] {
  // A folder linked to the gh folder a run uses is that folder: never closed through its other name.
  const active = realOr(ghConfigFolder(o.env, o.platform, o.home));
  return ownerSecretPathsWarn(o)
    .filter((s) => o.hasToken || s.kind !== 'gh')
    .map((s) => realOr(s.path))
    .filter((p) => p !== active);
}

/**
 * The daemon's log line for the warn stage (w5749), or undefined when there is nothing to say (Windows, or no such path
 * here). Names only paths that exist, never their contents. `exists` is for tests.
 */
export function sayOwnerWarnStage(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; mode: string; exists?: (p: string) => boolean }): string | undefined {
  const exists = o.exists ?? fs.existsSync;
  const all = ownerReadWarn({ ...o, hasToken: true });
  if (!all.length) return undefined;
  const here = all.filter((p) => {
    try {
      return exists(p);
    } catch {
      return false;
    }
  });
  if (!here.length) return undefined;
  return `owner secrets (${o.mode}, w5749): warn stage only, not closed yet: ${here.join(', ')} exist here, and the read fence would close them once their enforce PR lands; a worker tool that needs one fails then`;
}

/** A path resolved through its links when it exists (Seatbelt and Landlock match resolved paths), else as given. */
function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

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
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    const r = run(trustedGh(), ['auth', 'token', '--hostname', 'github.com'], { env, timeoutMs: 30_000 });
    const t = r.status === 0 ? r.stdout.trim() : '';
    return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gh config folder of a fenced run that has a token (its own or the machine's), inside the worker root: empty of any
 * login, so gh starts without reading the owner's ~/.config/gh (denied to the fence). Made once; a failure to make it
 * leaves gh to say so in the run.
 */
export function workerGhConfigDir(root: string): string {
  const dir = path.join(root, 'gh-worker');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* gh reports a missing folder itself */
  }
  return dir;
}
