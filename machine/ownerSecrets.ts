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
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { trustedGh } from './evidenceGate.ts';
import { NO_READ_UP, type LabelTarget } from './lowIntegrity.ts';

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
 * itself, as before (w5548 "Keep it only for the runs that have no vault token"). With them, ownerReadMore's paths
 * (w5749's enforce PR). Windows gets none: every path is on the
 * system drive, where the fence writes no label (w5548 "Never touch C: on Windows"; handed up, docs/worker-fence.md).
 */
export function ownerReadDenied(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; hasToken: boolean }): string[] {
  if (o.platform === 'win32') return [];
  const main = ownerSecretPaths(o)
    .filter((s) => o.hasToken || s.kind !== 'gh')
    .map((s) => realOr(s.path));
  return [...new Set([...main, ...ownerReadMore(o)])];
}

/**
 * w5749 (from w5733's review of #1232): owner secrets beyond ownerSecretPaths, closed with them on macOS and Linux
 * (ownerReadDenied). They had a warn stage first (#1248, lothsahn's lockout rule: warn-only first, enforce in a separate
 * PR); now they are in the owner rules, so `warn` lists them in sayOwnerRules' line before any machine runs `on`. Each can
 * stop a tool a worker runs under `on` (uv and curl read ~/.netrc; git's `store` helper reads ~/.git-credentials), which
 * the per-machine warn verdicts before `on` are for.
 * - git and curl's stored passwords: `~/.netrc`, `~/.git-credentials` and git's XDG `git/credentials` (git-credential-store(1)).
 * - gh's other config folders: gh reads only one (ghConfigFolder), but a login left in another (`~/.config/gh` when the
 *   daemon has GH_CONFIG_DIR or XDG_CONFIG_HOME set elsewhere) is one `GH_CONFIG_DIR=` away for a worker.
 * - Linux: flatpak browsers' homes (`~/.var/app/<id>`), snap Brave, and the browsers under `~/.config` when
 *   XDG_CONFIG_HOME points elsewhere (ownerSecretPaths looks only under XDG_CONFIG_HOME then).
 * Windows: none. Every such path is in the owner's profile on the system drive, which the fence never labels (handed up to
 * lothsahn as a decision, docs/worker-fence.md "Owner secrets").
 */
export function ownerSecretPathsMore(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv }): OwnerSecret[] {
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
    if (env.XDG_CONFIG_HOME && p.normalize(env.XDG_CONFIG_HOME + '/') !== p.normalize(h('.config') + '/'))
      for (const b of ['google-chrome', 'chromium', 'microsoft-edge', 'BraveSoftware']) add({ path: h('.config', b), kind: 'browser' });
  }
  const closed = new Set(ownerSecretPaths(o).map((s) => s.path));
  return out.filter((s) => !closed.has(s.path));
}

/**
 * ownerSecretPathsMore's paths for a run, as ownerReadDenied closes them: gh's other folders stay open to a run with no
 * GitHub token at all, as the gh folder does.
 */
