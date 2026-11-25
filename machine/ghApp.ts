// GitHub App tokens on a machine (w1519, docs/github-apps.md): the daemon keeps the installation tokens the portal sends
// (gh_app_tokens) in one private file, and a run the portal allowed an app (FF_GH_APP_NAMES) gets:
//
// - git: a credential helper for https://github.com that sees the repository's path (credential.useHttpPath) and answers
//   with the app's token for a repository an allowed installation covers, else with the run's own GH_TOKEN as before;
// - gh: a `gh` first on its PATH that finds the repository (-R, a URL, `gh api repos/…`, the folder's remotes) and runs the
//   real gh with GH_TOKEN set to the app's token for such a repository, else unchanged.
//
// w5547 (lothsahn: "workers can't read GitHub App tokens; helper checks the session"): the machine's file (tokens.json)
// holds every app's tokens and no worker reads it (the fences close the daemon's folder to reads, w5546). The daemon writes
// each run its own file, `gh-app/sessions/<session>.json`, with only the apps the portal named in that run's spec
// (FF_GH_APP_NAMES as the spec carried it, never as the worker's shell has it), and points the run at it
// (FF_GH_APP_SESSION_FILE). On macOS and Linux the fence lets a run read only its own; on Windows every Low worker can read
// the sessions folder (one Low token for all workers), which still holds only the apps runs on that machine were given.
//
// The same file runs as that helper and that shim (`node ghApp.ts credential get`, `node ghApp.ts gh …`). Nothing here
// prints a token except the helper's answer to git on its stdout, which is git's protocol.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appNamesOf, appTokenFor, ghRepoOf, gitRemoteRepo, repoKey, type GhAppToken } from '../shared/githubAppRoute.ts';

export const GH_APP_DIR = 'gh-app';
export const GH_APP_FILE = 'tokens.json';

/** Where a daemon keeps the tokens and the shims: `<app dir>/gh-app/tokens.json` and `<app dir>/gh-app/bin`. */
export const ghAppPaths = (appDir: string) => ({
  dir: path.join(appDir, GH_APP_DIR),
  file: path.join(appDir, GH_APP_DIR, GH_APP_FILE),
  bin: path.join(appDir, GH_APP_DIR, 'bin'),
  sessions: path.join(appDir, GH_APP_DIR, 'sessions'),
});

/**
 * A run's own folder (w5547), or undefined for an id that is not a plain name. The tokens file is inside it, not beside the
 * other runs' (lockout review of #1193): the fences give the run this folder, so a rewrite of the file (a temporary file,
 * then a rename) stays readable to it. A grant on the file itself is lost at the first rewrite under Landlock (granted by
 * inode) and on Windows (the new file takes its folder's label).
 */
export const sessionTokensDir = (sessions: string, sessionId: string) => (/^[A-Za-z0-9._-]{1,128}$/.test(sessionId) && !/^\.+$/.test(sessionId) ? path.join(sessions, sessionId) : undefined);

/** A run's own tokens file (w5547), `<sessions>/<id>/tokens.json`, or undefined for an id that is not a plain name. */
export const sessionTokensFile = (sessions: string, sessionId: string) => {
  const d = sessionTokensDir(sessions, sessionId);
  return d ? path.join(d, 'tokens.json') : undefined;
};

/**
 * A run's own file (w5547): the apps its spec names and only their tokens. Written whole, 0600, like the machine's file.
 * The app names in it are the daemon's record of the run's grant; a worker cannot write the daemon's folder.
 */
