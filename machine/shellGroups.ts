/**
 * w5401: which worker session a macOS process belongs to when its environment cannot be read.
 *
 * ff-leftovers and the daemon's sweep tie a process to its session by FF_SESSION_ID in its environment. macOS hides the
 * environment of Apple's own programs (/bin/zsh, /bin/bash, /bin/sleep, tail, caffeinate): `ps -E` and KERN_PROCARGS2 show
 * none, unfenced and as the same user (m5, 2026-11-24: `nohup sleep 600 &` from a worker, pid 40085, reparented to pid 1,
 * was never listed nor ended). So each of a worker's shells writes down who it is when it starts.
 *
 * Claude Code starts every Bash tool shell as `zsh -c` in a session and process group of its own (pid = pgid = sid,
 * measured: shell 51099, its `nohup sleep 120 &` pid 51100 with pgid 51099 after the shell exited), and zsh reads
 * `$ZDOTDIR/.zshenv` first, for `zsh -c` too (measured end to end with `claude -p` 2.1.330). The daemon gives its macOS
 * sandbox agents ZDOTDIR=<slots>/zsh, whose .zshenv appends a start line (its pid, the time, its FF_* variables) to
 * `<slots>/shell-groups/<session>.tsv` and an end line on exit, then hands zsh back to the person's own startup files.
 * A process whose environment carries no session and whose process group is such a shell's is that session's, when:
 *   - the group's leader still runs and started when the line says (a pid reused since started later), or
 *   - the leader is gone and the process started while that shell ran (its start line to its end line, or MAX_LIFE_MS
 *     when it left none: a shell killed by a signal writes no end line). A pid can be reused only once its group is gone,
 *     and a group a reused pid leads starts after the shell's end, so its members never fall in the window;
 *   - or its parent is such a process of the same group (a loop the orphan runs starts its next `sleep` later).
 * A process that shows any session in its environment keeps it, and one a worker started for a person (FF_FOR_PERSON,
 * `ff-leftovers launch`) is never matched: it runs detached, in a group of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Proc } from './unity.ts';
import type { ProcEnv } from './leftovers.ts';

/** Longest a shell with no end line is taken to have run: a background task's limit is 2 h. */
export const MAX_LIFE_MS = 3 * 60 * 60_000;
/** `ps` start times are whole seconds (lstart, etime): the slack on each side of a window. */
export const SLACK_MS = 3_000;
/** Files of sessions not written for this long are removed by the daemon. */
export const KEEP_MS = 7 * 24 * 60 * 60_000;

export interface ShellGroup {
  /** The shell's pid, which is its process group's id. */
  leader: number;
  /** When it started and ended (ms since the epoch); no end when it left no line. */
  start: number;
  end?: number;
  env: ProcEnv;
}

export const shellGroupsDir = (slots: string) => path.join(slots, 'shell-groups');
export const shellZdotdir = (slots: string) => path.join(slots, 'zsh');

const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

/** The .zshenv: two short appends and nothing printed; any failure is silent and the person's own files still load. */
export function zshenvText(groupsDir: string): string {
  const q = `'${groupsDir.replace(/'/g, `'\\''`)}'`;
  return [
    '# FF Factory (w5401, machine/shellGroups.ts): written by the machine daemon; a worker shell notes its session here,',
    '# then the person\'s own zsh startup files load as usual.',
    'if [[ -n ${FF_SESSION_ID-} && $FF_SESSION_ID =~ \'^[A-Za-z0-9_-]+$\' ]] && zmodload -F zsh/datetime p:EPOCHREALTIME 2>/dev/null; then',
    `  typeset -g _ff_groups_file=${q}/$FF_SESSION_ID.tsv`,
    '  typeset -ga _ff_f; _ff_f=(s "$$" "$EPOCHREALTIME" "$FF_SESSION_ID" "${FF_SANDBOX_ID-}" "${FF_MACHINE_ID-}" "${FF_WORKER_ROOT-}")',
    '  { print -r -- "${(pj:\\t:)_ff_f}" >> $_ff_groups_file } 2>/dev/null; unset _ff_f',
    '  _ff_group_end() { { print -r -- "e"$\'\\t\'"$$"$\'\\t\'"$EPOCHREALTIME" >> $_ff_groups_file } 2>/dev/null }',
    '  typeset -ga zshexit_functions',
    '  zshexit_functions+=(_ff_group_end)',
    'fi',
    'if [[ -n ${FF_ZDOTDIR_WAS-} ]]; then export ZDOTDIR=$FF_ZDOTDIR_WAS; else unset ZDOTDIR; fi',
    '[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && source ${ZDOTDIR:-$HOME}/.zshenv',
    '',
  ].join('\n');
}

/** For a program that reads $ZDOTDIR/.zshrc itself: the person's own file. */
const stubText = (name: string) => `# FF Factory (w5401): the person's own ${name}.\n[[ -r \${FF_ZDOTDIR_WAS:-$HOME}/${name} ]] && source \${FF_ZDOTDIR_WAS:-$HOME}/${name}\n`;

/** Writes <slots>/zsh and makes <slots>/shell-groups (the daemon, at start, on a Mac). */
export function installShellGroups(slots: string): void {
  const z = shellZdotdir(slots);
  const g = shellGroupsDir(slots);
  fs.mkdirSync(z, { recursive: true });
  fs.mkdirSync(g, { recursive: true });
  const files: [string, string][] = [['.zshenv', zshenvText(g)], ...['.zprofile', '.zshrc', '.zlogin', '.zlogout'].map((n): [string, string] => [n, stubText(n)])];
  for (const [name, text] of files) {
    const f = path.join(z, name);
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === text) continue;
    fs.writeFileSync(`${f}.tmp`, text);
    fs.renameSync(`${f}.tmp`, f);
  }
}

