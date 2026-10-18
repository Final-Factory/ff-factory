// The machine's own gh login and its token's scopes (w1463, shared/ghLogin.ts): read with `gh auth status`, which prints the
// scopes and never the token unless asked (--show-token, never passed here), and reported to the portal as names only.
// Read at start, every READ_EVERY_MS, and within a minute of gh's hosts file changing (a `gh auth login`, `gh auth refresh -s
// workflow` or `gh auth switch` rewrites it). gh's output is parsed here and dropped: no line of it is logged or sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunResult } from '../server/proc.ts';
import { ghLoginLabel, parseGhStatusJson, parseGhStatusText, type GhLogin } from '../shared/ghLogin.ts';

/** How often the login is read again with no change seen (one GitHub request each: gh checks the token's scopes). */
export const READ_EVERY_MS = 30 * 60_000;

/** How often gh's hosts file is looked at for a change. */
export const LOOK_EVERY_MS = 60_000;

/**
 * gh's hosts file (gh's own order, `gh help environment`): $GH_CONFIG_DIR, else $XDG_CONFIG_HOME/gh, else on Windows
 * %AppData%\GitHub CLI, else ~/.config/gh.
 */
export function ghHostsFile(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  const dir = env.GH_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'gh') : platform === 'win32' && env.AppData ? path.join(env.AppData, 'GitHub CLI') : path.join(home, '.config', 'gh'));
  return path.join(dir, 'hosts.yml');
}

export interface GhLoginDeps {
  run: (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
  /** The hosts file's size and mtime as a string, or '' when it is missing. */
  look: () => string;
  now: () => Date;
  send: (gh: GhLogin) => void;
  log: (line: string) => void;
}

const ARGS = ['auth', 'status', '--active', '--hostname', 'github.com'];

/** Read the login once: the JSON form first, then the text form for a gh without --json. Never throws. */
export async function readGhLogin(run: GhLoginDeps['run'], now: Date): Promise<GhLogin> {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  const j = await run('gh', [...ARGS, '--json', 'hosts'], { timeoutMs: 30_000, env });
  if (j.code === -1 && /ENOENT|not found|not recognized/i.test(j.stderr)) return { checkedAt: now.toISOString(), ok: false, error: 'gh is not installed (or not on the daemon\'s PATH)' };
  const fromJson = j.code === 0 ? parseGhStatusJson(j.stdout, now) : undefined;
  if (fromJson) return fromJson;
  // gh before --json (2.71): its text, which goes to stderr on some versions and stdout on others.
  const t = await run('gh', ARGS, { timeoutMs: 30_000, env });
  return parseGhStatusText(`${t.stdout}\n${t.stderr}`, now);
}

/** The daemon's watch of its gh login: reads it when due, sends it when it changed, and gives the last one to each hello. */
export class GhLoginWatch {
  private last?: GhLogin;
  private lastSent = '';
  private lastRead = 0;
  private lastLook?: string;
  private reading = false;

  private readonly d: GhLoginDeps;

  constructor(d: GhLoginDeps) {
    this.d = d;
  }

  /** The last reading, for a new connection's hello. */
  current(): GhLogin | undefined {
    return this.last;
  }

  /** Send the last reading again (after a reconnect: the portal keeps it, but a new portal may not have it). */
  resend() {
    if (this.last) this.d.send(this.last);
  }

  /** Read again when the hosts file changed or the reading is older than READ_EVERY_MS (`force`: now). */
  async tick(force = false): Promise<void> {
    if (this.reading) return;
    const look = this.d.look();
    const changed = this.lastLook !== undefined && look !== this.lastLook;
    this.lastLook = look;
    if (!force && !changed && this.last && this.d.now().getTime() - this.lastRead < READ_EVERY_MS) return;
    this.reading = true;
    try {
      const gh = await readGhLogin(this.d.run, this.d.now());
      this.lastRead = this.d.now().getTime();
      // A blip (GitHub did not answer) keeps the last good reading of the same login.
      if (!gh.ok && this.last?.ok && !changed && /did not answer/.test(gh.error ?? '')) return;
      this.last = gh;
      const key = JSON.stringify({ ...gh, checkedAt: undefined });
      if (key !== this.lastSent) this.d.log(`gh login: ${ghLoginLabel(gh)}${changed ? ' (gh\'s hosts file changed)' : ''}`);
      this.lastSent = key;
      this.d.send(gh);
    } finally {
      this.reading = false;
    }
  }
}

/** The hosts file's size and mtime, or '' when it is missing. */
export function lookHostsFile(file = ghHostsFile()): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}
