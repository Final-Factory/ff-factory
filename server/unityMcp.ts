import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normProject } from './unityHang.ts';

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
export function readStatusFiles(dir = path.join(os.homedir(), '.unity-mcp')): StatusFile[] {
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
 * editor left (whose port another editor may have taken since) never is.
 */
export function syncStatusDir(dir: string, project: string, editor: { since?: number } | undefined, files: StatusFile[]) {
  const want = normProject(project);
  const mine = editor ? files.filter((f) => f.project === want && f.mtimeMs >= (editor.since ?? 0) - 2000).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] : undefined;
  fs.mkdirSync(dir, { recursive: true });
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith('unity-mcp-') && n.endsWith('.json') && n !== mine?.name && n !== LEGACY_PORT_FILE) fs.rmSync(path.join(dir, n), { force: true });
  }
  if (mine) writeIfChanged(path.join(dir, mine.name), mine.text);
  writeIfChanged(path.join(dir, LEGACY_PORT_FILE), JSON.stringify({ unity_port: mine?.port ?? 0, project_path: project }));
}
