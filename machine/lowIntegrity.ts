/**
 * The Windows worker fence (w5377, the design in docs/worker-root.md 4.1): sandbox agents run at Low integrity, so
 * Windows' no-write-up rule refuses their writes to anything not labelled Low. The daemon labels the worker root's
 * folders Low (each with (OI)(CI), so what is made in them later is Low too) and starts each sandbox agent's claude from
 * a Low-labelled copy of the claude executable; a process started from a Low-labelled file runs at Low, and everything
 * it starts (Bash, git, gh, batch Unity, players) inherits Low (both measured on LothDesktop, w5333 and w5377).
 *
 * Off by default: daemon.json `workerIntegrity: "low"` turns it on, on Windows only. The root itself stays Medium: a Low
 * label on it would give Low processes delete-child over `secrets`. `daemon`, `secrets` and the daemon's own folder stay
 * Medium (a worker cannot rewrite the daemon's code or its tokens), and `repo`, the bare git store every sandbox is a
 * worktree of, is labelled whole (sandbox worktrees commit there); a `repo` with a working tree gets only its `.git`.
 *
 * Not a boundary against a malicious worker: the sandbox editor the daemon starts is Medium and compiles what workers
 * write. It stops accidental writes outside the root, which is lothsahn's rule ("under no circumstances should workers
 * write outside of ffw").
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOW_LABEL = '(OI)(CI)low';
/** An explicit Medium label, which overrides the Low one a folder inherits (measured, w5377). */
export const MEDIUM_LABEL = '(OI)(CI)medium';
/** Root children that stay Medium (writeLock.ts LOCKED_CHILDREN, plus the root's own record). */
export const MEDIUM_CHILDREN = ['daemon', 'secrets'];
/**
 * Root children that hold CI runners, which are not worker agents (w5440): they stay Medium, explicitly where an earlier
 * rollout labelled them Low. A runner's Runner.Worker.exe is started per job from its bin folder, and a process started
 * from a Low-labelled exe runs at Low, so a Low runner folder ran every job at Low, where Git Bash's msys dies at start
 * (NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022; BEAST's ffu runners, 2026-11-24 from 12:34Z).
 * Medium also keeps Low workers off the runners' .credentials.
 */
export const CI_CHILDREN = ['ffu-runners'];

export interface LowTargetsInput {
  root: string;
  /** The daemon's folder: kept Medium where it sits inside the root. */
  appDir: string;
  /** The root's children (names), as listed now. */
  children: { name: string; dir: boolean }[];
  /** Folders of the install outside the root, and the sandboxes' and temp folders where they are elsewhere. */
  extra?: (string | undefined)[];
  /** Single files outside the Low folders a worker must write (the Max events file). */
  files?: (string | undefined)[];
  /** Extras the daemon owns that a worker must write although they sit in the daemon's folder (the Unity slots mailbox). */
  allowInAppDir?: (string | undefined)[];
  exists?: (p: string) => boolean;
}

