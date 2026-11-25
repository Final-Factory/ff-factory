// w5702: the Linux half of w5563 ("transcripts are read-only to workers", docs/transcript-seal.md). Under the Linux write
// lock (machine/writeLock.ts) a worker writes the whole Claude home `<root>/claude`, and Landlock grants a folder's rights
// to everything below it, so no rule can take `projects` back. With `transcriptLock` on, `projects` is a link to
// `<root>/transcripts`, a root folder the lock does not open, and each claude gets rules for its own conversation only:
// its `<id>.jsonl` (write, in any project folder) and its `<id>/` folder. Another conversation's transcript cannot be
// written, truncated, planted, renamed or deleted (Landlock refuses with EACCES; measured on biscuit, 2026-11-25).
//
// A new conversation's file cannot be made ahead: Claude Code refuses an id whose `<id>.jsonl` exists ("Session ID ... is
// already in use"; its check is a statSync, which follows links). So the host leaves a dangling link `<id>.jsonl` ->
// `<id>/.new.jsonl` in the cwd's project folder: the check passes, the CLI's first write makes the file inside its own
// folder, and once that claude has exited the host moves the file over the link (finishNewTranscripts). Measured on
// biscuit with Claude Code 2.1.299: a new conversation, a resume, /compact and a resume after it all ran inside the lock.
import fs from 'node:fs';
import path from 'node:path';
import { projectSlug } from '../server/claudeHome.ts';

/** The root folder that holds the agents' transcripts once they are locked (`<root>/claude/projects` links to it). */
export const TRANSCRIPTS = 'transcripts';
/** Where a new conversation's first claude writes its transcript, inside its own `<id>/` folder. */
export const NEW_TRANSCRIPT = '.new.jsonl';

const lstat = (p: string) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
};
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Makes `<home>/projects` a link to `<root>/transcripts` and answers what it changed (undefined: nothing). The first time
 * it moves the folder there (a rename, so a claude appending by path finds its file again at once). Whatever else stands
 * at `projects` after that (a worker may remove the link and make a folder, since it writes the Claude home) is moved into
 * `transcripts/.replaced-<time>`, out of every worker's reach, and the link is made again. Run outside the lock: by the
 * daemon when the lock is set up, and by the agent host before each locked claude starts.
 */
export function linkTranscripts(root: string, home: string, now = Date.now()): string | undefined {
  const t = path.join(path.resolve(root), TRANSCRIPTS);
  const l = path.join(home, 'projects');
  const target = path.relative(home, t);
  const st = lstat(l);
  if (st?.isSymbolicLink() && (fs.readlinkSync(l) === target || real(l) === real(t))) return undefined;
  let did: string;
  if (st?.isDirectory() && !lstat(t)) {
    fs.renameSync(l, t);
    did = `moved ${l} to ${t}`;
  } else if (st) {
    fs.mkdirSync(t, { recursive: true });
    const aside = path.join(t, `.replaced-${now}`);
    fs.renameSync(l, aside);
    did = `${l} was not the link to ${t} (a ${st.isSymbolicLink() ? `link to ${fs.readlinkSync(aside)}` : st.isDirectory() ? 'folder' : 'file'}); kept it at ${aside}`;
  } else {
    fs.mkdirSync(t, { recursive: true });
    did = `made ${t}`;
  }
  for (let i = 0; ; i++) {
    try {
      fs.symlinkSync(target, l);
      return `${did}; ${l} -> ${target}`;
    } catch (e) {
      // A claude that wrote in the moment between the rename and the link made a new folder there: keep it aside too.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 3) throw e;
      fs.renameSync(l, path.join(t, `.replaced-${now}-${i}`));
    }
  }
}

/** The project folders of the transcripts folder (not the `.replaced-*` ones). */
const projectDirs = (t: string) => {
  try {
    return fs.readdirSync(t, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => path.join(t, d.name));
  } catch {
    return [];
  }
};

/**
 * Moves a new conversation's transcript from `<id>/.new.jsonl` over its `<id>.jsonl` link, in every project folder, and
 * removes a link whose claude never wrote. Run only when no claude of that conversation runs: after one exits and before
 * the next starts.
 */
export function finishNewTranscripts(t: string, sid: string): string[] {
  const done: string[] = [];
  for (const d of projectDirs(t)) {
    const link = path.join(d, `${sid}.jsonl`);
    if (!lstat(link)?.isSymbolicLink() || fs.readlinkSync(link) !== path.join(sid, NEW_TRANSCRIPT)) continue;
    const staged = path.join(d, sid, NEW_TRANSCRIPT);
    if (lstat(staged)?.isFile()) fs.renameSync(staged, link);
    else fs.unlinkSync(link);
    done.push(link);
  }
  return done;
}

/**
 * ff-landlock.py rules for one conversation: `--rw` its `<id>.jsonl` and `<id>/` in every project folder that has them.
 * When it has no transcript yet, the cwd's project folder gets its `<id>/` folder and the `<id>.jsonl` link into it (both
 * the cwd as given and resolved, should they differ). `t` is the transcripts folder, `sid` a checked session id
 * (workerFence.ts sessionIdOf).
 */
export function ownTranscriptArgs(t: string, sid: string, cwd?: string): string[] {
  finishNewTranscripts(t, sid);
  const dirs = projectDirs(t);
  if (!dirs.some((d) => lstat(path.join(d, `${sid}.jsonl`))?.isFile())) {
    for (const c of new Set(cwd ? [cwd, real(cwd)] : [])) {
      const d = path.join(t, projectSlug(c));
      fs.mkdirSync(path.join(d, sid), { recursive: true });
      if (!lstat(path.join(d, `${sid}.jsonl`))) fs.symlinkSync(path.join(sid, NEW_TRANSCRIPT), path.join(d, `${sid}.jsonl`));
    }
  }
  const args: string[] = [];
  for (const d of projectDirs(t)) {
    for (const p of [path.join(d, `${sid}.jsonl`), path.join(d, sid)]) {
      const st = lstat(p);
      if (st?.isFile() || st?.isDirectory()) args.push('--rw', p);
    }
  }
  return args;
}
