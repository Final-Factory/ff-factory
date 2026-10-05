// Unity slots (w469, Lothsahn on 2026-10-05: "Can we just account for every unity editor process that's running?" and
// "Can we make batch builds count towards unity editors?"; docs/unity-lifecycle.md, "Unity slots"). A machine's editor
// limit (max_unity) counts every top-level Unity process actually running there, whoever started it: sandbox editors,
// -batchmode builds and test runs, a second editor for a peer run, the owner's own editor, editors started by scripts.
// AssetImportWorkers, bcl.exe, the ILPP runner and built game players are not editors and do not count.
//
// Launches other than `unity start` take slots through a file mailbox in SLOTS_DIR, which the daemon arbitrates: a
// client (this file's CLI, `unity-slot`, or the game repo's scripts/unity_slot.py) writes req-<id>.json and touches it
// while it waits or holds; the daemon answers grant-<id>.json or deny-<id>.json. A request takes all its slots at once
// or none. Waiting requests from holders (a sandbox whose editor runs, a run that already holds slots) go first, then
// new requesters, oldest first. Process counting is the backstop: Unity started outside the gate counts all the same,
// so nothing more is granted while the machine is over its limit. Nothing here ever kills a Unity process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Proc, UnityPlatform } from './unity.ts';
import { unitySlotsLine } from '../shared/fleet.ts';
import type { UnitySlotsReport } from '../shared/types.ts';

/** Where the mailbox is: the same on every machine whatever the daemon's app_dir, so scripts find it with no config. */
export function slotsDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.FF_UNITY_SLOTS || path.join(home, '.ff-factory', 'unity-slots');
}

/**
 * RAM in use at which no new Unity launch is granted (the queue waits). The placement's busy line (server/placement.ts
 * RAM_BUSY_PCT, 85): one more editor takes 8-12 GB, a Burst build's bcl.exe 4-10 GB more (LothDesktop, 2026-10-05: 63 of
 * 64 GB with 3 builds), so above 85% of 64 GB the next launch would page.
 */
export const UNITY_RAM_PCT = 85;

/** A waiter or holder whose file was not touched for this long is gone (its heartbeat is every 15 s). */
export const STALE_MS = 90_000;

/** A request that holds slots while it waits for more is refused after this long, so its slots stop stalling everyone. */
export const HOLDER_WAIT_MS = 30 * 60_000;

/** The arbiter rewrites arbiter.json every few seconds; older than this, a client counts it as gone. */
export const ARBITER_FRESH_MS = 60_000;

// ---------------------------------------------------------------- which processes are Unity editors

export type UnityKind = 'interactive' | 'batch';

/** A top-level Unity editor process. */
export interface UnityProcess {
  pid: number;
  ppid: number;
  kind: UnityKind;
  /** Its -projectPath, as written. */
  project?: string;
}

/** The arguments of a Windows command line: quoted ("a b") or bare, with \" inside quotes. */
export function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && cmd[i + 1] === '"') {
      cur += '"';
      any = true;
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(c) && !quoted) {
      if (any) out.push(cur);
      cur = '';
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

const MAC_EDITOR = '/Unity.app/Contents/MacOS/Unity';

/**
 * Whether a process is the Unity editor binary itself (not a script that names it in its arguments): on Windows its
 * image name, else the program of its command line; on a Mac a command line that starts with the path of
 * Unity.app's binary (a path may hold spaces, so the part before it may not hold " /" or " -", which a program's
 * arguments would).
 */
export function isUnityBinary(p: Pick<Proc, 'cmd' | 'name'>, platform: UnityPlatform): boolean {
  if (platform === 'win32') {
    if (p.name) return /^unity\.exe$/i.test(p.name);
    return /^unity\.exe$/i.test(path.win32.basename(splitArgs(p.cmd)[0] ?? ''));
  }
  const at = p.cmd.indexOf(MAC_EDITOR);
  if (at < 0 || !p.cmd.startsWith('/')) return false;
  const after = p.cmd[at + MAC_EDITOR.length];
  if (after !== undefined && !/\s/.test(after)) return false;
  const before = p.cmd.slice(0, at);
  return !before.includes(' /') && !before.includes(' -');
}

/** The arguments after the program (a Mac's ps joins them with spaces, so they are split on whitespace there). */
function argsOf(cmd: string, platform: UnityPlatform): string[] {
  if (platform === 'win32') return splitArgs(cmd).slice(1);
  const at = cmd.indexOf(MAC_EDITOR);
  return cmd.slice(at + MAC_EDITOR.length).trim().split(/\s+/).filter(Boolean);
}

/** The value after a flag (case-insensitive); on a Mac a -projectPath with spaces runs to the next flag. */
function flagValue(args: string[], flag: string, platform: UnityPlatform): string | undefined {
  const i = args.findIndex((a) => a.toLowerCase() === flag.toLowerCase());
  if (i < 0 || i + 1 >= args.length) return undefined;
  if (platform === 'win32') return args[i + 1];
  const parts: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) parts.push(args[j]);
  return parts.join(' ') || undefined;
}

/**
 * The top-level Unity editors among `procs`: the Unity binary, not an AssetImportWorker (`-name AssetImportWorkerN`,
 * started by an editor with -parentPid) and not any other Unity started by a Unity. Batch: started with -batchmode
 * (builds, test runs, command-line tools); interactive otherwise.
 */
