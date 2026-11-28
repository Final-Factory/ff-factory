import fs from 'node:fs';
import path from 'node:path';
import { mcpStatusDirs, normProject } from './unityHang.ts';

// ---------------------------------------------------------------- one editor per sandbox

/**
 * Each sandbox's Unity MCP server sees only that sandbox's editor. MCP-for-Unity (stdio) finds editors by
 * their status files (unity-mcp-status-<hash>.json) in UNITY_MCP_STATUS_DIR, ~/.unity-mcp by default,
 * where every editor on the machine writes. Pinned to an editor it cannot find (restarting, reloading,
 * crashed), it reconnects to whatever discovery finds next: the newest status file, the newest port file,
 * or port 6400, i.e. another sandbox's editor or the live game's. So a sandbox's workers get a folder of
 * their own as UNITY_MCP_STATUS_DIR, and syncStatusDir keeps in it only their editor's status file, and a
 * legacy port file that sends that last-resort fallback to their editor's own port (0 while it is down).
 */
export interface StatusFile {
  name: string;
  project: string;
  port?: number;
  mtimeMs: number;
  text: string;
}

/** The editors' status files in `dir` (~/.unity-mcp): read once per poll for every sandbox. */
export function readStatusFiles(dir: string | string[] = mcpStatusDirs()): StatusFile[] {
  if (Array.isArray(dir)) return dir.flatMap((d) => readStatusFiles(d));
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^unity-mcp-status-[\w-]+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: StatusFile[] = [];
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      // Some editors write a byte order mark.
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const j = JSON.parse(text) as { project_path?: string; unity_port?: number };
      if (j.project_path) out.push({ name, project: normProject(j.project_path), port: typeof j.unity_port === 'number' ? j.unity_port : undefined, mtimeMs: fs.statSync(file).mtimeMs, text });
    } catch {
      // being written; next poll
    }
  }
  return out;
}

/**
 * readStatusFiles off the loop (w6639): the same files, read with fs.promises. On BEAST the synchronous read held the daemon
 * 10.8 s (2026-11-28 00:49Z, refreshMcpScopes), on a busy disk.
 */
export async function readStatusFilesAsync(dir: string | string[] = mcpStatusDirs()): Promise<StatusFile[]> {
  if (Array.isArray(dir)) return (await Promise.all(dir.map((d) => readStatusFilesAsync(d)))).flat();
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => /^unity-mcp-status-[\w-]+\.json$/.test(n));
  } catch {
    return [];
  }
  const read = async (name: string): Promise<StatusFile | undefined> => {
    try {
      const file = path.join(dir, name);
      const text = (await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, '');
      const j = JSON.parse(text) as { project_path?: string; unity_port?: number };
      if (!j.project_path) return undefined;
      return { name, project: normProject(j.project_path), port: typeof j.unity_port === 'number' ? j.unity_port : undefined, mtimeMs: (await fs.promises.stat(file)).mtimeMs, text };
    } catch {
      return undefined; // being written; next poll
    }
  };
  return (await Promise.all(names.map(read))).filter((f): f is StatusFile => !!f);
}

const LEGACY_PORT_FILE = 'unity-mcp-port.json';

const writeIfChanged = (file: string, text: string) => {
  try {
    if (fs.readFileSync(file, 'utf8') === text) return;
  } catch {
    // not there yet
  }
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
};

/**
 * Bring a sandbox's status folder up to date. `editor` is its editor while that process is alive (`since`:
 * when it was launched); its status file is copied only if written since then, so a stale file a crashed
 * editor left (whose port another editor may have taken since) never is. `strict`: written after `since`, no allowance.
 */
/** What syncStatusDir does to a folder: the status files to keep (written if changed), the rest of unity-mcp-*.json removed. */
interface StatusDirPlan {
  keep: Set<string>;
  writes: { file: string; text: string }[];
}