const inside = (child: string, parent: string) => {
  const r = path.relative(parent, child);
  return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
};
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** The folders and files to label Low. Exported for tests. */
export function lowTargets(i: LowTargetsInput): { dirs: string[]; files: string[]; medium: string[] } {
  const exists = i.exists ?? fs.existsSync;
  const keep = new Set([...MEDIUM_CHILDREN, ...CI_CHILDREN].map((c) => c.toLowerCase()));
  if (inside(i.appDir, i.root) && !same(i.appDir, i.root)) keep.add(path.relative(i.root, i.appDir).split(/[\\/]/)[0].toLowerCase());
  const dirs: string[] = [];
  for (const c of i.children) {
    if (!c.dir || keep.has(c.name.toLowerCase())) continue;
    if (c.name.toLowerCase() === 'repo') {
      // A worker install's repo is one bare store every sandbox is a worktree of (worker.ts cloneRepo): label all of it,
      // as Landlock and Seatbelt already let workers write it. A clone with a working tree: only its .git.
      const repo = path.join(i.root, c.name);
      const git = path.join(repo, '.git');
      if (exists(git)) dirs.push(git);
      else if (exists(path.join(repo, 'HEAD'))) dirs.push(repo);
      continue;
    }
    dirs.push(path.join(i.root, c.name));
  }
  // lowEnv's APPDATA and LOCALAPPDATA live here; labelLow makes it when it is missing.
  if (!i.children.some((c) => c.name.toLowerCase() === 'home')) dirs.push(path.join(i.root, 'home'));
  for (const e of i.extra ?? []) {
    if (!e || inside(e, i.root) || dirs.some((d) => same(d, e))) continue;
    if (inside(e, i.appDir) && !(i.allowInAppDir ?? []).some((a) => !!a && same(a, e))) continue;
    dirs.push(e);
  }
  const files = (i.files ?? []).filter((f): f is string => !!f && !dirs.some((d) => inside(f, d)));
  // The agents' node (server/agentNode.ts, first on every agent's PATH) keeps Medium inside a Low tools folder: a process
  // started from a Low-labelled exe runs at Low, so a Medium agent's node would be Low and the machine's Git it starts
  // would crash (0xC0000022 on msys' shared object directory; measured w5377). A Low agent's node is Low anyway (a Low
  // parent starts Low children), and a worker cannot rewrite the shared node.
  const medium = dirs.some((d) => same(d, path.join(i.root, 'tools'))) ? [path.join(i.root, 'tools', 'node')] : [];
  const ci = new Set(CI_CHILDREN.map((c) => c.toLowerCase()));
  for (const c of i.children) if (c.dir && ci.has(c.name.toLowerCase())) medium.push(path.join(i.root, c.name));
  return { dirs, files, medium };
}

type Ran = { code: number | null; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[], o?: { timeoutMs?: number }) => Promise<Ran>;

/** Whether icacls says this path carries an explicit or inherited Low mandatory label. Exported for tests. */
export const isLabelledLow = (icaclsOut: string) => /Mandatory Label\\Low Mandatory Level/i.test(icaclsOut);

/**
 * Labels each target Low unless it is already, and says what it did. icacls' label on a folder with (OI)(CI) reaches
 * the files already in it (measured, w5333). Never throws: a target it cannot label is reported, and the caller runs its
 * agents unfenced when any failed.
 *
 * Setting a mandatory label needs WRITE_OWNER on the path. An owner has only READ_CONTROL and WRITE_DAC by right, so where
 * the account's write comes from a group ACE (BEAST's F:\ffw inherits Authenticated Users:(M) from the drive, and the
 * daemon's token is not elevated, so Administrators:(F) does not count) icacls answers "Access is denied". The owner may
 * still change the DACL, so labelLow then grants the account Full on the path and labels it again (measured on BEAST,
 * w5402: denied, then the grant, then the label succeeds and reaches the files inside).
 */
export async function labelLow(t: { dirs: string[]; files: string[]; medium?: string[] }, exec: Exec, say: (line: string) => void, account = currentAccount()): Promise<boolean> {
  let ok = true;
  const setLabel = async (p: string, label: string) => {
    let r = await exec('icacls', [p, '/setintegritylevel', label], { timeoutMs: 30 * 60_000 });
    if (r.code !== 0 && account && /access is denied/i.test(r.stderr + r.stdout)) {
      const g = await exec('icacls', [p, '/grant', `${account}:${label.startsWith('(OI)') ? '(OI)(CI)' : ''}F`], { timeoutMs: 30 * 60_000 });
      if (g.code === 0) {
        say(`worker integrity: gave ${account} Full on ${p}, which setting its label needs (WRITE_OWNER)`);
        r = await exec('icacls', [p, '/setintegritylevel', label], { timeoutMs: 30 * 60_000 });
      }
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300));
  };
  const one = async (p: string, label: string) => {
    try {
      if (!fs.existsSync(p)) {
        if (label === LOW_LABEL) fs.mkdirSync(p, { recursive: true });
        else fs.writeFileSync(p, '', { flag: 'a' });
      }
      const now = await exec('icacls', [p], { timeoutMs: 60_000 });
      if (now.code === 0 && isLabelledLow(now.stdout)) return;
      await setLabel(p, label);
      say(`worker integrity: labelled ${p} Low`);
    } catch (e) {
      ok = false;
      say(`worker integrity: could not label ${p} Low: ${(e as Error).message}`);
    }
  };
  for (const d of t.dirs) await one(d, LOW_LABEL);
  for (const f of t.files) await one(f, 'low');
  // Folders kept Medium inside a Low one (lowTargets' medium): only those that exist and inherited Low. A failure here
  // leaves the fence whole (only a Medium agent's node is affected), so it is said and not counted.
  for (const p of t.medium ?? []) {
    try {
      if (!fs.existsSync(p)) continue;
      const now = await exec('icacls', [p], { timeoutMs: 60_000 });
      if (now.code !== 0 || !isLabelledLow(now.stdout)) continue;
      await setLabel(p, MEDIUM_LABEL);
      say(`worker integrity: kept ${p} Medium`);
    } catch (e) {
      say(`worker integrity: could not keep ${p} Medium: ${(e as Error).message}`);
    }
  }
  return ok;
}