export function unityProcesses(procs: Proc[], platform: UnityPlatform): UnityProcess[] {
  const unity = procs.filter((p) => isUnityBinary(p, platform));
  const unityPids = new Set(unity.map((p) => p.pid));
  const out: UnityProcess[] = [];
  for (const p of unity) {
    const args = argsOf(p.cmd, platform);
    const lower = args.map((a) => a.toLowerCase());
    const name = flagValue(args, '-name', platform) ?? '';
    if (/^assetimportworker/i.test(name) || lower.includes('-parentpid') || unityPids.has(p.ppid)) continue;
    out.push({ pid: p.pid, ppid: p.ppid, kind: lower.includes('-batchmode') ? 'batch' : 'interactive', project: flagValue(args, '-projectPath', platform) });
  }
  return out;
}

/** Built game players (FinalFactory.exe, FinalFactory.app): not editors, reported beside them. */
export function gamePlayers(procs: Proc[], platform: UnityPlatform): Proc[] {
  if (platform === 'win32') return procs.filter((p) => /^final ?factory.*\.exe$/i.test(p.name ?? path.win32.basename(splitArgs(p.cmd)[0] ?? '')));
  return procs.filter((p) => /\/final ?factory[^/]*\.app\/Contents\/MacOS\//i.test(p.cmd) && p.cmd.startsWith('/'));
}

const pathKey = (p: string, platform: UnityPlatform) => (platform === 'win32' ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : p.replace(/\/+$/, ''));

// ---------------------------------------------------------------- the decision

/** A request for slots, as its file says and the arbiter found it. */
export interface SlotRequest {
  id: string;
  /** Who asks: "sandbox:<id>", "main", or "pid:<pid>". A holder's requests share its priority. */
  holder: string;
  count: number;
  /** The process that waits and holds (its Unity processes are found under it). */
  pid: number;
  label: string;
  /** Project folders its Unity processes open, for ones started where they are not its children (a detached launch). */
  projects?: string[];
  createdAt: number;
  /** When it was granted; undefined while it waits. */
  grantedAt?: number;
  /** Refused or revoked: it reserves nothing (its Unity processes still count). */
  denied?: string;
}

/** A place the daemon knows: a sandbox ("sandbox:<id>") or the main clone ("main"), and whether its editor is up. */
export interface Place {
  holder: string;
  path: string;
  /** Its editor is starting or running: a slot even before the process shows. */
  editorUp?: boolean;
  /**
   * Its editor was stopped a moment ago (a worker stopping it to build its own project in batch mode): its requests keep
   * a holder's priority for a while, though it holds no slot now.
   */
  priority?: boolean;
}

export interface AssessInput {
  platform: UnityPlatform;
  procs: Proc[];
  requests: SlotRequest[];
  places: Place[];
  /** max_unity; undefined: no limit here (counted only). */
  limit?: number;
  now: number;
  ramPct?: number;
  ramLimitPct?: number;
  holderWaitMs?: number;
}

export interface Assessment {
  limit?: number;
  /** Slots in use: each place, holder and outside process counted once (a reservation or its processes, the larger). */
  used: number;
  free: number;
  unity: UnityProcess[];
  interactive: number;
  batch: number;
  /** Unity processes no sandbox, main clone or slot holder accounts for: started outside the gate. */
  outside: UnityProcess[];
  players: number;
  overLimit: boolean;
  ramBlocked: boolean;
  /** Slots each holder uses now. */
  holders: Map<string, number>;
  grant: string[];
  deny: { id: string; why: string }[];
  waiting: { id: string; position: number; why: string }[];
}

/** The nearest ancestor of `pid` (itself excluded) that is in `wanted`, through the parent chain. */
function ancestorIn(ppid: number, byPid: Map<number, Proc>, wanted: Set<number>): number | undefined {
  const seen = new Set<number>();
  for (let p = ppid, i = 0; p > 0 && i < 64 && !seen.has(p); i++) {
    if (wanted.has(p)) return p;
    seen.add(p);
    p = byPid.get(p)?.ppid ?? 0;
  }
  return undefined;
}

/**
 * Count every Unity editor and decide which waiting requests get their slots now. Pure: the arbiter writes the files.
 *
 * Counting: each top-level Unity process belongs to the request whose process started it (its nearest requesting
 * ancestor, or a project the request named), else to the sandbox or main clone whose project it has open, else to
 * nobody (outside, 1 each). A request's process counts its granted slots or its Unity processes, whichever is larger;
 * a sandbox its running editor or its processes; so Unity started outside the gate always counts.
 *
 * Deciding: a request takes all its slots at once or none. Requests from holders (a holder using any slot now) go
 * first, then new requesters; oldest first in each. The first that does not fit stops the queue (no one passes it, so a
 * peer run needing 2 is not starved by single builds). Refused at once: more than the limit; a holder asking for more
 * than the limit leaves it; a holder that waited holderWaitMs while holding. When every slot in use is held by a
 * waiting holder, nothing will ever free one: a later request that fits goes first, and if none fits, the newest
 * waiting holder is refused so the others can finish (no two runs each hold part of what they need and wait forever).
 */
export function assess(input: AssessInput): Assessment {
  const { platform, limit, now } = input;
  const unity = unityProcesses(input.procs, platform);
  const byPid = new Map(input.procs.map((p) => [p.pid, p]));
  const reqs = input.requests;
  const buckets = new Map<string, { holder: string; reserved: number; procs: number }>();
  const bucket = (key: string, holder: string) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { holder, reserved: 0, procs: 0 }));
    return b;
  };
  for (const r of reqs) {
    const b = bucket(`p:${r.pid}`, r.holder);
    if (r.grantedAt !== undefined && !r.denied) b.reserved += r.count;
  }
  for (const pl of input.places) {
    const b = bucket(`e:${pathKey(pl.path, platform)}`, pl.holder);
    if (pl.editorUp) b.reserved = Math.max(b.reserved, 1);
  }
  const reqPids = new Set(reqs.map((r) => r.pid));
  const outside: UnityProcess[] = [];
  for (const u of unity) {
    const anc = reqPids.has(u.pid) ? u.pid : ancestorIn(u.ppid, byPid, reqPids);
    const key = u.project ? pathKey(u.project, platform) : undefined;
    const named = anc === undefined && key ? reqs.find((r) => r.projects?.some((p) => pathKey(p, platform) === key)) : undefined;
    if (anc !== undefined || named) {
      buckets.get(`p:${anc ?? named!.pid}`)!.procs++;
      continue;
    }
    const pl = key ? buckets.get(`e:${key}`) : undefined;
    if (pl) pl.procs++;
    else outside.push(u);
  }
  const holders = new Map<string, number>();
  const usedOf = new Map<string, number>();
  let used = outside.length;
  for (const [key, b] of buckets) {
    const n = Math.max(b.reserved, b.procs);
    used += n;
    usedOf.set(key, n);
    if (n) holders.set(b.holder, (holders.get(b.holder) ?? 0) + n);
  }
  // What a waiter keeps while it waits: what its own process holds, and its place's editor (its worker waits in a tool
  // call meanwhile). Another run of the same holder is not kept: it ends by itself.
  const placeKeys = input.places.map((pl) => ({ holder: pl.holder, key: `e:${pathKey(pl.path, platform)}` }));
  const keptKeys = (r: SlotRequest) => [`p:${r.pid}`, ...placeKeys.filter((x) => x.holder === r.holder).map((x) => x.key)].filter((k) => (usedOf.get(k) ?? 0) > 0);
  const kept = (r: SlotRequest) => keptKeys(r).reduce((n, k) => n + (usedOf.get(k) ?? 0), 0);
  let free = limit === undefined ? Infinity : limit - used;
  // Only where there is a limit: a machine without max_unity (a main-clone Mac, whose unified memory often runs high) is counted, never held up.
  const ramBlocked = limit !== undefined && input.ramPct !== undefined && input.ramPct >= (input.ramLimitPct ?? UNITY_RAM_PCT);
  const grant: string[] = [];
  const deny: { id: string; why: string }[] = [];
  const holding = (h: string) => holders.get(h) ?? 0;
  let waiting = reqs.filter((r) => r.grantedAt === undefined && !r.denied);
  // Refused at once: what can never fit, and a holder that held its slots while waiting too long.
  waiting = waiting.filter((r) => {
    const h = kept(r);
    let why: string | undefined;
    if (!Number.isInteger(r.count) || r.count < 1) why = `asks for ${r.count} slots; ask for 1 or more`;
    else if (limit !== undefined && r.count > limit) why = `needs ${r.count} Unity editors at once; this machine allows ${limit} (max_unity)`;
    else if (limit !== undefined && h > 0 && h + r.count > limit) why = `it holds ${h} (its own process${placeKeys.some((x) => x.holder === r.holder) ? ` or the editor of ${r.holder}` : ''}) and asks for ${r.count} more, more than the ${limit} this machine allows at once: release yours (stop the editor, end the other run) and ask for all ${h + r.count} at once`;
    else if (h > 0 && now - r.createdAt > (input.holderWaitMs ?? HOLDER_WAIT_MS)) why = `waited ${Math.round((now - r.createdAt) / 60_000)} min while holding ${h} slot(s); refused so the slots it holds stop stalling everyone: release them and ask again for all you need at once`;
    if (why) deny.push({ id: r.id, why });
    return !why;
  });
  const priority = new Set(input.places.filter((pl) => pl.priority).map((pl) => pl.holder));
  const first = (r: SlotRequest) => Number(holding(r.holder) > 0 || priority.has(r.holder));
  const order = (a: SlotRequest, b: SlotRequest) => first(b) - first(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  waiting.sort(order);
  const take = (r: SlotRequest) => {
    grant.push(r.id);
    free -= r.count;
    holders.set(r.holder, holding(r.holder) + r.count);
  };
  let rest: SlotRequest[] = [];
  for (const r of waiting) {
    if (!rest.length && !ramBlocked && r.count <= free) take(r);
    else rest.push(r);
  }
  // Every slot in use kept by a waiter: nothing frees one by itself.
  if (rest.length && limit !== undefined) {
    const blocked = new Set(rest.flatMap(keptKeys));
    const heldByWaiters = [...blocked].reduce((n, k) => n + (usedOf.get(k) ?? 0), 0);
    if (heldByWaiters > 0 && heldByWaiters >= limit - free) {
      const fits = rest.find((r) => r.count <= free);
      if (fits && !ramBlocked) {
        take(fits);
        rest = rest.filter((r) => r !== fits);
      } else if (!fits) {
        const newest = [...rest].filter((r) => kept(r) > 0).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
        if (newest) {
          const others = rest.filter((r) => r !== newest && kept(r) > 0).map((r) => `"${r.label}" (holds ${kept(r)}, wants ${r.count})`);
          deny.push({ id: newest.id, why: `would wait forever: every Unity slot here is held by runs that are themselves waiting for more (${others.join(', ') || 'none other'}; this one holds ${kept(newest)} and wants ${newest.count}). Refused the newest: release what you hold and ask again for all ${kept(newest) + newest.count} at once` });
          rest = rest.filter((r) => r !== newest);
        }
      }
    }
  }
  const head = rest[0];
  const waitingOut = rest.map((r, i) => ({
    id: r.id,
    position: i + 1,
    why:
      r === head
        ? ramBlocked && r.count <= free
          ? `RAM ${input.ramPct}% used; new Unity launches wait below ${input.ramLimitPct ?? UNITY_RAM_PCT}%`
          : `needs ${r.count}, ${Math.max(0, free)} free (${limit === undefined ? used : `${limit - Math.max(0, free) - (free < 0 ? free : 0)} of ${limit}`} in use)`
        : `behind ${i} earlier request${i === 1 ? '' : 's'}`,
  }));
  // In use once this look's grants start: what the line and the next look say.
  const granted = grant.reduce((n, id) => n + (reqs.find((r) => r.id === id)?.count ?? 0), 0);
  return {
    limit,
    used: used + granted,
    free: limit === undefined ? Infinity : limit - used - granted,
    unity,
    interactive: unity.filter((u) => u.kind === 'interactive').length,
    batch: unity.filter((u) => u.kind === 'batch').length,
    outside,
    players: gamePlayers(input.procs, platform).length,
    overLimit: limit !== undefined && used > limit,
    ramBlocked,
    holders,
    grant,
    deny,
    waiting: waitingOut,
  };
}