export function ownerReadMore(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; hasToken: boolean }): string[] {
  // Windows first: nothing below may even resolve a path on the system drive (w5757's review).
  if (o.platform === 'win32') return [];
  // A folder linked to the gh folder a run uses is that folder: never closed through its other name.
  const active = realOr(ghConfigFolder(o.env, o.platform, o.home));
  return ownerSecretPathsMore(o)
    .filter((s) => o.hasToken || s.kind !== 'gh')
    .map((s) => realOr(s.path))
    .filter((p) => p !== active);
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

/** What one run gets from the owner-secret work (w5548, w5553, w5560), as daemon.ts wires it (w5747's wiring test). */
export interface OwnerRunWiring {
  /** The machine login's token as GH_TOKEN: only a fenced run with no vault token, and only when the daemon read one. */
  ghMachine: Record<string, string>;
  /** The owner paths closed to the run's reads: only while the read fence is enforced. */
  owner: string[];
  /** The Keychain mach denies (and with them, in Seatbelt, the preference-write deny): only with owner paths. */
  ownerSecrets?: { mach: string[] };
  /** Windows fallback: the login's own folder as GH_CONFIG_DIR (lowEnv), only for a fenced run with no token at all. */
  ghLoginFolder: boolean;
  /** GH_CONFIG_DIR=<root>/gh-worker: a fenced macOS or Linux run that holds a token (its own or the machine's). */
  ghOwn: Record<string, string>;
}

/**
 * The owner-secret part of a run's launch (daemon.ts launchSpecFor), in one place so it is tested: the read denies follow
 * the read fence's switch (`enforced`), while the gh routing (ghMachine, ghLoginFolder, ghOwn) follows only whether the
 * run holds a token. `machineGh` is called only for a fenced run with no vault token.
 */
export function ownerRunWiring(o: {
  sandbox: boolean;
  enforced: boolean;
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  specEnv: Record<string, string | undefined> | undefined;
  root?: string;
  machineGh: () => Record<string, string>;
  ghConfigDir?: (root: string) => string;
}): OwnerRunWiring {
  const own = hasOwnGithub(o.specEnv);
  const ghMachine = o.sandbox && !own ? o.machineGh() : {};
  const hasToken = own || Boolean(ghMachine.GH_TOKEN);
  const owner = o.sandbox && o.enforced ? ownerReadDenied({ platform: o.platform, home: o.home, env: o.env, hasToken }) : [];
  return {
    ghMachine,
    owner,
    ...(owner.length ? { ownerSecrets: { mach: KEYCHAIN_MACH_SERVICES } } : {}),
    ghLoginFolder: o.sandbox && !hasToken,
    ghOwn: o.sandbox && o.root && o.platform !== 'win32' && hasToken ? { GH_CONFIG_DIR: (o.ghConfigDir ?? workerGhConfigDir)(o.root) } : {},
  };
}

/** The Keychain item the probe's `security` leg tries to write (and deletes, outside the fence, if the write got through). */
export const PROBE_KEYCHAIN_ITEM = 'ff-read-fence-probe';

/** One tool the read fence's probe runs under the owner rules: `ok` must exit 0; `refused` must fail, and fail at once. */
export interface OwnerToolLeg {
  name: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  expect: 'ok' | 'refused';
  timeoutMs: number;
}

/**
 * The probe's tool legs (w5747, from w5733's review of #1232): what a fenced run does with the owner's secrets closed.
 * - gh with an empty GH_CONFIG_DIR and a token (the w5548 route: gh refused to start when it read the owner's folder);
 * - git ls-remote of a private repository through the credential helper that reads GH_TOKEN (`credentialEnv`);
 * - macOS: `security add-generic-password` refused at once, with no SecurityAgent dialog (w5560 probe 4: without both mach
 *   denies it hung on a dialog on the person's screen).
 * gh and git need a token (the machine login's, read by the daemon); without one they are `skipped`, which blocks enforcing.
 */
export function ownerToolLegs(o: { platform: NodeJS.Platform; gh: string; git?: string; token?: string; ghConfigDir: string; credentialEnv: Record<string, string>; repo?: string; keychainHeld?: string }): { legs: OwnerToolLeg[]; skipped: string[] } {
  const legs: OwnerToolLeg[] = [];
  const skipped: string[] = [];
  const quiet = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (o.token) {
    legs.push({ name: 'gh', cmd: o.gh, args: ['api', 'user', '--silent'], env: { ...quiet, GH_TOKEN: o.token, GH_CONFIG_DIR: o.ghConfigDir }, expect: 'ok', timeoutMs: 60_000 });
    legs.push({
      name: 'git ls-remote',
      cmd: o.git ?? 'git',
      args: ['-c', 'credential.interactive=never', 'ls-remote', o.repo ?? 'https://github.com/Final-Factory/FinalFactory.git', 'HEAD'],
      env: { ...quiet, ...o.credentialEnv, GH_TOKEN: o.token, GH_CONFIG_DIR: o.ghConfigDir },
      expect: 'ok',
      timeoutMs: 60_000,
    });
  } else skipped.push('gh and git ls-remote (the daemon read no machine gh token to test with)');
  if (o.platform === 'darwin' && o.keychainHeld) {
    skipped.push(`security (held: an earlier probe on this code found the Keychain write ${o.keychainHeld}; it runs again once the daemon's code changes)`);
  } else if (o.platform === 'darwin') {
    legs.push({ name: 'security', cmd: '/usr/bin/security', args: ['add-generic-password', '-a', PROBE_KEYCHAIN_ITEM, '-s', PROBE_KEYCHAIN_ITEM, '-w', 'probe'], env: {}, expect: 'refused', timeoutMs: 20_000 });
  }
  return { legs, skipped };
}

export interface ToolLegVerdict {
  name: string;
  ok: boolean;
  said: string;
}

/** Judges one tool leg's exit; never quotes a line that could carry a token. Exported for tests. */
export function judgeToolLeg(leg: Pick<OwnerToolLeg, 'name' | 'expect'>, r: { code: number; stderr?: string; timedOut?: boolean }): ToolLegVerdict {
  const tail = (r.stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/token|gh[opsur]_|github_pat_|password/i.test(l))
    .slice(-1)[0]
    ?.slice(0, 200);
  const why = `exit ${r.code}${tail ? `: ${tail}` : ''}`;
  if (leg.expect === 'ok') return { name: leg.name, ok: r.code === 0 && !r.timedOut, said: r.code === 0 && !r.timedOut ? 'ok' : r.timedOut ? 'hung' : why };
  if (r.timedOut) return { name: leg.name, ok: false, said: 'hung, not refused (a dialog may be on the screen)' };
  if (r.code === 0) return { name: leg.name, ok: false, said: 'the write got through: not refused' };
  return { name: leg.name, ok: true, said: `refused at once (exit ${r.code})` };
}

/**
 * One log line for what the owner-secret rules close (w5747): in warn mode what on mode would close, so warn shows them
 * before any machine enforces them.
 */
export function sayOwnerRules(mode: string, platform: NodeJS.Platform, owner: readonly string[]): string {
  if (platform === 'win32') return `read fence (${mode}): owner-secret rules: none on Windows (every owner path is on the system drive, where the fence sets no label)`;
  const verb = mode === 'on' ? 'close' : 'would close (warn only: runs start without them)';
  const mac = platform === 'darwin' ? `, deny mach-lookup of ${KEYCHAIN_MACH_SERVICES.join(' and ')}, and deny preference writes` : '';
  return `read fence (${mode}): owner-secret rules ${verb}: reads of ${owner.length ? owner.join(', ') : 'no owner path'}${mac}`;
}

/**
 * w5749 (lothsahn, 2026-11-25: "Yes: label those folders on C: and move gh's login out of Credential Manager"): the Windows
 * machines where the read fence may label the owner's own secret folders on the system drive. LothDesktop only: the go was
 * for LothDesktop, and "Do only that on C:". Every other Windows machine keeps its system drive untouched (lowIntegrity.ts
 * labelNoReadUp) and its owner secrets open to Low workers, as before. Measured on LothDesktop (2026-11-25, a Low worker):
 * `GH_CONFIG_DIR="%APPDATA%\GitHub CLI" gh auth status` said "Logged in to github.com account Lothsahn (keyring)", and
 * ~/.ssh listed its keys.
 */
export const OWNER_LABEL_ON_SYSTEM_DRIVE: ReadonlySet<string> = new Set(['lothdesktop']);

/** One owner path the Windows read fence labels, or leaves open and says why. */
export interface OwnerLabelPlan {
  /** Labelled No-Read-Up in on mode (a folder: inherited by everything in it, files made later included). */
  label: LabelTarget[];
  /** Left open, each with its reason, said in the warn and on lines. */
  left: { path: string; why: string }[];
}

/**
 * The Windows owner-secret labels for this machine (w5749). On a machine in OWNER_LABEL_ON_SYSTEM_DRIVE: the gh login's
 * folder and ~/.ssh, when they exist. Browser profiles stay open: Chrome and Edge grant their network service's
 * AppContainer (which runs at Low) Modify on each profile's Network folder (measured on LothDesktop, 2026-11-25: icacls
 * shows an S-1-15-3-1024-... capability with (M) on `User Data\Default\Network`), so a No-Read-Up label on the profile
 * would refuse the owner's own browser its cookies; handed back to lothsahn as its own decision. Nothing outside the go
 * (~/.netrc, ~/.git-credentials, the Claude login) is labelled here. Other platforms and machines: nothing; `exists` is
 * then never called, so nothing on their system drive is even looked at.
 */
export function ownerLabelTargets(o: { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; machineId?: string; exists?: (p: string) => boolean }): OwnerLabelPlan {
  if (o.platform !== 'win32' || !o.machineId || !OWNER_LABEL_ON_SYSTEM_DRIVE.has(o.machineId.toLowerCase())) return { label: [], left: [] };
  const exists = o.exists ?? fs.existsSync;
  const out: OwnerLabelPlan = { label: [], left: [] };
  for (const s of ownerSecretPaths(o)) {
    if (!exists(s.path)) continue;
    if (s.kind === 'browser') out.left.push({ path: s.path, why: "its browser's own AppContainer (Low) reads the profile's Network folder; a No-Read-Up label would refuse it the owner's cookies" });
    else out.label.push({ path: s.path, sddl: NO_READ_UP.dir });
  }
  return out;
}

/**
 * Where gh keeps this machine's login, from `gh auth status` (run by the daemon, outside the fence; the token is never in
 * what it prints): 'keyring' (Windows Credential Manager, which a Low process reads as the owner does: the folder's label
 * does not reach it), 'file' (the folder's hosts.yml, which the label closes), or undefined (no login, or not said).
 */
const GH_LOGIN_LINE = /(?:Logged|Failed to log|Timeout trying to log) in to github\.com/i;
/** A status line gh printed after it checked the token with GitHub ("✓ Logged in"), not one it could only read from storage. */
const GH_CHECKED = /Logged in to github\.com/i;
const GH_UNCHECKED = /(?:Failed to log|Timeout trying to log) in to github\.com/i;

export function ghLoginStorage(statusOut: string): 'keyring' | 'file' | undefined {
  // gh prints "X Failed to log in to github.com account <user> (<where>)" when it cannot check the token (an invalid token,
  // measured with gh 2.102.0 by w5849; a network outage is likely the same), and "X Timeout trying to log in to github.com
  // account <user> (<where>)" when the check times out (measured with gh 2.46.0 by w5859): the login is still stored there,
  // so read both too.
  const line = statusOut.split(/\r?\n/).find((l) => GH_LOGIN_LINE.test(l));
  if (!line) return undefined;
  return /\(keyring\)/i.test(line) ? 'keyring' : 'file';
}

/** The daemon's environment for its own `gh auth status` (ghLoginStorage): no token, so gh reports its stored login. */
export function machineGhStatusEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  delete out.GH_TOKEN;
  delete out.GITHUB_TOKEN;
  return out;
}