function statusDirPlan(dir: string, project: string, editor: { since?: number; strict?: boolean } | undefined, files: StatusFile[], clones: { project: string; since: number }[]): StatusDirPlan {
  const want = normProject(project);
  // A daemon-launched editor's file may carry an mtime up to 2 s before its recorded launch (clock and mtime rounding); a
  // `strict` one (an EditorInstance.json pid, w5746) gets no such allowance: its file must be newer than `since` (w5779).
  const fresh = (f: StatusFile) => (editor?.strict ? f.mtimeMs > (editor.since ?? 0) : f.mtimeMs >= (editor?.since ?? 0) - 2000);
  const mine = editor ? files.filter((f) => f.project === want && fresh(f)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] : undefined;
  // w5799: a peer run's second editor on a ParrelSync clone of the project, each its newest file written after it was
  // first seen (strict, as an EditorInstance.json pid's), so the worker's server lists it beside the place's own editor.
  const cloneFiles = clones.flatMap((c) => {
    const key = normProject(c.project);
    const f = files.filter((x) => x.project === key && x.mtimeMs > c.since).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return f ? [f] : [];
  });
  const keep = new Set([mine?.name, ...cloneFiles.map((f) => f.name)].filter((n): n is string => !!n));
  const writes = [...(mine ? [mine] : []), ...cloneFiles].map((f) => ({ file: path.join(dir, f.name), text: f.text }));
  writes.push({ file: path.join(dir, LEGACY_PORT_FILE), text: JSON.stringify({ unity_port: mine?.port ?? 0, project_path: project }) });
  return { keep, writes };
}

const strays = (names: string[], keep: Set<string>) => names.filter((n) => n.startsWith('unity-mcp-') && n.endsWith('.json') && !keep.has(n) && n !== LEGACY_PORT_FILE);

/**
 * Bring a sandbox's status folder up to date. `editor` is its editor while that process is alive (`since`:
 * when it was launched); its status file is copied only if written since then, so a stale file a crashed
 * editor left (whose port another editor may have taken since) never is. `strict`: written after `since`, no allowance.
 */
export function syncStatusDir(
  dir: string,
  project: string,
  editor: { since?: number; strict?: boolean } | undefined,
  files: StatusFile[],
  clones: { project: string; since: number }[] = [],
) {
  const plan = statusDirPlan(dir, project, editor, files, clones);
  fs.mkdirSync(dir, { recursive: true });
  for (const n of strays(fs.readdirSync(dir), plan.keep)) fs.rmSync(path.join(dir, n), { force: true });
  for (const w of plan.writes) writeIfChanged(w.file, w.text);
}

let asyncTmp = 0;

/**
 * syncStatusDir off the loop (w6639): the same folder afterwards, with fs.promises. Its writes held BEAST's daemon up to
 * 10.8 s (2026-11-28, refreshMcpScopes). A write goes through its own temporary name, so a synchronous sync of the same
 * folder (stdioMcpFor) at the same time cannot take its temporary file.
 */
export async function syncStatusDirAsync(
  dir: string,
  project: string,
  editor: { since?: number; strict?: boolean } | undefined,
  files: StatusFile[],
  clones: { project: string; since: number }[] = [],
  wanted: () => boolean = () => true,
): Promise<void> {
  const plan = statusDirPlan(dir, project, editor, files, clones);
  // w6675: `wanted` is asked again before each step: a sandbox deleted (or a newer pass begun) while this one waited on the
  // disk must not have its folder made again by this pass.
  if (!wanted()) return;
  await fs.promises.mkdir(dir, { recursive: true });
  if (!wanted()) return;
  await Promise.all(strays(await fs.promises.readdir(dir), plan.keep).map((n) => fs.promises.rm(path.join(dir, n), { force: true })));
  for (const w of plan.writes) {
    try {
      if ((await fs.promises.readFile(w.file, 'utf8')) === w.text) continue;
    } catch {
      // not there yet
    }
    if (!wanted()) return;
    const tmp = `${w.file}.${process.pid}.${++asyncTmp}.tmp`;
    try {
      await fs.promises.writeFile(tmp, w.text);
      await fs.promises.rename(tmp, w.file);
    } catch (e) {
      // w6675: its name is its own, so nothing else would ever remove it (a rename Windows refused while a reader held the file).
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}