/**
 * The CI runners whose job process would start at Low (w5440): each `<root>/<CI child>/<runner>/bin/Runner.Worker.exe`
 * that icacls says is labelled Low. The daemon checks this after labelling and says it loudly, since such a runner fails
 * every Windows job before its first step. Exported for tests.
 */
export async function lowRunners(root: string, exec: Exec, o: { list?: (dir: string) => string[]; exists?: (p: string) => boolean } = {}): Promise<string[]> {
  const list = o.list ?? ((d: string) => { try { return fs.readdirSync(d); } catch { return []; } });
  const exists = o.exists ?? fs.existsSync;
  const low: string[] = [];
  for (const c of CI_CHILDREN) {
    for (const r of list(path.join(root, c))) {
      const exe = path.join(root, c, r, 'bin', 'Runner.Worker.exe');
      if (!exists(exe)) continue;
      const now = await exec('icacls', [exe], { timeoutMs: 60_000 });
      if (now.code === 0 && isLabelledLow(now.stdout)) low.push(exe);
    }
  }
  return low;
}

/** The account the daemon runs as, as icacls names it (DOMAIN\\user), or undefined off Windows. */
export const currentAccount = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.USERNAME ? (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME) : undefined;

export const lowToolsDir = (root: string) => path.join(root, 'tools', 'low');

/**
 * A Low-labelled copy of `exe` in `<root>\tools\low`, named by its size and mtime so a new claude gets a new copy; copies
 * of older builds are removed when nothing runs them. Returns the copy's path, or undefined (and says why) when it
 * cannot be made: the caller then runs that agent unfenced.
 */