/** The warn and on line for the Windows owner-secret labels (w5749): what on labels, the gh login's move, and what stays open. */
export function sayOwnerLabels(mode: string, plan: OwnerLabelPlan, gh: 'keyring' | 'file' | undefined): string {
  if (!plan.label.length && !plan.left.length) return `read fence (${mode}): owner-secret rules: none on this Windows machine (the fence labels the owner's folders on the system drive only on ${[...OWNER_LABEL_ON_SYSTEM_DRIVE].join(', ')})`;
  const verb = mode === 'on' ? 'label' : 'would label (warn only: no label set)';
  const move = gh === 'keyring' ? "; the gh login is in Credential Manager (keyring), which the label does not close: on moves it into the gh folder's hosts.yml" : gh === 'file' ? '; the gh login is in its folder (hosts.yml)' : '; no gh login found';
  const left = plan.left.length ? `; left open: ${plan.left.map((l) => `${l.path} (${l.why})`).join(', ')}` : '';
  return `read fence (${mode}): owner-secret rules ${verb} No-Read-Up on ${plan.label.length ? plan.label.map((t) => t.path).join(', ') : 'nothing'}${move}${left}`;
}

/** gh run by the daemon (outside the fence, no token in its environment), with optional stdin. */
export type GhRun = (args: string[], o?: { input?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The real GhRun: the trusted gh (evidenceGate.ts trustedGh), machineGhStatusEnv, 60 s. */
export const realGhRun: GhRun = (args, o = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const end = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(trustedGh(), args, { env: machineGhStatusEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      end(null);
    }, 60_000);
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      stderr += e.message;
      end(null);
    });
    child.on('close', (c) => end(c));
    child.stdin?.end(o.input ?? '');
  });

