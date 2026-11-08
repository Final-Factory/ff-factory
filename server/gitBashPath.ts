import fs from 'node:fs';
import path from 'node:path';
import { sizeOf } from './cleanup.ts';

/**
 * w3700 (lothsahn, 2026-11-08: "There's also a v:/v/ffw folder that looks like workers used the wrong path. Please have it
 * clean that up, figure out how it happened, and prevent it from happening again."): a Git Bash path in a PowerShell command.
 *
 * Git Bash spells the install folder V:\ffw as `/v/ffw`, and a worker's `echo $TMPDIR` there prints `/v/ffw/tmp/ffa-<id>`.
 * Git Bash turns such an argument back into V:\ffw when it starts a Windows program, but PowerShell, and every program it
 * starts, reads `/v/ffw/...` as a path from the root of the current drive: V:\v\ffw\... (measured on LothDesktop,
 * 2026-11-08: `[IO.Path]::GetFullPath('/v/ffw/tmp/x')` from V:\ffw\sandboxes\slot2 is V:\v\ffw\tmp\x). Three workers' temp
 * folders had grown there (V:\v\ffw\tmp\ffa-48e6e232 with a 60 MB clip zip, ffa-01c194fe with a git worktree of FFU, an empty
 * ffa-4e9bffcb), outside the install folder, where neither the clean-up nor a worker may delete.
 *
 * So the sandbox guard (server/guard.ts) refuses a PowerShell command that names the install folder's drive in Git Bash's
 * spelling, and says the Windows spelling to use. Like the rest of the guard it reads the command's text: a script file or a
 * variable it does not see.
 */

/** The Git Bash spelling of a Windows folder (`V:\ffw` -> `/v/ffw`), or undefined when it is not a drive path. */
export function gitBashSpelling(winPath: string): string | undefined {
  const m = /^([a-zA-Z]):[\\/]*(.*)$/.exec(winPath.trim());
  if (!m) return undefined;
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The refusal for a PowerShell command that names `root` (the worker install folder, a Windows path) as Git Bash spells it, or
 * undefined. A path counts where one starts: at the start, after a space, a quote, `=`, `(`, `,` or `>` (not inside a URL).
 */
export function checkGitBashPathInPowerShell(cmd: string, root: string): string | undefined {
  const bash = gitBashSpelling(root);
  if (!bash) return undefined;
  const re = new RegExp(`(^|[\\s'"=(,>])(${escape(bash)})(?=$|[\\\\/\\s'";),])`, 'i');
  const m = re.exec(cmd);
  if (!m) return undefined;
  const drive = root.trim()[0]!.toUpperCase();
  const win = `${drive}:${root.trim().slice(2).replace(/\//g, '\\').replace(/\\+$/, '')}`;
  return (
    `Refused: this PowerShell command names ${m[2]}, Git Bash's spelling of ${win}. PowerShell and the programs it starts read ` +
    `it as ${drive}:${m[2].replace(/\//g, '\\')}, a folder outside the worker install folder that nobody may clean up (w3700). ` +
    `Write ${win} instead, or $env:TEMP for your temp folder.`
  );
}

/**
 * Where a PowerShell command put a worker's temp folder when it read Git Bash's `/v/ffw/tmp/ffa-<id>` (w3707): the agents' temp
 * root `tempRoot` spelled from the root of its own drive (V:\ffw\tmp -> V:\v\ffw\tmp), or undefined off Windows paths.
 */
export function gitBashStrayRoot(tempRoot: string): string | undefined {
  const bash = gitBashSpelling(tempRoot);
  if (!bash) return undefined;
  return `${tempRoot.trim()[0]!.toUpperCase()}:${bash.replace(/\//g, '\\')}`;
}

export interface StraySweep {
  removed: { path: string; bytes: number }[];
  kept: { path: string; why: string }[];
  /** The empty folders of the stray chain removed after (V:\v\ffw\tmp, V:\v\ffw, V:\v). */
  emptied: string[];
}

/**
 * Remove the temp folders of closed workers from the stray root (w3707, lothsahn, 2026-11-08: "There's also a v:/v/ffw folder
 * that looks like workers used the wrong path. Please have it clean that up"). Only this one known path, outside the install
 * folder: `ffa-<id>` folders whose worker `closed(id)` says is stopped with every request closed; anything else in it stays and
 * is listed. Then the chain's folders are removed while empty, up to the drive's first folder (rmdir, never recursive).
 */
export async function sweepGitBashStray(stray: string, top: string, closed: (sid: string) => boolean, dryRun = false): Promise<StraySweep> {
  const out: StraySweep = { removed: [], kept: [], emptied: [] };
  let names: string[];
  try {
    names = await fs.promises.readdir(stray);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = path.join(stray, n);
    const sid = /^ffa-([\w-]+)$/i.exec(n)?.[1];
    if (!sid) {
      out.kept.push({ path: p, why: 'not a worker temp folder' });
      continue;
    }
    if (!closed(sid)) {
      out.kept.push({ path: p, why: `worker ${sid} is on a request that has not closed, or still runs` });
      continue;
    }
    const bytes = await sizeOf(p).catch(() => 0);
    if (!dryRun) {
      try {
        await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 2 });
      } catch (e) {
        out.kept.push({ path: p, why: `could not be removed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` });
        continue;
      }
    }
    out.removed.push({ path: p, bytes });
  }
  if (dryRun) return out;
  // V:\v\ffw\tmp, then V:\v\ffw, then V:\v (`top`): each only while empty.
  const rel = path.relative(top, stray);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return out;
  for (let d = stray; ; d = path.dirname(d)) {
    try {
      await fs.promises.rmdir(d);
      out.emptied.push(d);
    } catch {
      break;
    }
    if (path.resolve(d) === path.resolve(top)) break;
  }
  return out;
}

/** The first folder of the stray chain on its drive (V:\v\ffw\tmp -> V:\v): the outermost one the sweep may remove when empty. */
export function gitBashStrayTop(stray: string): string {
  const m = /^([A-Za-z]:)[\\/]+([^\\/]+)/.exec(stray);
  return m ? `${m[1]}\\${m[2]}` : stray;
}