/** "editors 4 of 3: 1 interactive, 3 batch" (the processes; slots granted but not started yet are said apart). */
export function countsLine(a: Pick<Assessment, 'limit' | 'used' | 'interactive' | 'batch'>): string {
  const procs = a.interactive + a.batch;
  const reserved = a.used - procs;
  return `editors ${a.used} of ${a.limit ?? 'no limit'}: ${a.interactive} interactive, ${a.batch} batch${reserved > 0 ? `, ${reserved} granted not started yet` : ''}`;
}

// ---------------------------------------------------------------- the mailbox

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const reqFile = (dir: string, id: string) => path.join(dir, `req-${id}.json`);
export const grantFile = (dir: string, id: string) => path.join(dir, `grant-${id}.json`);
export const denyFile = (dir: string, id: string) => path.join(dir, `deny-${id}.json`);
export const arbiterFile = (dir: string) => path.join(dir, 'arbiter.json');

/** What a client writes. */
export interface RequestFile {
  v: 1;
  id: string;
  pid: number;
  holder: string;
  count: number;
  label: string;
  projects?: string[];
  createdAt: string;
}

/** What the arbiter writes for clients and people: the counts, the queue, the grants. */
export interface ArbiterFile {
  v: 1;
  pid: number;
  machine?: string;
  at: string;
  limit?: number;
  used: number;
  line: string;
  waiting: { id: string; label: string; count: number; holder: string; position: number; why: string }[];
  granted: { id: string; label: string; count: number; holder: string }[];
}