/** The github.com accounts `gh auth status` says are logged in. */
export const ghLoginAccounts = (statusOut: string): string[] => [...statusOut.matchAll(/(?:Logged|Failed to log|Timeout trying to log) in to github\.com account (\S+)/gi)].map((m) => m[1]);

/** The Credential Manager targets go-keyring keeps a gh github.com login under (service `gh:github.com`, `<service>:<user>`). */
export const ghKeyringTargets = (user: string): string[] => ['gh:github.com:', `gh:github.com:${user}`];
/** w5749: the daemon's note (in its app folder) that it moved the gh login out of Credential Manager, so off or warn moves it back. */
export const OWNER_GH_MOVED_NOTE = 'read-fence-gh-moved.json';

/** What a move of the gh login did: `line` is said; `deleteFrom` are the Credential Manager targets the caller deletes next. */
export interface GhMove {
  ok: boolean;
  /** Whether this call changed where the login is kept (the caller notes it, so the way back moves only what it moved). */
  moved: boolean;
  line: string;
  deleteFrom?: string[];
}

const ghStatusOf = async (gh: GhRun) => {
  const r = await gh(['auth', 'status', '--hostname', 'github.com']);
  const out = `${r.stdout}\n${r.stderr}`;
  // `none`: gh said plainly there is no login. A status with no login line and no such words (gh failed, timed out, or
  // printed something new) is unread, never "no login" (w5849's review of #1281: that misreading lost the way back).
  // `checked`: gh verified the token with GitHub; a "Failed to log in" or "Timeout" line is a stored login it could not check.
  return { storage: ghLoginStorage(out), accounts: ghLoginAccounts(out), none: /not logged in/i.test(out), checked: GH_CHECKED.test(out) && !GH_UNCHECKED.test(out) };
};
const ghTokenOf = async (gh: GhRun) => {
  const r = await gh(['auth', 'token', '--hostname', 'github.com']);
  const t = r.code === 0 ? r.stdout.trim() : '';
  return /^[A-Za-z0-9_]{20,255}$/.test(t) ? t : undefined;
};

