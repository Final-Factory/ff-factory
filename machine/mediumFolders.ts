/**
 * Medium agents' own temp root and cargo home (w5862, found in w5838's planting audit). Agents that are not in a sandbox
 * run outside the worker fences (Windows: at Medium), but their TMP, TEMP and TMPDIR are `<temp root>/ffa-<session>`
 * (server/cleanup.ts sessionTempEnv), and the temp root is a folder workers write: `<root>/tmp`, or the config's temp
 * folder, which the fences open as an extra (daemon.ts lowTargets' and openChildren's `extra`). Their CARGO_HOME is the
 * workers' one too, `<root>/cache/cargo` (sharedCaches.ts workerCargoHome). So a fenced worker could plant a script or a
 * DLL in a Medium agent's temp folder, or a `config.toml` (a `runner` or `linker`) or an unpacked crate's build script in
 * the cargo home, that the Medium agent then runs outside the fence: cargo itself is the person's (`~/.cargo/bin`, Medium).
 *
 * daemon.json `mediumAgentFolders`:
 * - absent or "warn" (the default): nothing moves; the daemon logs a WARNING at start that names each exposed folder.
 * - "on": Medium agents get `<root>/tmp-medium/ffa-<session>` and `<root>/cache-medium/cargo`, root children only Medium
 *   writes (claudeHome.ts MEDIUM_ONLY_CHILDREN: kept Medium on Windows, read-only under Landlock and Seatbelt). Sandbox
 *   agents keep theirs. A folder that cannot be made, or one a worker could still write, keeps today's folder with a
 *   WARNING, so the switch never stops a Medium agent from starting and needs nobody at the machine.
 * Nothing changes without a worker fence: then no worker is fenced in the first place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MEDIUM_CACHE_CHILD, MEDIUM_TMP_CHILD } from '../server/claudeHome.ts';
import { openChildren } from './lowIntegrity.ts';
import { sharedCacheDir, workerToolCacheEnv } from './sharedCaches.ts';

export type MediumFoldersMode = 'warn' | 'on';

/** `<root>/tmp-medium`: the root of Medium agents' temp folders when the switch is on. */
export const mediumTempRoot = (root: string) => path.join(root, MEDIUM_TMP_CHILD);
/** `<root>/cache-medium/cargo`: Medium agents' cargo home when the switch is on. */
export const mediumCargoHomeDir = (root: string) => path.join(root, MEDIUM_CACHE_CHILD, 'cargo');

const inside = (child: string, parent: string) => {
  const r = path.relative(path.resolve(parent), path.resolve(child));
  return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
};

/**
 * Whether a worker fence lets a worker write `p`: inside a root child workers write (lowIntegrity.ts openChildren, the
 * children labelled Low on Windows and opened by Landlock and Seatbelt), or inside an extra the fences open outside the
 * root (the config's temp and sandboxes folders), or inside a folder `opened` names, in the root or out of it (w5869, w5871's
 * F3: workerIntegrityAllow, writeLockExtra, the transcripts folder while transcriptLock is off). Case-blind, as Windows and
 * macOS file systems are. Exported for tests.
 */
export function workerWritable(p: string, root: string, extra: (string | undefined)[] = [], opened: (string | undefined)[] = []): boolean {
  const low = (s: string) => path.resolve(s).toLowerCase();
  const lp = low(p);
  if (opened.some((o) => !!o && inside(lp, low(o)))) return true;
  if (extra.some((e) => !!e && !inside(low(e), low(root)) && inside(lp, low(e)))) return true;
  if (!inside(lp, low(root)) || lp === low(root)) return false;
  const first = path.relative(low(root), lp).split(/[\\/]/)[0];
  return openChildren(root, extra).some((c) => c.toLowerCase() === first);
}

export interface MediumFoldersInput {
  root?: string;
  /** Whether this OS's worker fence is wanted (fenceGate.ts fenceWanted). */
  fenced: boolean;
  /** daemon.json `mediumAgentFolders`. */
  mode?: string;
  /** The agents' temp root today (daemon.ts agentTempRoot). */
  tempRoot: string;
  /** The daemon's CARGO_HOME, which every agent inherits. */
  cargoHome?: string;
  /** The folders outside the root the fences open to workers (the config's extra roots, temp and sandboxes folders). */
  extra?: (string | undefined)[];
  /** Folders the fences open whole wherever they are (workerWritable's `opened`). */
  opened?: (string | undefined)[];
  mkdir?: (dir: string) => void;
}