export function writeSessionTokens(file: string, apps: readonly string[], tokens: readonly GhAppToken[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ apps, tokens: tokens.filter((t) => apps.includes(t.app)) }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The apps a run's own file was written for (empty when none or unreadable). */
export function sessionApps(file: string): string[] {
  try {
    const a = (JSON.parse(fs.readFileSync(file, 'utf8')) as { apps?: unknown }).apps;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * New tokens from the portal (gh_app_tokens): every run's own file is written again with its own apps' tokens. A file whose
 * session the daemon no longer runs (`live` says) and that is a day old is removed. Says what it could not write.
 */
export function refreshSessionTokens(sessions: string, tokens: readonly GhAppToken[], live: (sessionId: string) => boolean, say: (line: string) => void = () => {}, now = Date.now()) {
  let names: string[];
  try {
    names = fs.readdirSync(sessions, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const n of names) {
    const dir = path.join(sessions, n);
    const file = path.join(dir, 'tokens.json');
    try {
      if (!live(n)) {
        if (now - fs.statSync(dir).mtimeMs > 24 * 3_600_000) fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (!fs.existsSync(file)) continue;
      writeSessionTokens(file, sessionApps(file), tokens);
    } catch (e) {
      say(`github apps: could not write ${n}: ${(e as Error).message}`);
    }
  }
}

/** The tokens, written whole (a temporary file, then a rename), readable by this user only (0600; a Windows profile folder). */
export function writeGhAppTokens(file: string, tokens: readonly GhAppToken[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ tokens }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The tokens in the file, or none (no file yet, or unreadable). */
export function readGhAppTokens(file: string | undefined): GhAppToken[] {
  if (!file) return [];
  try {
    const t = (JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens?: unknown }).tokens;
    return Array.isArray(t) ? (t as GhAppToken[]).filter((x) => x && typeof x.token === 'string' && typeof x.app === 'string' && Array.isArray(x.repos) && Array.isArray(x.owners)) : [];
  } catch {
    return [];
  }
}

/**
 * git's credential helper protocol (sourced: git-credential(1), "INPUT/OUTPUT FORMAT"): key=value lines in, and for `get`
 * a username and password out. For https://github.com with a path an app's installation covers: x-access-token and that
 * token; else the run's GH_TOKEN (the helper it replaces, server/launch.ts GITHUB_HELPER); else nothing, and git goes on.
 */
export function credentialAnswer(op: string | undefined, input: string, env: Record<string, string | undefined>, tokens: readonly GhAppToken[], now: number): string {
  if (op !== 'get') return '';
  const kv = new Map(
    input
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
  );
  if (kv.get('protocol') !== 'https' || kv.get('host')?.toLowerCase() !== 'github.com') return '';
  const app = appTokenFor(tokens, repoKey(kv.get('path')), appNamesOf(env.FF_GH_APP_NAMES), now);
  const password = app?.token ?? env.GH_TOKEN;
  return password ? `username=x-access-token\npassword=${password}\n` : '';
}

/**
 * The environment the real gh runs with: GH_TOKEN set to an app's token when the command's repository (ghRepoOf, else the
 * folder's remotes from `remotes()`) is covered by an installation of an app this run may use; else `env` unchanged.
 */
export function ghEnvFor(args: readonly string[], env: Record<string, string | undefined>, tokens: readonly GhAppToken[], remotes: () => string, now: number): Record<string, string | undefined> {
  const apps = appNamesOf(env.FF_GH_APP_NAMES);
  if (!apps.length || !tokens.some((t) => apps.includes(t.app))) return env;
  const repo = ghRepoOf(args, env) ?? gitRemoteRepo(remotes());
  const app = appTokenFor(tokens, repo, apps, now);
  if (!app) return env;
  const out: Record<string, string | undefined> = { ...env, GH_TOKEN: app.token };
  delete out.GITHUB_TOKEN;
  return out;
}

/** The real gh: the first on PATH that is not in `skipDir` (the shim's own folder): gh.exe on Windows, gh elsewhere. */
export function findRealGh(pathValue: string | undefined, skipDir: string | undefined, platform = process.platform): string | undefined {
  const norm = (p: string) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const skip = skipDir ? norm(skipDir) : undefined;
  for (const dir of (pathValue ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir || norm(dir) === skip) continue;
    const exe = path.join(dir, platform === 'win32' ? 'gh.exe' : 'gh');
    try {
      if (!fs.statSync(exe).isFile()) continue;
      if (platform !== 'win32') fs.accessSync(exe, fs.constants.X_OK);
      return exe;
    } catch {
      // not here
    }
  }
  return undefined;
}

const fwd = (p: string) => p.replace(/\\/g, '/');
const q = (s: string) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;

/**
 * Write the `gh` shims into `bin` (sh for Git Bash, macOS and Linux; .cmd for PowerShell and cmd) and answer the git
 * credential helper command (git runs a "!" helper through its shell, Git for Windows' sh included). Exported for tests.
 */
export function installGhAppShims(bin: string, node = process.execPath, nodeArgs = process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), script = import.meta.filename): string {
  const line = [fwd(node), ...nodeArgs, fwd(script)].map(q).join(' ');
  fs.mkdirSync(bin, { recursive: true });
  const sh = path.join(bin, 'gh');
  fs.writeFileSync(`${sh}.tmp`, `#!/bin/sh\n# FF Factory: gh with a GitHub App's token for the repositories it is installed on (machine/ghApp.ts, w1519).\nFF_GH_APP_BIN=${q(fwd(bin))}\nexport FF_GH_APP_BIN\nexec ${line} gh "$@"\n`);
  fs.chmodSync(`${sh}.tmp`, 0o755);
  fs.renameSync(`${sh}.tmp`, sh);
  fs.writeFileSync(`${sh}.cmd`, `@echo off\r\nrem FF Factory: gh with a GitHub App's token (machine/ghApp.ts, w1519).\r\nset "FF_GH_APP_BIN=${bin}"\r\n${[node, ...nodeArgs, script].map((s) => `"${s}"`).join(' ')} gh %*\r\n`);
  return `!${line} credential`;
}

/** What the daemon set up: the shims' folder, the tokens' file and the helper command. */
export interface GhAppSetup {
  bin: string;
  file: string;
  helper: string;
}

/**
 * What a run adds to its environment for the apps (w1519): only a run the portal named apps for (FF_GH_APP_NAMES) beside its
 * vault GitHub token. The tokens' file, the helper (server/launch.ts githubCredentialEnv puts it in git's config), and the
 * shims' folder first on PATH (`pathKey`: "Path" on Windows).
 */
export function ghAppRunEnv(specEnv: Record<string, string | undefined> | undefined, setup: GhAppSetup | undefined, pathKey: string, currentPath: string | undefined, sessionFile?: string): Record<string, string> {
  if (!setup || !specEnv?.FF_GH_APP_NAMES || !specEnv.GH_TOKEN || !sessionFile) return {};
  // Never the machine's file (w5547): the run reads only its own.
  return { FF_GH_APP_SESSION_FILE: sessionFile, FF_GH_APP_HELPER: setup.helper, [pathKey]: [setup.bin, currentPath].filter(Boolean).join(path.delimiter) };
}

/**
 * Set a run up for its apps (w5547): its own tokens file, written now from the machine's file with the apps the portal named
 * in its spec, and the environment that points its git and gh at it. Undefined (and no file) for a run with no apps.
 */
export function ghAppSessionSetup(o: { setup: GhAppSetup | undefined; sessions: string; sessionId: string; specEnv: Record<string, string | undefined> | undefined }): string | undefined {
  if (!o.setup || !o.specEnv?.FF_GH_APP_NAMES || !o.specEnv.GH_TOKEN) return undefined;
  const file = sessionTokensFile(o.sessions, o.sessionId);
  if (!file) return undefined;
  writeSessionTokens(file, appNamesOf(o.specEnv.FF_GH_APP_NAMES), readGhAppTokens(o.setup.file));
  return file;
}

/** `git config --get-regexp` of the remotes' URLs in `cwd`, or nothing. */
export const remotesOf = (cwd: string) => () => {
  const r = spawnSync('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return r.status === 0 ? r.stdout : '';
};

function main(argv: string[]): number {
  // The run's own file (w5547): only the apps its spec named. FF_GH_APP_NAMES still narrows, never widens.
  const tokens = readGhAppTokens(process.env.FF_GH_APP_SESSION_FILE);
  if (argv[0] === 'credential') {
    process.stdout.write(credentialAnswer(argv[1], fs.readFileSync(0, 'utf8'), process.env, tokens, Date.now()));
    return 0;
  }
  if (argv[0] === 'gh') {
    const args = argv.slice(1);
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const gh = findRealGh(process.env[key], process.env.FF_GH_APP_BIN);
    if (!gh) {
      process.stderr.write('gh: not found on PATH (the FF Factory gh shim found no gh after its own folder)\n');
      return 127;
    }
    const r = spawnSync(gh, args, { stdio: 'inherit', env: ghEnvFor(args, process.env, tokens, remotesOf(process.cwd()), Date.now()) as NodeJS.ProcessEnv, windowsHide: false });
    return r.status ?? 1;
  }
  process.stderr.write('usage: ghApp.ts credential get | ghApp.ts gh [args]\n');
  return 2;
}

/** The shims' folder beside a tokens' file (both under <app dir>/gh-app). */

// Run when started directly (the gh shim, or git's credential helper).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`ghApp: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