/**
 * w5749 (lothsahn: "move gh's login out of Credential Manager"): moves the machine's gh login for github.com from
 * Credential Manager, which a Low worker reads as the owner does (measured on LothDesktop: `gh auth status` at Low with the
 * owner's GH_CONFIG_DIR said "(keyring)"), into the gh folder's hosts.yml, which the folder's No-Read-Up label closes.
 * `gh auth login --with-token --insecure-storage` with the login's own token; then checked: gh must say the login is in
 * the file with the same token before the caller deletes the Credential Manager entries (deleteFrom). Any step that fails
 * leaves the login where it was, working. One account only: with several, nothing is moved and it is said.
 */
export async function ghLoginToFile(gh: GhRun, beforeMove?: () => void): Promise<GhMove> {
  const before = await ghStatusOf(gh);
  if (!before.storage)
    return before.none
      ? { ok: true, moved: false, line: 'no gh login for github.com: nothing to move' }
      : { ok: false, moved: false, line: "gh auth status could not be read (no login line); the login, wherever it is, is not moved and the next start tries again" };
  if (before.accounts.length !== 1) return { ok: false, moved: false, line: `gh has ${before.accounts.length} github.com accounts (${before.accounts.join(', ')}); the move handles one, so the login stays in Credential Manager` };
  const user = before.accounts[0];
  // A Credential Manager entry is deleted only on a login gh checked (w5859's review of #1281): a file login gh could not
  // check may be a dead token beside a live one in the keyring, so the entries stay and the next start tries again.
  if (before.storage === 'file')
    return before.checked
      ? { ok: true, moved: false, line: `the gh login (${user}) is already in hosts.yml`, deleteFrom: ghKeyringTargets(user) }
      : { ok: false, moved: false, line: `the gh login (${user}) is in hosts.yml but gh could not check it with GitHub; the Credential Manager entries are kept and the next start tries again` };
  const token = await ghTokenOf(gh);
  if (!token) return { ok: false, moved: false, line: 'gh auth token gave no token; the login stays in Credential Manager' };
  // The caller's note goes down before the move (w5849): a daemon that dies after the login call still knows to move it back.
  beforeMove?.();
  const r = await gh(['auth', 'login', '--hostname', 'github.com', '--with-token', '--insecure-storage'], { input: `${token}\n` });
  const after = await ghStatusOf(gh);
  const again = await ghTokenOf(gh);
  if (r.code !== 0 || after.storage !== 'file' || again !== token)
    return { ok: false, moved: false, line: `gh auth login --insecure-storage did not leave the login in hosts.yml (exit ${r.code}, now ${after.storage ?? 'no login'}${again && again !== token ? ', another token' : ''}); the Credential Manager entry is kept` };
  return { ok: true, moved: true, line: `moved the gh login (${user}) from Credential Manager into hosts.yml`, deleteFrom: ghKeyringTargets(user) };
}