export interface MediumFolders {
  /** The temp root Medium agents get; undefined: the agents' temp root as before. */
  tempRoot?: string;
  /** The CARGO_HOME Medium agents get; undefined: the daemon's own, as before. */
  cargoHome?: string;
  /** What to log at start, one line each; a WARNING for each folder a worker can still write. */
  lines: string[];
}

/** Where Medium agents' temp root and cargo home go, decided once at the daemon's start. Exported for tests. */
export function planMediumFolders(i: MediumFoldersInput): MediumFolders {
  const { root } = i;
  if (!root || !i.fenced) return { lines: [] };
  const extra = i.extra ?? [];
  const opened = i.opened ?? [];
  const mkdir = i.mkdir ?? ((d: string) => fs.mkdirSync(d, { recursive: true }));
  const exposed: { what: string; now: string; to: string; key: 'tempRoot' | 'cargoHome' }[] = [];
  if (workerWritable(i.tempRoot, root, extra, opened)) exposed.push({ what: 'TMP/TEMP root', now: i.tempRoot, to: mediumTempRoot(root), key: 'tempRoot' });
  if (i.cargoHome && workerWritable(i.cargoHome, root, extra, opened)) exposed.push({ what: 'CARGO_HOME', now: i.cargoHome, to: mediumCargoHomeDir(root), key: 'cargoHome' });
  if (!exposed.length) return { lines: [] };
  const why = 'a fenced worker could plant a script, DLL or cargo config.toml there that a Medium agent then runs outside the fence';
  if (i.mode !== 'on') {
    const list = exposed.map((e) => `${e.what} ${e.now}`).join(' and ');
    const to = exposed.map((e) => e.to).join(' and ');
    return { lines: [`WARNING medium agent folders: Medium agents' ${list} ${exposed.length > 1 ? 'are' : 'is'} in folders workers write; ${why}. daemon.json "mediumAgentFolders": "on" moves them to ${to} (w5862)`] };
  }
  const out: MediumFolders = { lines: [] };
  for (const e of exposed) {
    if (workerWritable(e.to, root, extra, opened)) {
      out.lines.push(`WARNING medium agent folders: ${e.to} is in a folder workers write; Medium agents keep ${e.what} ${e.now} (${why}; w5862)`);
      continue;
    }
    try {
      mkdir(e.to);
    } catch (err) {
      out.lines.push(`WARNING medium agent folders: could not make ${e.to} (${(err as Error).message}); Medium agents keep ${e.what} ${e.now} (${why}; w5862)`);
      continue;
    }
    out[e.key] = e.to;
    out.lines.push(`medium agent folders: Medium agents' ${e.what} is ${e.to}; sandbox agents keep ${e.now} (w5862)`);
  }
  return out;
}

/**
 * w5870 (w5862's follow-up): the other tool caches and the user's own search path. Every agent gets the workers' tool caches
 * (sharedCaches.ts workerToolCacheEnv: npm's, pip's, NuGet's, .NET's tool home, Playwright's browsers, Unity's package and
 * Asset Store caches, XDG's off Windows), all in `<root>/cache`, which workers write. A Medium agent runs what they hold:
 * a Playwright browser, a .NET global tool, a NuGet package's build targets, a cached pip wheel (pip checks no hash without
 * --require-hashes), an npx package. And .NET's first run adds `$DOTNET_CLI_HOME/.dotnet/tools` to the user's own PATH on
 * Windows, so on BEAST the user PATH (HKCU Environment) ended with `F:\ffw\cache\dotnet\.dotnet\tools` (measured,
 * 2026-11-26): every Medium process of the account searched a folder workers write, the person's own shells included.
 *
 * daemon.json `mediumAgentCaches`:
 * - absent or "warn" (the default): nothing moves; the daemon logs a WARNING at start naming the exposed caches and each
 *   user PATH entry inside a folder workers write, and `ffu-slot take` warns a Medium agent (MEDIUM_AGENT_VAR).
 * - "on": Medium agents get the same caches under `<root>/cache-medium` (a root child only Medium writes, like their uv
 *   cache), the daemon takes such entries off the user PATH (the value's registry type kept), and `ffu-slot take` refuses a
 *   Medium agent: its build would run a slot's build scripts, target binaries and cargo config, which workers write. A
 *   cache folder that cannot be made keeps the workers' one, and a PATH that cannot be read or written stays as it is, each
 *   with a WARNING, so the switch never stops an agent from starting and needs nobody at the machine.
 * Sandbox agents keep the workers' caches. Nothing changes without a worker fence.
 */
