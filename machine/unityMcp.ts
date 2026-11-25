// The Unity MCP bridge for a machine's agents (docs/machines.md, "Unity MCP"): the MCP-for-Unity server the machine's
// own Claude Code runs, given to each sandbox agent confined to its sandbox's editor (none in the main clone, w536), the
// way the host confines its sandboxes' workers (server/unityMcp.ts).
import { claudeJsonFiles } from '../server/claudeHome.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStatusFiles, syncStatusDir } from '../server/unityMcp.ts';
import { mcpStatusDirs } from '../server/unityHang.ts';
import { normProject } from '../server/unityHang.ts';
import type { StdioServer } from '../server/launch.ts';

export type { StdioServer };

/** The status folder of a place: the only editor its agents' Unity MCP server can find (UNITY_MCP_STATUS_DIR). */
export const mcpStatusDir = (appDir: string, place: string) => path.join(appDir, 'unity-mcp', place);

/**
 * w5650: the same status, in `<status folder>/.unity-mcp`, for the server's home. MCP for Unity's preflight
 * (transport/legacy/unity_connection.py read_status_file, mcpforunityserver 10.0.0) reads only Path.home()/.unity-mcp
 * and ignores UNITY_MCP_STATUS_DIR; with no file for its editor there it falls back to the newest status file of any
 * project, and a stale `reloading: true` one in the person's own ~/.unity-mcp refused every call to a fenced editor
 * ("Unity is reloading") on LothDesktop. The scoped server's USERPROFILE and HOME are the status folder, so its
 * preflight reads this copy, which holds only its own editor's file.
 */
export const mcpHomeStatusDir = (appDir: string, place: string) => path.join(mcpStatusDir(appDir, place), '.unity-mcp');