/**
 * The way back (read fence off or warn, or the enforce stage reverted): the gh login from hosts.yml into Credential Manager
 * again with `gh auth login --with-token` (gh's default, secure storage, which also takes the token out of hosts.yml), and
 * checked as above. Called only when the daemon's note says it moved the login itself.
 */
export async function ghLoginToKeyring(gh: GhRun): Promise<GhMove> {
  const before = await ghStatusOf(gh);
  if (before.storage === 'keyring') return { ok: true, moved: false, line: 'the gh login is already in Credential Manager: nothing to move back' };
  if (!before.storage)
    return before.none
      ? { ok: true, moved: false, line: 'the gh login is gone (gh says no github.com login): nothing to move back' }
      : { ok: false, moved: false, line: 'gh auth status could not be read (no login line); the note is kept and the next start tries the move back again' };
  const token = await ghTokenOf(gh);
  if (!token) return { ok: false, moved: false, line: 'gh auth token gave no token; the login stays in hosts.yml' };
  const r = await gh(['auth', 'login', '--hostname', 'github.com', '--with-token'], { input: `${token}\n` });
  const after = await ghStatusOf(gh);
  const again = await ghTokenOf(gh);
  if (r.code !== 0 || after.storage !== 'keyring' || again !== token) return { ok: false, moved: false, line: `gh auth login did not put the login back in Credential Manager (exit ${r.code}, now ${after.storage ?? 'no login'}); it stays in hosts.yml` };
  return { ok: true, moved: true, line: `moved the gh login (${after.accounts[0] ?? '?'}) back into Credential Manager` };
}

