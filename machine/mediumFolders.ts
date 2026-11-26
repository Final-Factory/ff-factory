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
 * root (the config's temp and sandboxes folders). Case-blind, as Windows and macOS file systems are. Exported for tests.
 */
export function workerWritable(p: string, root: string, extra: (string | undefined)[] = []): boolean {
  const low = (s: string) => path.resolve(s).toLowerCase();
  const lp = low(p);
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
  const mkdir = i.mkdir ?? ((d: string) => fs.mkdirSync(d, { recursive: true }));
  const exposed: { what: string; now: string; to: string; key: 'tempRoot' | 'cargoHome' }[] = [];
  if (workerWritable(i.tempRoot, root, extra)) exposed.push({ what: 'TMP/TEMP root', now: i.tempRoot, to: mediumTempRoot(root), key: 'tempRoot' });
  if (i.cargoHome && workerWritable(i.cargoHome, root, extra)) exposed.push({ what: 'CARGO_HOME', now: i.cargoHome, to: mediumCargoHomeDir(root), key: 'cargoHome' });
  if (!exposed.length) return { lines: [] };
  const why = 'a fenced worker could plant a script, DLL or cargo config.toml there that a Medium agent then runs outside the fence';
  if (i.mode !== 'on') {
    const list = exposed.map((e) => `${e.what} ${e.now}`).join(' and ');
    const to = exposed.map((e) => e.to).join(' and ');
    return { lines: [`WARNING medium agent folders: Medium agents' ${list} ${exposed.length > 1 ? 'are' : 'is'} in folders workers write; ${why}. daemon.json "mediumAgentFolders": "on" moves them to ${to} (w5862)`] };
  }
  const out: MediumFolders = { lines: [] };
  for (const e of exposed) {
    if (workerWritable(e.to, root, extra)) {
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