const asServer = (x: unknown): StdioServer | undefined => {
  const s = x as { type?: string; command?: unknown; args?: unknown; env?: unknown } | undefined;
  if (!s || typeof s.command !== 'string' || !s.command || (s.type && s.type !== 'stdio')) return undefined;
  const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [];
  const env = s.env && typeof s.env === 'object' ? Object.fromEntries(Object.entries(s.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
  return { command: s.command, args, ...(env && Object.keys(env).length ? { env } : {}) };
};

/**
 * The MCP-for-Unity server to run on this machine: daemon.json's unityMcpServer, else the "UnityMCP" entry the
 * machine's own Claude Code has in ~/.claude.json (MCP for Unity registers it per project): the main clone's, then
 * a user-wide one, then the one most of its projects use. Undefined when there is none: agents then have no bridge.
 */
export function resolveUnityMcpServer(explicit: StdioServer | undefined, repoPath: string, claudeJson: string | string[] = claudeJsonFiles(process.env, os.homedir())): { server?: StdioServer; source: string } {
  if (explicit?.command) return { server: explicit, source: 'daemon.json unityMcpServer' };
  // w5305: the daemon's own Claude Code config (<root>/claude/.claude.json) first, then the person's ~/.claude.json, where
  // MCP for Unity registers it (server/claudeHome.ts claudeJsonFiles).
  const files = Array.isArray(claudeJson) ? claudeJson : [claudeJson];
  let last: { server?: StdioServer; source: string } = { source: 'no .claude.json' };
  for (const f of files) {
    last = unityMcpFrom(f, repoPath);
    if (last.server) return last;
  }
  return last;
}

function unityMcpFrom(claudeJson: string, repoPath: string): { server?: StdioServer; source: string } {
  let cfg: { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  try {
    cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { source: `no ${claudeJson}` };
  }
  const projects = Object.entries(cfg.projects ?? {});
  const want = normProject(repoPath);
  const own = projects.find(([p]) => normProject(p) === want);
  const ownServer = asServer(own?.[1]?.mcpServers?.UnityMCP);
  if (ownServer) return { server: ownServer, source: `${claudeJson} (project ${own![0]})` };
  const user = asServer(cfg.mcpServers?.UnityMCP);
  if (user) return { server: user, source: `${claudeJson} (user)` };
  const votes = new Map<string, { server: StdioServer; n: number; first: string }>();
  for (const [p, v] of projects) {
    const s = asServer(v?.mcpServers?.UnityMCP);
    if (!s) continue;
    const k = JSON.stringify(s);
    const e = votes.get(k) ?? { server: s, n: 0, first: p };
    e.n++;
    votes.set(k, e);
  }
  const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
  return best ? { server: best.server, source: `${claudeJson} (project ${best.first}, used by ${best.n} project(s))` } : { source: `no UnityMCP entry in ${claudeJson}` };
}

/**
 * The server an agent in `place` runs: `server`, confined to that place's status folder. `home` (w5650, default on):
 * its USERPROFILE and HOME are that folder too, so the preflight's Path.home()/.unity-mcp is mcpHomeStatusDir; false
 * keeps the person's own home (the path before w5650, daemon.json unityMcpScopedHome: false).
 */
export function scopedUnityMcp(server: StdioServer, appDir: string, place: string, home = true): StdioServer {
  const dir = mcpStatusDir(appDir, place);
  return { command: server.command, args: server.args, env: { ...server.env, UNITY_MCP_STATUS_DIR: dir, ...(home ? { USERPROFILE: dir, HOME: dir } : {}) } };
}

/**
 * Keeps each place's status folder holding only its own editor's status file (syncStatusDir), from the editor pids
 * the daemon's watches already know. A status file counts only if written since that editor started: for a pid first
 * seen at a later look, since the look before (it was not running then); for one already running at the daemon's
 * first look, any age (it predates the daemon, and a stale file of the same project cannot be newer than its own).
 */
export class McpScopes {
  private readonly seen = new Map<string, { pid?: number; since?: number; lookedAt?: number }>();
  private readonly home?: string;

  /** `home`: one status folder (tests); unset: every folder editors write in (server/unityHang.ts mcpStatusDirs, w5540). */
  constructor(home?: string) {
    this.home = home;
  }

  /** One look: `places` maps a place key to its project folder and its editor's pid (undefined: not running). */
  sync(appDir: string, places: { place: string; project: string; pid?: number }[], now: number, log: (line: string) => void = () => undefined) {
    const files = readStatusFiles(this.home ?? mcpStatusDirs());
    for (const p of places) {
      const st = this.seen.get(p.place) ?? {};
      if (p.pid && p.pid !== st.pid) st.since = st.lookedAt ?? 0;
      st.pid = p.pid;
      st.lookedAt = now;
      this.seen.set(p.place, st);
      try {
        for (const dir of [mcpStatusDir(appDir, p.place), mcpHomeStatusDir(appDir, p.place)]) syncStatusDir(dir, p.project, p.pid ? { since: st.since } : undefined, files);
      } catch (e) {
        log(`unity mcp ${p.place}: status folder: ${(e as Error).message}`);
      }
    }
    // A deleted sandbox: its folder goes too.
    for (const k of [...this.seen.keys()]) {
      if (places.some((p) => p.place === k)) continue;
      this.seen.delete(k);
      fs.rmSync(mcpStatusDir(appDir, k), { recursive: true, force: true });
    }
  }
}

/**
 * The uvx runs that fill a uv cache with the server's package, when the server is `uvx --offline --from <pkg> <tool>`
 * (what MCP for Unity registers): first a check that needs no network (the package already there), then the same run
 * online. Agents run the server against the worker install's own uv cache (UV_CACHE_DIR, w5281), which nothing else
 * fills, and `--offline` cannot fill it, so every sandbox agent had no Unity MCP bridge on LothDesktop (w5377). Since w5565
 * Medium agents have their own cache (sharedCaches.ts mediumUvCacheDir), filled the same way.
 * Undefined for any other server.
 */
export function uvWarmRuns(server: StdioServer): { offline: string[]; online: string[] } | undefined {
  const name = path.win32.basename(server.command).toLowerCase();
  if (name !== 'uvx' && name !== 'uvx.exe') return undefined;
  const a = server.args;
  const from = a.indexOf('--from');
  if (!a.includes('--offline') || from < 0 || !a[from + 1]) return undefined;
  const online = ['--from', a[from + 1], 'python', '-c', 'pass'];
  return { offline: ['--offline', ...online], online };
}