/** The agent's environment for it: ZDOTDIR, and the one it replaces (spec, then the daemon's own), if any. */
export function shellGroupEnv(slots: string, base: Record<string, string | undefined>): Record<string, string> {
  const was = base.ZDOTDIR;
  return { ZDOTDIR: shellZdotdir(slots), ...(was && was !== shellZdotdir(slots) ? { FF_ZDOTDIR_WAS: was } : {}) };
}

const ms = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
};

/** The shells of one file's lines: a start line, and the end line of the same pid after it. */
export function parseShellGroups(text: string): ShellGroup[] {
  const out: ShellGroup[] = [];
  const open = new Map<number, ShellGroup>();
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    const pid = Number(f[1]);
    const t = ms(f[2] ?? '');
    if (!Number.isInteger(pid) || pid <= 1 || t === undefined) continue;
    if (f[0] === 's' && SESSION.test(f[3] ?? '')) {
      const env: ProcEnv = { session: f[3] };
      if (f[4]) env.sandbox = f[4];
      if (f[5]) env.machine = f[5];
      if (f[6]) env.root = f[6];
      const g: ShellGroup = { leader: pid, start: t, env };
      out.push(g);
      open.set(pid, g);
    } else if (f[0] === 'e') {
      const g = open.get(pid);
      if (g && t >= g.start) g.end = t;
      open.delete(pid);
    }
  }
  return out;
}

/** The shells in the groups folder: one session's file, or every file (the daemon, which also drops old ones). */
export function readShellGroups(dir: string, o: { session?: string; now?: number; prune?: boolean } = {}): ShellGroup[] {
  let names: string[];
  try {
    names = o.session ? (SESSION.test(o.session) ? [`${o.session}.tsv`] : []) : fs.readdirSync(dir).filter((n) => n.endsWith('.tsv'));
  } catch {
    return [];
  }
  const now = o.now ?? Date.now();
  const out: ShellGroup[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      if (o.prune && now - fs.statSync(f).mtimeMs > KEEP_MS) {
        fs.rmSync(f, { force: true });
        continue;
      }
      out.push(...parseShellGroups(fs.readFileSync(f, 'utf8')).filter((g) => g.env.session === n.slice(0, -4)));
    } catch {
      // gone or unreadable: no shells from it
    }
  }
  return out;
}

const hasSession = (e: ProcEnv | undefined) => !!e?.session || !!e?.person || !!e?.run;

/** The processes the shells' records tie to a session: the pids to time first (members and their leaders). */
export function groupCandidates(procs: Proc[], env: Map<number, ProcEnv>, groups: ShellGroup[]): number[] {
  const leaders = new Set(groups.map((g) => g.leader));
  const out = new Set<number>();
  for (const p of procs) {
    if (p.pgid === undefined || !leaders.has(p.pgid) || hasSession(env.get(p.pid))) continue;
    out.add(p.pid);
    out.add(p.pgid);
  }
  return [...out];
}

/** The sessions the records give to processes whose environment shows none (see the file's comment). */
export function groupOwners(procs: Proc[], env: Map<number, ProcEnv>, born: (pid: number) => number | undefined, groups: ShellGroup[]): Map<number, ProcEnv> {
  const byLeader = new Map<number, ShellGroup[]>();
  for (const g of groups) byLeader.set(g.leader, [...(byLeader.get(g.leader) ?? []), g]);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Map<number, ProcEnv>();
  const free = (p: Proc) => p.pgid !== undefined && byLeader.has(p.pgid) && !hasSession(env.get(p.pid));
  for (const p of procs) {
    if (!free(p)) continue;
    const recs = byLeader.get(p.pgid!)!;
    const leader = byPid.get(p.pgid!);
    let hit: ShellGroup | undefined;
    if (leader) {
      const lb = born(leader.pid);
      if (lb !== undefined) hit = recs.find((g) => Math.abs(lb - g.start) <= SLACK_MS);
    } else {
      const b = born(p.pid);
      if (b !== undefined) hit = recs.find((g) => b >= g.start - SLACK_MS && b <= (g.end ?? g.start + MAX_LIFE_MS) + SLACK_MS);
    }
    if (hit) out.set(p.pid, hit.env);
  }
  // What a matched process started later, in its group: its next `sleep`.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (out.has(p.pid) || !free(p)) continue;
      const parent = byPid.get(p.ppid);
      const pe = parent && parent.pgid === p.pgid ? out.get(parent.pid) : undefined;
      if (pe) {
        out.set(p.pid, pe);
        grew = true;
      }
    }
  }
  return out;
}

/** The environments with the records' sessions filled in where none shows (a new map; the given one is not changed). */
export async function withShellGroups(procs: Proc[], env: Map<number, ProcEnv>, groups: ShellGroup[], inspect: (pids: number[]) => Promise<{ pid: number; startedAt?: number }[]>): Promise<Map<number, ProcEnv>> {
  if (!groups.length) return env;
  const cands = groupCandidates(procs, env, groups);
  if (!cands.length) return env;
  const facts = await inspect(cands).catch(() => []);
  const born = new Map(facts.filter((f) => f.startedAt !== undefined).map((f) => [f.pid, f.startedAt!]));
  const owners = groupOwners(procs, env, (pid) => born.get(pid), groups);
  if (!owners.size) return env;
  const merged = new Map(env);
  for (const [pid, e] of owners) merged.set(pid, { ...(env.get(pid) ?? {}), ...e });
  return merged;
}
