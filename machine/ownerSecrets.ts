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
export function ownerToolLegs(o: { platform: NodeJS.Platform; gh: string; git?: string; token?: string; ghConfigDir: string; credentialEnv: Record<string, string>; repo?: string }): { legs: OwnerToolLeg[]; skipped: string[] } {
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
  if (o.platform === 'darwin') {
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