export type MediumCachesMode = 'warn' | 'on';
/** The variable a Medium agent gets that says the switch (ffuSlots.ts reads it); sandbox agents never get it. */
export const MEDIUM_AGENT_VAR = 'FF_MEDIUM_AGENT_CACHES';

/** `<root>/cache-medium/<same>` for a path in `<root>/cache`; undefined for one elsewhere. Exported for tests. */
export function mediumCacheFor(root: string, p: string): string | undefined {
  const r = path.relative(path.resolve(sharedCacheDir(root)), path.resolve(p));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return undefined;
  return path.join(root, MEDIUM_CACHE_CHILD, r);
}

export interface MediumCachesInput {
  root?: string;
  fenced: boolean;
  mode?: string;
  extra?: (string | undefined)[];
  /** Folders the fences open whole wherever they are (workerWritable's `opened`; w5946 F3). */
  opened?: (string | undefined)[];
  platform?: NodeJS.Platform;
  mkdir?: (dir: string) => void;
}

export interface MediumCaches {
  /** The tool cache variables Medium agents get; empty: the workers' ones, as before. */
  env: Record<string, string>;
  lines: string[];
}

/** Where Medium agents' tool caches go, decided once at the daemon's start. Exported for tests. */
export function planMediumCaches(i: MediumCachesInput): MediumCaches {
  const { root } = i;
  if (!root || !i.fenced) return { env: {}, lines: [] };
  const extra = i.extra ?? [];
  const opened = i.opened ?? [];
  const mkdir = i.mkdir ?? ((d: string) => fs.mkdirSync(d, { recursive: true }));
  const exposed = Object.entries(workerToolCacheEnv(root, i.platform)).filter(([, v]) => path.isAbsolute(v) && workerWritable(v, root, extra, opened));
  if (!exposed.length) return { env: {}, lines: [] };
  const why = 'a fenced worker could plant a browser, a .NET tool, a package or a wheel there that a Medium agent then runs outside the fence';
  if (i.mode !== 'on') {
    return { env: {}, lines: [`WARNING medium agent caches: Medium agents' ${exposed.map(([k]) => k).join(', ')} are in ${sharedCacheDir(root)}, which workers write; ${why}. daemon.json "mediumAgentCaches": "on" moves them to ${path.join(root, MEDIUM_CACHE_CHILD)} (w5870)`] };
  }
  const out: MediumCaches = { env: {}, lines: [] };
  const kept: string[] = [];
  for (const [k, v] of exposed) {
    const to = mediumCacheFor(root, v);
    if (!to || workerWritable(to, root, extra, opened)) {
      kept.push(`${k} (${to ?? v} is in a folder workers write)`);
      continue;
    }
    try {
      mkdir(to);
    } catch (err) {
      kept.push(`${k} (could not make ${to}: ${(err as Error).message})`);
      continue;
    }
    out.env[k] = to;
  }
  if (kept.length) out.lines.push(`WARNING medium agent caches: Medium agents keep the workers' ${kept.join(', ')} (${why}; w5870)`);
  if (Object.keys(out.env).length) out.lines.push(`medium agent caches: Medium agents' ${Object.keys(out.env).join(', ')} are in ${path.join(root, MEDIUM_CACHE_CHILD)}; sandbox agents keep ${sharedCacheDir(root)} (w5870)`);
  return out;
}

/**
 * The user PATH's entries inside a folder workers write, and the PATH without them (w5870). `value` is the raw registry value
 * (a REG_EXPAND_SZ one unexpanded); `expand` turns an entry's %VARS% into a path. Exported for tests.
 */