/** Write a file whole: a reader never sees half of it. */
function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

const rm = (file: string) => fs.rmSync(file, { force: true });

// ---------------------------------------------------------------- the arbiter (the daemon, or `unity-slot serve`)

export interface ArbiterDeps {
  dir: string;
  platform: UnityPlatform;
  procs(): Promise<Proc[]>;
  /** Whether a process is alive. */
  alive(pid: number): boolean;
  now(): number;
  limit(): number | undefined;
  places(): Place[];
  ramPct(): number | undefined;
  ramLimitPct?: number;
  holderWaitMs?: number;
  staleMs?: number;
  machine?: string;
  /** Something the orchestrator should hear of: over the limit and back, a refusal, a crashed holder's slots freed. */
  onEvent?(text: string): void;
  log?(line: string): void;
}

export class UnitySlots {
  private readonly d: ArbiterDeps;
  private last?: { a: Assessment; reqs: SlotRequest[]; ramPct?: number; at: number };
  private overSince = 0;
  private ramSince = 0;
  private busy?: Promise<Assessment>;

  constructor(d: ArbiterDeps) {
    this.d = d;
  }

  get dir() {
    return this.d.dir;
  }

  /** The requests in the mailbox; gone holders (dead process, no heartbeat) are removed with their files. */
  private readRequests(): SlotRequest[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.d.dir);
    } catch {
      return [];
    }
    const now = this.d.now();
    const stale = this.d.staleMs ?? STALE_MS;
    const out: SlotRequest[] = [];
    const live = new Set<string>();
    for (const n of names) {
      const m = /^req-(.+)\.json$/.exec(n);
      if (!m || !ID.test(m[1])) continue;
      const id = m[1];
      const file = path.join(this.d.dir, n);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const f = readJson<RequestFile>(file);
      if (!f || f.id !== id || !Number.isInteger(f.pid) || f.pid <= 0) {
        // Half-written by a client that crashed: gone once it is old.
        if (now - mtime > stale) rm(file);
        continue;
      }
      const grant = readJson<{ grantedAt: string }>(grantFile(this.d.dir, id));
      const deny = readJson<{ why: string }>(denyFile(this.d.dir, id));
      const label = String(f.label || `pid ${f.pid}`).slice(0, 120);
      const gone = !this.d.alive(f.pid) ? `its process ${f.pid} is gone` : now - mtime > stale ? `no heartbeat for ${Math.round((now - mtime) / 1000)} s` : undefined;
      if (gone) {
        for (const x of [file, grantFile(this.d.dir, id), denyFile(this.d.dir, id)]) rm(x);
        if (grant && !deny) {
          const text = `freed ${f.count} Unity slot(s) of "${label}" (${f.holder}): ${gone}`;
          this.d.log?.(`unity slots: ${text}`);
          this.d.onEvent?.(text);
        }
        continue;
      }
      live.add(id);
      out.push({
        id,
        holder: String(f.holder || `pid:${f.pid}`).slice(0, 80),
        count: Number(f.count),
        pid: f.pid,
        label,
        projects: Array.isArray(f.projects) ? f.projects.filter((p): p is string => typeof p === 'string').slice(0, 8) : undefined,
        createdAt: Date.parse(f.createdAt) || mtime,
        grantedAt: grant ? Date.parse(grant.grantedAt) || mtime : undefined,
        denied: deny?.why,
      });
    }
    // Answers whose request is gone (released): removed.
    for (const n of names) {
      const m = /^(grant|deny)-(.+)\.json$/.exec(n);
      if (m && !live.has(m[2])) rm(path.join(this.d.dir, n));
    }
    return out;
  }

  /** One look: free gone holders, count, grant or refuse, and write arbiter.json. Overlapping calls share one look. */
  tick(): Promise<Assessment> {
    this.busy ??= this.look().finally(() => (this.busy = undefined));
    return this.busy;
  }

  private async look(): Promise<Assessment> {
    fs.mkdirSync(this.d.dir, { recursive: true });
    const reqs = this.readRequests();
    const procs = await this.d.procs();
    const now = this.d.now();
    const ramPct = this.d.ramPct();
    const a = assess({ platform: this.d.platform, procs, requests: reqs, places: this.d.places(), limit: this.d.limit(), now, ramPct, ramLimitPct: this.d.ramLimitPct, holderWaitMs: this.d.holderWaitMs });
    const byId = new Map(reqs.map((r) => [r.id, r]));
    for (const id of a.grant) {
      writeAtomic(grantFile(this.d.dir, id), JSON.stringify({ id, grantedAt: new Date(now).toISOString() }));
      const r = byId.get(id)!;
      r.grantedAt = now;
      this.d.log?.(`unity slots: granted ${r.count} to "${r.label}" (${r.holder})`);
    }
    for (const x of a.deny) {
      writeAtomic(denyFile(this.d.dir, x.id), JSON.stringify({ id: x.id, why: x.why, at: new Date(now).toISOString() }));
      const r = byId.get(x.id)!;
      r.denied = x.why;
      const text = `refused "${r.label}" (${r.holder}, ${r.count} slot(s)): ${x.why}`;
      this.d.log?.(`unity slots: ${text}`);
      this.d.onEvent?.(text);
    }
    this.last = { a, reqs, ramPct, at: now };
    this.notices(a, now);
    writeAtomic(arbiterFile(this.d.dir), JSON.stringify(this.arbiterFile(), null, 1));
    return a;
  }

  /** Tell the orchestrator once when the machine goes over its limit, and when it is back; and of a long wait on RAM. */
  private notices(a: Assessment, now: number) {
    const line = countsLine(a);
    if (a.overLimit && !this.overSince) {
      this.overSince = now;
      const what = a.outside.map((u) => `${u.kind} ${u.project ? path.basename(u.project.replace(/[\\/]+$/, '')) : `pid ${u.pid}`}`);
      this.d.onEvent?.(`Unity ${line} on this machine: over its limit. Nothing more is granted (unity start and queued launches wait) until it drops; nothing is stopped.${what.length ? ` Started outside the slot gate: ${what.join(', ')}.` : ''}`);
    } else if (!a.overLimit && this.overSince) {
      this.overSince = 0;
      this.d.onEvent?.(`Unity back within its limit on this machine: ${line}.`);
    }
    if (a.ramBlocked && a.waiting.length) {
      if (!this.ramSince) this.ramSince = now;
      else if (this.ramSince > 0 && now - this.ramSince > 10 * 60_000) {
        this.ramSince = -1; // told once per episode
        this.d.onEvent?.(`${a.waiting.length} Unity launch(es) have waited 10 min on RAM (${this.last?.ramPct}% used; they start below ${this.d.ramLimitPct ?? UNITY_RAM_PCT}%). ${line}.`);
      }
    } else this.ramSince = 0;
  }

  private arbiterFile(): ArbiterFile {
    const l = this.last!;
    const byId = new Map(l.reqs.map((r) => [r.id, r]));
    return {
      v: 1,
      pid: process.pid,
      machine: this.d.machine,
      at: new Date(l.at).toISOString(),
      limit: l.a.limit,
      used: l.a.used,
      line: this.line() ?? '',
      waiting: l.a.waiting.map((w) => {
        const r = byId.get(w.id)!;
        return { id: w.id, label: r.label, count: r.count, holder: r.holder, position: w.position, why: w.why };
      }),
      granted: l.reqs.filter((r) => r.grantedAt !== undefined && !r.denied).map((r) => ({ id: r.id, label: r.label, count: r.count, holder: r.holder })),
    };
  }

  /**
   * Whether an editor for `holder` (a sandbox's `unity start`) may start now, by the same rule as a queued request: as a
   * new request of one slot, behind everyone waiting before it. Undefined: yes; else why not. Fresh process list.
   */
  async startRefusal(holder: string): Promise<string | undefined> {
    const a0 = await this.tick();
    if (this.d.limit() === undefined) return undefined;
    const reqs = this.last?.reqs ?? [];
    const probe: SlotRequest = { id: '~editor', holder, count: 1, pid: -1, label: `editor of ${holder}`, createdAt: this.d.now() + 1 };
    const a = assess({ platform: this.d.platform, procs: await this.d.procs(), requests: [...reqs, probe], places: this.d.places(), limit: this.d.limit(), now: this.d.now(), ramPct: this.d.ramPct(), ramLimitPct: this.d.ramLimitPct, holderWaitMs: this.d.holderWaitMs });
    if (a.grant.includes(probe.id)) return undefined;
    const why = a.deny.find((x) => x.id === probe.id)?.why ?? a.waiting.find((x) => x.id === probe.id)?.why ?? 'no free slot';
    const ahead = a.waiting.filter((x) => x.id !== probe.id).length;
    return `not started: ${why}; ${countsLine(a0)}${ahead ? `; ${ahead} launch(es) wait ahead of it` : ''}${this.holdersPart()}. Try again once one ends (wake_me), or stop an editor you no longer need`;
  }

  private holdersPart(): string {
    const g = this.report()?.granted ?? [];
    return g.length ? `; held by ${g.map((x) => `"${x.label}" (${x.count})`).join(', ')}` : '';
  }

  /** The counts as one line (shared/fleet.ts unitySlotsLine), or undefined before the first look. */
  line(): string | undefined {
    const r = this.report();
    return r && unitySlotsLine(r);
  }

  /** For the portal (list_sandboxes, system_status, the dashboard), from the last look. */
  report(): UnitySlotsReport | undefined {
    const l = this.last;
    if (!l) return undefined;
    const iso = (t: number) => new Date(t).toISOString();
    const byId = new Map(l.reqs.map((r) => [r.id, r]));
    return {
      limit: l.a.limit,
      used: l.a.used,
      interactive: l.a.interactive,
      batch: l.a.batch,
      outside: l.a.outside.length,
      players: l.a.players,
      overLimit: l.a.overLimit,
      ramPct: l.ramPct,
      ramLimitPct: this.d.ramLimitPct ?? UNITY_RAM_PCT,
      waiting: l.a.waiting.map((w) => {
        const r = byId.get(w.id)!;
        return { label: r.label, count: r.count, holder: r.holder, since: iso(r.createdAt), why: w.why };
      }),
      granted: l.reqs.filter((r) => r.grantedAt !== undefined && !r.denied).map((r) => ({ label: r.label, count: r.count, holder: r.holder, since: iso(r.grantedAt!) })),
      at: iso(l.at),
    };
  }

  /** Lines for `unity status`: the counts, then who holds and who waits. */
  describe(): string {
    const r = this.report();
    if (!r) return '';
    const lines = [`Unity on this machine: ${this.line()}`];
    for (const g of r.granted) lines.push(`  holds ${g.count}: "${g.label}" (${g.holder}) since ${g.since.slice(11, 16)} UTC`);
    for (const w of r.waiting) lines.push(`  waits for ${w.count}: "${w.label}" (${w.holder}) since ${w.since.slice(11, 16)} UTC: ${w.why}`);
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------- the client (`unity-slot`, and tests)

export interface ClientDeps {
  dir: string;
  pid: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Progress lines (stderr). */
  say(line: string): void;
}

export const realClientDeps = (dir = slotsDir()): ClientDeps => ({
  dir,
  pid: process.pid,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  say: (line) => process.stderr.write(`unity-slot: ${line}\n`),
});

/** The arbiter's file when it is fresh, else undefined (no FF Factory daemon here, or it is down). */
export function arbiterNow(dir: string, now: number): ArbiterFile | undefined {
  const f = readJson<ArbiterFile>(arbiterFile(dir));
  return f && now - Date.parse(f.at) <= ARBITER_FRESH_MS ? f : undefined;
}

export interface Held {
  id?: string;
  count: number;
  /** Ungated: no arbiter here (a machine without FF Factory's daemon), or it stayed away. */
  ungated?: string;
  /** Touches the request while held; stop() releases. */
  stop(): void;
}

export class SlotRefused extends Error {}

/**
 * Ask for `count` slots and wait until they are granted. Without a fresh arbiter at the start the launch goes ungated at
 * once (said on stderr); one that goes away while waiting is waited for `arbiterGraceMs` (10 min), then ungated too.
 * Rejects with SlotRefused when refused, or on `timeoutMs`.
 */
export async function acquire(
  d: ClientDeps,
  opts: { count: number; label: string; holder?: string; projects?: string[]; timeoutMs?: number; arbiterGraceMs?: number; heartbeatMs?: number; pollMs?: number },
): Promise<Held> {
  const none = (why: string): Held => ({ count: opts.count, ungated: why, stop: () => undefined });
  if (!arbiterNow(d.dir, d.now())) {
    const why = `no slot arbiter on this machine (FF Factory's daemon keeps ${arbiterFile(d.dir)} fresh); running without a slot`;
    d.say(why);
    return none(why);
  }
  const id = `${d.now().toString(36)}-${d.pid}-${randomBytes(3).toString('hex')}`;
  const file = reqFile(d.dir, id);
  const body: RequestFile = { v: 1, id, pid: d.pid, holder: opts.holder || `pid:${d.pid}`, count: opts.count, label: opts.label.slice(0, 120), ...(opts.projects?.length ? { projects: opts.projects } : {}), createdAt: new Date(d.now()).toISOString() };
  writeAtomic(file, JSON.stringify(body));
  const touch = () => {
    try {
      const t = new Date(d.now());
      fs.utimesSync(file, t, t);
    } catch {
      // released
    }
  };
  const beat = setInterval(touch, opts.heartbeatMs ?? 15_000);
  beat.unref?.(); // the wait loop, the command a run holds for, or the hold loop keeps the process up
  const release = () => {
    clearInterval(beat);
    for (const f of [file, grantFile(d.dir, id), denyFile(d.dir, id)]) rm(f);
  };
  const started = d.now();
  let lastSaid = '';
  let goneSince = 0;
  try {
    for (;;) {
      const deny = readJson<{ why: string }>(denyFile(d.dir, id));
      if (deny) throw new SlotRefused(`refused: ${deny.why}`);
      if (fs.existsSync(grantFile(d.dir, id))) {
        d.say(`granted ${opts.count} Unity slot(s) to "${opts.label}" (${id})`);
        return { id, count: opts.count, stop: release };
      }
      const now = d.now();
      const arb = arbiterNow(d.dir, now);
      if (!arb) {
        goneSince ||= now;
        if (now - goneSince > (opts.arbiterGraceMs ?? 10 * 60_000)) {
          const why = `the slot arbiter has been away for ${Math.round((now - goneSince) / 60_000)} min; running without a slot`;
          d.say(why);
          release();
          return none(why);
        }
      } else {
        goneSince = 0;
        const w = arb.waiting.find((x) => x.id === id);
        const said = w ? `waiting for ${opts.count} Unity slot(s): position ${w.position} of ${arb.waiting.length}, ${w.why}; ${arb.line}` : '';
        if (said && said !== lastSaid) d.say((lastSaid = said));
      }
      if (opts.timeoutMs !== undefined && now - started > opts.timeoutMs) throw new SlotRefused(`gave up after waiting ${Math.round((now - started) / 60_000)} min for ${opts.count} Unity slot(s)`);
      await d.sleep(opts.pollMs ?? 1000);
    }
  } catch (e) {
    release();
    throw e;
  }
}

// ---------------------------------------------------------------- the CLI

const USAGE = `unity-slot: take Unity slots on this machine before launching Unity (docs/unity-lifecycle.md, "Unity slots")

  unity-slot run [--count N] [--label TEXT] [--project PATH]... [--timeout MIN] -- <command> [args...]
      wait for N slots (default 1), run the command, release when it ends (its exit code is returned)
  unity-slot acquire [--count N] [--label TEXT] [--project PATH]... [--ttl MIN] [--timeout MIN]
      wait for N slots and hold them in the background (prints the slot id) until release or the ttl (default 120)
  unity-slot release <id>
  unity-slot status
  unity-slot serve --limit N [--dir DIR] [--for MIN]
      an arbiter for a machine whose daemon has none (tests); ends after MIN minutes when given

  A peer run that needs N editors asks for N at once. Inside "run" the command's own launches pass straight through
  (FF_UNITY_SLOT_HELD). FF_UNITY_HOLDER names the holder (the daemon sets "sandbox:<id>" for its agents).`;

interface CliOpts {
  count: number;
  label?: string;
  projects: string[];
  timeoutMs?: number;
  ttlMs: number;
  limit?: number;
  dir?: string;
  forMs?: number;
  rest: string[];
}

export function parseCli(argv: string[]): { cmd: string; o: CliOpts } {
  const [cmd = 'help', ...args] = argv;
  const o: CliOpts = { count: 1, projects: [], ttlMs: 120 * 60_000, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const num = (v: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${a} takes a number, not "${v}"`);
      return n;
    };
    if (a === '--') {
      o.rest = args.slice(i + 1);
      break;
    } else if (a === '--count' || a === '-n') o.count = num(val());
    else if (a === '--label') o.label = val();
    else if (a === '--project') o.projects.push(path.resolve(val()));
    else if (a === '--timeout') o.timeoutMs = num(val()) * 60_000;
    else if (a === '--ttl') o.ttlMs = num(val()) * 60_000;
    else if (a === '--limit') o.limit = num(val());
    else if (a === '--dir') o.dir = val();
    else if (a === '--for') o.forMs = num(val()) * 60_000;
    else o.rest.push(a);
  }
  return { cmd, o };
}

/** The label a run gets when none is given: the command, short. */
const labelOf = (o: CliOpts) => o.label ?? (o.rest.map((a) => path.basename(a)).join(' ').slice(0, 80) || 'unity-slot');

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { cmd, o } = parseCli(argv);
  const dir = o.dir ?? slotsDir(env);
  const d = realClientDeps(dir);
  const holder = env.FF_UNITY_HOLDER || undefined;
  const held = Number(env.FF_UNITY_SLOT_HELD) || 0;
  if (cmd === 'run') {
    if (!o.rest.length) throw new Error('run needs a command after --');
    let h: Held | undefined;
    if (held >= o.count) d.say(`inside a run that holds ${held} slot(s): no new slot`);
    else h = await acquire(d, { count: o.count, label: labelOf(o), holder, projects: o.projects, timeoutMs: o.timeoutMs });
    const child = spawn(o.rest[0], o.rest.slice(1), {
      stdio: 'inherit',
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(o.rest[0]),
      env: { ...env, FF_UNITY_SLOT_HELD: String(Math.max(held, o.count)), ...(h?.id ? { FF_UNITY_SLOT_ID: h.id } : {}) },
    });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));
    return new Promise<number>((resolve) => {
      child.on('error', (e) => {
        d.say(`could not start ${o.rest[0]}: ${e.message}`);
        h?.stop();
        resolve(127);
      });
      child.on('exit', (code, sig) => {
        h?.stop();
        resolve(code ?? (sig ? 128 : 1));
      });
    });
  }
  if (cmd === 'acquire') {
    // The holder is a detached process of its own (it outlives this call and the agent's shell); it writes the request.
    const id = `${Date.now().toString(36)}-h-${randomBytes(3).toString('hex')}`;
    const args = [...process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), import.meta.filename, '__hold', id, String(o.count), labelOf(o), String(o.ttlMs), ...o.projects.flatMap((p) => ['--project', p])];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, FF_UNITY_SLOTS: dir } });
    child.unref();
    const answer = path.join(dir, `hold-${id}.json`);
    for (;;) {
      const a = readJson<{ ok: boolean; text: string; id?: string }>(answer);
      if (a) {
        rm(answer);
        if (!a.ok) throw new SlotRefused(a.text);
        process.stdout.write(`${a.id ?? ''}\n`);
        d.say(a.text);
        return 0;
      }
      if (o.timeoutMs !== undefined && Date.now() - Number(id.split('-')[0] ? parseInt(id.split('-')[0], 36) : 0) > o.timeoutMs + 5000) throw new SlotRefused('gave up waiting');
      await d.sleep(500);
    }
  }
  if (cmd === '__hold') {
    const [answerId, count, label, ttl] = o.rest;
    const answer = path.join(dir, `hold-${answerId}.json`);
    let h: Held;
    try {
      h = await acquire(d, { count: Number(count), label, holder, projects: o.projects });
    } catch (e) {
      writeAtomic(answer, JSON.stringify({ ok: false, text: (e as Error).message }));
      return 1;
    }
    writeAtomic(answer, JSON.stringify({ ok: true, id: h.id, text: h.ungated ?? `holding ${count} Unity slot(s) as ${h.id} for at most ${Math.round(Number(ttl) / 60_000)} min; unity-slot release ${h.id} when done` }));
    if (!h.id) return 0;
    const until = Date.now() + Number(ttl);
    while (Date.now() < until && fs.existsSync(reqFile(dir, h.id)) && !fs.existsSync(denyFile(dir, h.id))) await d.sleep(2000);
    h.stop();
    return 0;
  }
  if (cmd === 'release') {
    const id = o.rest[0];
    if (!id || !ID.test(id)) throw new Error('release needs the slot id acquire printed');
    const had = fs.existsSync(reqFile(dir, id));
    for (const f of [reqFile(dir, id), grantFile(dir, id), denyFile(dir, id)]) rm(f);
    d.say(had ? `released ${id}` : `${id} was not held`);
    return 0;
  }
  if (cmd === 'status') {
    const a = arbiterNow(dir, Date.now());
    if (!a) {
      process.stdout.write(`no slot arbiter on this machine (${arbiterFile(dir)} missing or stale)\n`);
      return 0;
    }
    const lines = [`Unity on ${a.machine ?? 'this machine'}: ${a.line} (as of ${a.at})`];
    for (const g of a.granted) lines.push(`  holds ${g.count}: "${g.label}" (${g.holder}) [${g.id}]`);
    for (const w of a.waiting) lines.push(`  waits for ${w.count}: "${w.label}" (${w.holder}) [${w.id}]: ${w.why}`);
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }
  if (cmd === 'serve') {
    if (o.limit === undefined) throw new Error('serve needs --limit N');
    const cur = readJson<ArbiterFile>(arbiterFile(dir));
    if (cur && Date.now() - Date.parse(cur.at) <= ARBITER_FRESH_MS && cur.pid !== process.pid && isAlive(cur.pid)) throw new Error(`an arbiter (pid ${cur.pid}) already serves ${dir}; give another --dir`);
    const { realDeps } = await import('./unity.ts');
    const platform: UnityPlatform = process.platform === 'win32' ? 'win32' : 'darwin';
    const procs = realDeps(platform).procs;
    const limit = o.limit;
    const slots = new UnitySlots({
      dir,
      platform,
      procs,
      alive: isAlive,
      now: () => Date.now(),
      limit: () => limit,
      places: () => [],
      ramPct: () => Math.round((100 * (os.totalmem() - os.freemem())) / os.totalmem()),
      log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
      onEvent: (text) => process.stdout.write(`${new Date().toISOString()} EVENT ${text}\n`),
    });
    d.say(`serving ${dir} with a limit of ${limit}`);
    const until = o.forMs === undefined ? Infinity : Date.now() + o.forMs;
    while (Date.now() < until) {
      const a = await slots.tick();
      process.stdout.write(`${new Date().toISOString()} ${slots.line()}${a.waiting.length ? ` | waiting: ${a.waiting.map((w) => w.id).join(', ')}` : ''}\n`);
      await d.sleep(3000);
    }
    return 0;
  }
  process.stdout.write(`${USAGE}\n`);
  return cmd === 'help' || cmd === '--help' ? 0 : 2;
}

/** Whether a process is alive (EPERM: it is, someone else's). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The `unity-slot` commands the daemon puts first on its agents' PATH (a sh script for Git Bash and macOS, a .cmd for
 * cmd and PowerShell), running this file with the daemon's own node.
 */
export function shimScripts(node: string, nodeArgs: string[], script: string): { sh: string; cmd: string } {
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const q = (s: string) => `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
  return {
    sh: `#!/bin/sh\n# FF Factory: Unity slots (docs/unity-lifecycle.md). Written by the machine daemon at start.\nexec ${[fwd(node), ...nodeArgs, fwd(script)].map(q).join(' ')} "$@"\n`,
    cmd: `@echo off\r\nrem FF Factory: Unity slots (docs/unity-lifecycle.md). Written by the machine daemon at start.\r\n${[node, ...nodeArgs, script].map((s) => `"${s}"`).join(' ')} %*\r\n`,
  };
}

/** Write the shims into <dir>/bin; returns that folder. */
export function installShims(dir: string, node = process.execPath, nodeArgs = process.execArgv.filter((a) => /strip-types|transform-types/.test(a)), script = import.meta.filename): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const s = shimScripts(node, nodeArgs, script);
  writeAtomic(path.join(bin, 'unity-slot'), s.sh);
  fs.chmodSync(path.join(bin, 'unity-slot'), 0o755);
  writeAtomic(path.join(bin, 'unity-slot.cmd'), s.cmd);
  return bin;
}

// Run when started directly (the shim, or node machine/unitySlots.ts ...).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`unity-slot: ${(e as Error).message}\n`);
      process.exit(e instanceof SlotRefused ? 3 : 2);
    },
  );
}