/**
 * The owner's UNIX sockets that hand out a secret with no file read (w5748, from w5733's review of #1232): the session
 * bus (the Secret Service, org.freedesktop.secrets, where a desktop Linux gh login is kept "(keyring)", and the browsers'
 * Safe Storage keys), GNOME keyring's own folder, and the ssh and gpg agents, which sign with the owner's keys though
 * ~/.ssh is closed. Landlock refuses connect() to them only from ABI 9 (Linux 7.1, LANDLOCK_ACCESS_FS_RESOLVE_UNIX);
 * measured on biscuit (Linux 7.0, ABI 8, 2026-11-25): every one answered a locked worker. A folder stands for the
 * sockets in it. `SSH_AUTH_SOCK` is the daemon's own (a worker's env may point elsewhere, but the agent is this one).
 */
export function ownerSocketPaths(o: { runtimeDir?: string; env: NodeJS.ProcessEnv }): string[] {
  const out: string[] = [];
  if (o.runtimeDir) {
    const r = (...s: string[]) => path.posix.join(o.runtimeDir!, ...s);
    out.push(r('bus'), r('keyring'), r('gcr'), r('gnupg'), r('openssh_agent'));
  }
  if (o.env.SSH_AUTH_SOCK) out.push(path.posix.resolve(o.env.SSH_AUTH_SOCK));
  return [...new Set(out)];
}

/**
 * What the socket probe connects to (w5748): each path that is a socket, and the sockets directly inside each folder.
 * Existing ones only; the daemon lists folders (it is not fenced) and sends nothing on a socket.
 */
export function ownerSocketProbeTargets(paths: readonly string[], stat: (p: string) => fs.Stats | undefined = statOr): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const s = stat(p);
    if (s?.isSocket()) out.push(p);
    else if (s?.isDirectory()) {
      try {
        for (const e of fs.readdirSync(p).sort()) if (stat(path.join(p, e))?.isSocket()) out.push(path.join(p, e));
      } catch {
        /* an unreadable folder: nothing to probe in it */
      }
    }
  }
  return [...new Set(out)];
}

function statOr(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

/**
 * ff-landlock.py's `--deny-unix` arguments for the owner sockets (w5748), added to a run's lock with the read fence's other
 * owner rules (on its own off switch, `read-fence-off`). Only the runtime folder's: a deny outside it (an `SSH_AUTH_SOCK`
 * in /tmp) would refuse every socket an outside process makes later beside it (ff-landlock.py unix_grants grants only the
 * siblings there at start). Effective from Landlock ABI 9; the probe tells whether they are (probeOwnerSockets).
 */
export function ownerSocketDenyArgs(runtimeDir: string | undefined): string[] {
  return ownerSocketPaths({ runtimeDir, env: {} }).flatMap((p) => ['--deny-unix', p]);
}

/**
 * The Keychain write leg's hold (w5752's review of #1245): a probe that finds the leg hung (a dialog may be on the person's
 * screen, and its "Reset To Defaults" would replace their login keychain) or the write let through records it here, in the
 * daemon's own folder, with the daemon's code version, and later probes skip the leg until that version changes, so the
 * dialog comes back at most once per code version, not at every daemon start. A skipped leg still blocks `on`
 * (probeOwnerTools: any skipped leg blocks).
 */
export const keychainHoldFile = (appDir: string) => path.join(appDir, 'read-fence-keychain-held.json');

/** What the hold says for this code version (`hung, ...` or `let through`), or undefined: no hold, or another version's. */
export function keychainHeld(file: string, version: string, read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): string | undefined {
  try {
    const h = JSON.parse(read(file)) as { version?: unknown; why?: unknown };
    return h.version === version && typeof h.why === 'string' && h.why ? h.why : undefined;
  } catch {
    return undefined;
  }
}

/** Records the hold for this code version. A hold that cannot be written is said in the log by the caller. */
export function holdKeychainLeg(file: string, version: string, why: string, write: (f: string, d: string) => void = (f, d) => fs.writeFileSync(f, d)): void {
  write(file, JSON.stringify({ version, why, at: new Date().toISOString() }) + '\n');
}