export function planUserPath(value: string, root: string, extra: (string | undefined)[], expand: (s: string) => string, opened: (string | undefined)[] = []): { exposed: string[]; kept: string } {
  const parts = value.split(';');
  const bad = (e: string) => {
    const p = expand(e.trim()).replace(/^"|"$/g, '');
    return !!p && path.isAbsolute(p) && workerWritable(p, root, extra, opened);
  };
  return { exposed: parts.filter((e) => e.trim() && bad(e)), kept: parts.filter((e) => !(e.trim() && bad(e))).join(';') };
}

/** Runs a PowerShell script and answers its output (the exec seam tests replace). */
export type RunPs = (script: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

// The PATH goes both ways as base64 of its UTF-8 bytes (w5946 F1, F2): PowerShell's console output would decode a non-ASCII
// entry through the OEM code page, and the script then carries only [A-Za-z0-9+/=], so no quote of any kind can end its string.
const PS_READ = "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($k -and $k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path').ToString(); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'))) }";
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/**
 * The PowerShell that writes the user PATH back with its registry type kept (exported for tests). It writes only if the value
 * is still `old` (another writer since the read wins), reads its own write back, and on a mismatch puts `old` back: it prints
 * ok, changed or restored.
 */
export const psWritePath = (value: string, kind: string, old: string) => {
  const t = `[Microsoft.Win32.RegistryValueKind]::${kind === 'ExpandString' ? 'ExpandString' : 'String'}`;
  const dec = (s: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;
  return `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $old = ${dec(old)}; $new = ${dec(value)}; ` +
    `if ([string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -cne $old) { 'changed' } else { $k.SetValue('Path', $new, ${t}); ` +
    `if ([string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -cne $new) { $k.SetValue('Path', $old, ${t}); 'restored' } else { 'ok' } }; $k.Close()`;
};

/**
 * The user PATH check at the daemon's start (Windows only; no other OS keeps a PATH in a registry): warn, or with the switch
 * on take the exposed entries off, the value's kind kept (REG_EXPAND_SZ stays expandable). Processes started after the next
 * sign-in see it; running ones keep theirs. Never throws: answers the lines to log.
 */
export async function fixUserPath(o: { root?: string; fenced: boolean; mode?: string; extra?: (string | undefined)[]; opened?: (string | undefined)[]; platform?: NodeJS.Platform; runPs: RunPs; expand?: (s: string) => string }): Promise<string[]> {
  if (!o.root || !o.fenced || (o.platform ?? process.platform) !== 'win32') return [];
  const root = o.root;
  const expand = o.expand ?? ((s: string) => s.replace(/%([^%]+)%/g, (m, n: string) => process.env[n] ?? m));
  try {
    const r = await o.runPs(PS_READ);
    if (r.code !== 0) return [`WARNING medium agent caches: could not read the user PATH (${(r.stderr || r.stdout).trim().slice(0, 200)}); it stays as it is (w5870)`];
    const [kind, enc = ''] = r.stdout.replace(/\r/g, '').split('\n');
    if (!kind?.trim()) return [];
    const value = Buffer.from(enc.trim(), 'base64').toString('utf8');
    if (value.includes('\uFFFD')) return ['WARNING medium agent caches: the user PATH did not read back as UTF-8; it stays as it is (w5870)'];
    const plan = planUserPath(value, root, o.extra ?? [], expand, o.opened ?? []);
    if (!plan.exposed.length) return [];
    const list = plan.exposed.join(', ');
    if (o.mode !== 'on') return [`WARNING medium agent caches: the user PATH holds ${list}, in a folder workers write; every Medium process of this account searches it, so a program planted there runs outside the fence. daemon.json "mediumAgentCaches": "on" takes it off (w5870)`];
    const w = await o.runPs(psWritePath(plan.kept, kind.trim(), value));
    if (w.code !== 0 || w.stdout.trim() !== 'ok') return [`WARNING medium agent caches: could not take ${list} off the user PATH (${(w.stderr || w.stdout).trim().slice(0, 200)}); it stays as it is (w5870)`];
    return [`medium agent caches: took ${list} off the user PATH (a folder workers write); processes started after the next sign-in no longer search it (w5870)`];
  } catch (e) {
    return [`WARNING medium agent caches: the user PATH check failed (${(e as Error).message}); it stays as it is (w5870)`];
  }
}