export async function lowCopy(root: string, exe: string, exec: Exec, say: (line: string) => void): Promise<string | undefined> {
  try {
    const st = fs.statSync(exe);
    const dir = lowToolsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(exe, path.extname(exe));
    const name = `${base}-${st.size}-${Math.floor(st.mtimeMs)}${path.extname(exe)}`;
    const copy = path.join(dir, name);
    if (!fs.existsSync(copy) || fs.statSync(copy).size !== st.size) {
      const part = `${copy}.part`;
      fs.copyFileSync(exe, part);
      fs.renameSync(part, copy);
    }
    const now = await exec('icacls', [copy], { timeoutMs: 60_000 });
    if (!(now.code === 0 && isLabelledLow(now.stdout))) {
      const r = await exec('icacls', [copy, '/setintegritylevel', 'low'], { timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-300));
    }
    for (const old of fs.readdirSync(dir)) {
      if (old !== name && old.startsWith(`${base}-`)) {
        try {
          fs.rmSync(path.join(dir, old), { force: true });
        } catch {
          /* still running: the next start removes it */
        }
      }
    }
    return copy;
  } catch (e) {
    say(`worker integrity: could not make a Low copy of ${exe}: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * What a Low agent's environment changes: the per-user folders programs write without asking (APPDATA, LOCALAPPDATA)
 * move into the root, since a Low process cannot write the person's own. TEMP and TMP are already the session's folder in
 * the root (daemon sessionTempEnv). The Git for Low workers (server/agentGit.ts) goes first on PATH and is Claude Code's
 * Git Bash: the machine's Git, at its own path, crashes at Low (0xC0000022 opening msys' shared object directory, which a
 * Medium msys made first; measured w5333), and a copy at another path gets its own.
 *
 * w5430: gh keeps its login in `%APPDATA%\GitHub CLI` unless GH_CONFIG_DIR names a folder, so the APPDATA move hid the
 * machine's gh login from every Low worker ("You are not logged into any GitHub hosts"; `ff-pr push` and `gh pr create`
 * failed on LothDesktop and BEAST). `ghConfigDir` (ghConfigDirFor, the daemon user's own login) puts it back as
 * GH_CONFIG_DIR: gh reads that folder and the Windows keyring at Low (measured w5427, "Logged in to github.com account
 * Lothsahn (keyring)"), and no token is copied anywhere. server/launch.ts gives git gh as its github.com helper for it.
 */
export function lowEnv(root: string, gitDir: string | undefined, pathKey: string, pathNow: string | undefined, ghConfigDir?: string): Record<string, string> {
  const home = path.join(root, 'home');
  return {
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
    ...(gitDir
      ? {
          CLAUDE_CODE_GIT_BASH_PATH: path.join(gitDir, 'bin', 'bash.exe'),
          [pathKey]: [path.join(gitDir, 'cmd'), path.join(gitDir, 'usr', 'bin'), pathNow].filter(Boolean).join(path.delimiter),
        }
      : {}),
  };
}

/**
 * The daemon user's own gh login folder, for a Low worker's GH_CONFIG_DIR (w5430, lowEnv): the daemon's GH_CONFIG_DIR when
 * set, else `%APPDATA%\GitHub CLI` when gh has logged in there (its hosts.yml). Undefined when gh has no login here.
 */
export function ghConfigDirFor(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (!env.APPDATA) return undefined;
  const dir = path.join(env.APPDATA, 'GitHub CLI');
  return exists(path.join(dir, 'hosts.yml')) ? dir : undefined;
}

export const lowUnityDir = (root: string) => path.join(root, 'tools', 'unity-low');

/**
 * Junctions `<root>\tools\unity-low\<version>` to each installed editor's `Editor` folder, for FF_UNITY_EDITOR_ROOT
 * (the game repo's scripts start a Windows batch Unity from `$FF_UNITY_EDITOR_ROOT/<version>/Unity.exe` when it is set).
 * Unity's Roslyn names its compiler server's pipe from the compiler's folder, so a Low Unity started through a junction
 * gets its own Low server and no Medium editor's compile can reach it (measured, w5347; docs/worker-root.md 4.1). The
 * junctions live in the root; nothing on the install's drive is written. Returns the versions it has.
 */
export async function lowUnityJunctions(root: string, editors: { version: string; bin: string }[], exec: Exec, say: (line: string) => void): Promise<string[]> {
  const dir = lowUnityDir(root);
  const have: string[] = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    say(`worker integrity: could not make ${dir}: ${(e as Error).message}`);
    return have;
  }
  const seen = new Set<string>();
  for (const e of editors) {
    if (seen.has(e.version) || !/^[0-9][0-9A-Za-z.]*$/.test(e.version)) continue;
    seen.add(e.version);
    const target = path.dirname(e.bin); // <install>\<version>\Editor
    const link = path.join(dir, e.version);
    try {
      if (fs.existsSync(path.join(link, 'Unity.exe'))) {
        have.push(e.version);
        continue;
      }
      fs.rmSync(link, { recursive: false, force: true });
      const r = await exec('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { timeoutMs: 60_000 });
      if (r.code !== 0 || !fs.existsSync(path.join(link, 'Unity.exe'))) throw new Error((r.stderr || r.stdout).trim().slice(-300) || 'no Unity.exe through it');
      have.push(e.version);
    } catch (err) {
      say(`worker integrity: could not junction Unity ${e.version} at ${link}: ${(err as Error).message}`);
    }
  }
  return have;
}

/**
 * Low-integrity Roslyn compiler servers that run from an install's own path rather than a junction under the root:
 * every Medium compile on the machine would reach them and fail with CS2012 (w5347). The daemon ends them as soon as it
 * sees one; a worker that started Unity by the install's path is told why in its own failed run. Exported for tests.
 */
export function strayLowServers(servers: { pid: number; rid: number; dll: string }[], root: string): number[] {
  const under = lowUnityDir(root).toLowerCase();
  return servers.filter((s) => s.rid > 0 && s.rid < 0x2000 && s.dll && !path.resolve(s.dll).toLowerCase().startsWith(under)).map((s) => s.pid);
}
