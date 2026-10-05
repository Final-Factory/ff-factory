// Moving this host's sandboxes to its own machine daemon and back (docs/beast-machine.md). The record moves are pure
// functions on plain records, shared by the live tool (HostMigrator, the portal running) and the offline script
// (scripts/host-migration.ts, the portal and the daemon stopped). Nothing here touches a folder, a branch, a Library
// or an editor: a sandbox stays where it is and only changes owner.
import fs from 'node:fs';
import path from 'node:path';
import { poolSettingsOf } from './machines.ts';
import { statusDirFor } from './unityMcp.ts';
import { ADOPT_PROTOCOL } from './machineProtocol.ts';
import type { SessionHandle } from './sessions.ts';
import type { Store } from './store.ts';
import type { Config } from './config.ts';
import type { DelegationRequest, Machine, MachineSandbox, MachineSandboxUnity, Sandbox, SessionInfo } from '../shared/types.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';

const BUSY = new Set(['running', 'starting', 'waiting_permission']);

/** Whether two paths name the same folder, case-insensitive with either slash on Windows (these are Windows paths on BEAST). Exported for tests. */
export function samePlace(a: string | undefined, b: string | undefined, platform: NodeJS.Platform | string | undefined = process.platform): boolean {
  if (!a || !b) return false;
  const win = platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(a) || /^[a-zA-Z]:[\\/]/.test(b);
  const k = (p: string) => {
    const r = (win ? path.win32 : path.posix).resolve(p).replace(/[\\/]+$/, '');
    return win ? r.toLowerCase().replace(/\//g, '\\') : r;
  };
  return k(a) === k(b);
}

const unityOnMachine = (s: Sandbox['unity']['state']): MachineSandboxUnity['state'] =>
  s === 'running' || s === 'blocked' || s === 'stopping' ? 'running' : s === 'starting' ? 'starting' : s === 'crashed' ? 'crashed' : 'stopped';

/** A host sandbox as its machine's record: the same folder, branch, label and agents. Exported for tests. */
export function machineSandboxFrom(sb: Sandbox): MachineSandbox {
  return {
    id: sb.id,
    branch: sb.git?.branch && sb.git.branch !== 'detached HEAD' ? sb.git.branch : sb.branch,
    base: sb.base,
    path: sb.path,
    purpose: sb.purpose,
    status: sb.status,
    ...(sb.statusDetail ? { statusDetail: sb.statusDetail } : {}),
    createdAt: sb.createdAt,
    unity: { state: unityOnMachine(sb.unity.state), ...(sb.unity.pid ? { pid: sb.unity.pid } : {}), ...(sb.unity.logPath ? { logPath: sb.unity.logPath } : {}) },
    sessionIds: [...sb.sessionIds],
    ...(sb.git ? { git: sb.git } : {}),
  };
}

/** A machine sandbox as a host record (the migration back; `id` "beast/x" for the standing agents' view). Exported for tests. */
export function hostSandboxFrom(msb: MachineSandbox, id = msb.id): Sandbox {
  const up = msb.unity.state === 'running' || msb.unity.state === 'starting';
  return {
    id,
    name: msb.id,
    branch: msb.git?.branch && msb.git.branch !== 'detached HEAD' ? msb.git.branch : msb.branch,
    base: msb.base,
    path: msb.path,
    purpose: msb.purpose,
    status: msb.status,
    ...(msb.statusDetail ? { statusDetail: msb.statusDetail } : {}),
    createdAt: msb.createdAt,
    unity: { state: up && msb.unity.pid ? msb.unity.state : msb.unity.state === 'crashed' ? 'crashed' : 'stopped', ...(up && msb.unity.pid ? { pid: msb.unity.pid } : {}), ...(msb.unity.logPath ? { logPath: msb.unity.logPath } : {}) },
    sessionIds: [...msb.sessionIds],
    ...(msb.git ? { git: msb.git } : {}),
  };
}

/** Re-home a session record onto a machine sandbox (in place). Exported for tests. */
export function sessionToMachine(info: SessionInfo, machineId: string, sandbox: string) {
  delete info.sandboxId;
  info.machineId = machineId;
  info.machineSandbox = sandbox;
}

/** Re-home a session record onto a host sandbox (in place). Exported for tests. */
export function sessionToHost(info: SessionInfo, sandbox: string) {
  delete info.machineId;
  delete info.machineSandbox;
  info.sandboxId = sandbox;
}

/** The daemon's sandboxes.json row for a sandbox (machine/sandboxes.ts Rec). Exported for tests. */
export function daemonRecordFrom(sb: Pick<MachineSandbox, 'id' | 'branch' | 'base' | 'path' | 'createdAt' | 'unity'>) {
  return { id: sb.id, branch: sb.branch, base: sb.base, path: sb.path, createdAt: sb.createdAt, status: 'ready' as const, ...(sb.unity.logPath ? { logPath: sb.unity.logPath } : {}) };
}

/** state.json as the offline script edits it (server/store.ts Persisted). */
export interface StateFile {
  sandboxes: Sandbox[];
  sessions: SessionInfo[];
  machines?: Machine[];
  delegations?: DelegationRequest[];
  [k: string]: unknown;
}

/** What a move changed, for the report and the daemon's own file. */
export interface MoveResult {
  sandboxes: string[];
  sessions: string[];
  delegations: string[];
}

/**
 * Move host sandboxes (all, or `ids`) and their sessions onto machine `machineId` in a state file's records, in place.
 * Delegations that named a moved sandbox name it as "<machine>/<id>". Exported for tests and the offline script.
 */
export function moveStateToMachine(state: StateFile, machineId: string, ids?: string[]): MoveResult {
  const m = state.machines?.find((x) => x.id === machineId);
  if (!m) throw new Error(`no machine "${machineId}" in the state file`);
  const out: MoveResult = { sandboxes: [], sessions: [], delegations: [] };
  const moving = state.sandboxes.filter((s) => !ids || ids.includes(s.id));
  for (const sb of moving) {
    if ((m.sandboxes ?? []).some((x) => x.id === sb.id)) throw new Error(`${machineId} already has a sandbox "${sb.id}"`);
    m.sandboxes = [...(m.sandboxes ?? []), machineSandboxFrom(sb)];
    for (const sid of sb.sessionIds) {
      const info = state.sessions.find((x) => x.id === sid);
      if (!info) continue;
      sessionToMachine(info, machineId, sb.id);
      if (!m.sessionIds.includes(sid)) m.sessionIds = [...m.sessionIds, sid];
      out.sessions.push(sid);
    }
    for (const d of state.delegations ?? []) {
      if (d.sandboxId !== sb.id) continue;
      d.sandboxId = `${machineId}/${sb.id}`;
      out.delegations.push(d.id);
    }
    out.sandboxes.push(sb.id);
  }
  state.sandboxes = state.sandboxes.filter((s) => !out.sandboxes.includes(s.id));
  return out;
}

/** The reverse: machine `machineId`'s sandboxes (all, or `ids`) back to host records, in place. Exported for tests and the offline script. */
export function moveStateToHost(state: StateFile, machineId: string, ids?: string[]): MoveResult {
  const m = state.machines?.find((x) => x.id === machineId);
  if (!m) throw new Error(`no machine "${machineId}" in the state file`);
  const out: MoveResult = { sandboxes: [], sessions: [], delegations: [] };
  for (const msb of (m.sandboxes ?? []).filter((s) => !ids || ids.includes(s.id))) {
    if (state.sandboxes.some((x) => x.id === msb.id)) throw new Error(`this host already has a sandbox "${msb.id}"`);
    state.sandboxes.push(hostSandboxFrom(msb));
    for (const sid of msb.sessionIds) {
      const info = state.sessions.find((x) => x.id === sid);
      if (!info) continue;
      sessionToHost(info, msb.id);
      m.sessionIds = m.sessionIds.filter((x) => x !== sid);
      out.sessions.push(sid);
    }
    for (const d of state.delegations ?? []) {
      if (d.sandboxId !== `${machineId}/${msb.id}`) continue;
      d.sandboxId = msb.id;
      out.delegations.push(d.id);
    }
    out.sandboxes.push(msb.id);
  }
  m.sandboxes = (m.sandboxes ?? []).filter((s) => !out.sandboxes.includes(s.id));
  return out;
}

// ---------------------------------------------------------------- the live migration (the portal running)

/** What the live migration needs of the machines (server/machines.ts MachineManager). */
export interface MigratorMachines {
  local(): Machine | undefined;
  isOnline(id: string): boolean;
  protocolOf(id: string): number | undefined;
  outdated(id: string): string | undefined;
  adoptSandbox(machineId: string, req: { id: string; path: string; branch: string; base: string; createdAt: string; logPath?: string; purpose: string }): Promise<string>;
  releaseSandbox(machineId: string, sandbox: string): Promise<string>;
  /** A session handle for a machine session record (a RemoteSession). */
  restore(info: SessionInfo): SessionHandle | undefined;
}

export interface MigratorDeps {
  cfg: Pick<Config, 'dataDir' | 'sandboxRoot' | 'repo'>;
  store: Store;
  sessions: { sessions: Map<string, SessionHandle> };
  machines: MigratorMachines;
  /** A handle for a host worker record (an AgentSession with the workers' options), for the move back. */
  hostSession(info: SessionInfo): SessionHandle;
  now?: () => Date;
  /** How long to wait for idle agents to stop (tests shorten it). */
  stopWaitMs?: number;
}

/** The last migration, kept in <dataDir>/host-migration.json. */
export interface MigrationRecord {
  at: string;
  direction: 'to_machine' | 'back';
  machine: string;
  sandboxes: string[];
  sessions: string[];
  backup?: string;
}

/**
 * Why host sandboxes cannot move to the local machine now, or an empty list. `live(id)`: a session has a process.
 * Exported for tests.
 */
export function toMachineProblems(o: {
  host: Sandbox[];
  sessions: Map<string, SessionInfo>;
  busy: (id: string) => boolean;
  machine: Machine | undefined;
  online: boolean;
  protocol: number | undefined;
  outdated: string | undefined;
  cfg: Pick<Config, 'sandboxRoot' | 'repo'>;
}): string[] {
  const m = o.machine;
  if (!m) return ["this host is not set up as a machine yet: add_machine with local: true (e.g. id \"beast\") first"];
  const out: string[] = [];
  if (!o.online) out.push(`${m.id}'s daemon is not connected`);
  else if (o.protocol === undefined || o.protocol < ADOPT_PROTOCOL) out.push(`${m.id}'s daemon speaks protocol ${o.protocol ?? '?'}; it needs ${ADOPT_PROTOCOL} (redeploy it)`);
  else if (o.outdated) out.push(`${m.id}'s daemon is outdated (${o.outdated}); let it be redeployed first`);
  const pool = poolSettingsOf(m);
  if (!pool) out.push(`${m.id} has no sandbox_root`);
  else if (!samePlace(pool.root, o.cfg.sandboxRoot)) out.push(`${m.id}'s sandbox_root ${pool.root} is not this host's sandboxRoot ${o.cfg.sandboxRoot}`);
  if (!samePlace(m.repoPath, o.cfg.repo.basePath)) out.push(`${m.id}'s main clone ${m.repoPath || '?'} is not this host's base clone ${o.cfg.repo.basePath}`);
  if (!o.host.length) out.push('this host has no sandboxes to move');
  for (const sb of o.host) {
    if (sb.status !== 'ready') out.push(`sandbox ${sb.id} is ${sb.status}${sb.statusDetail ? ` (${sb.statusDetail})` : ''}: delete or fix it first`);
    // The same folder already on the machine is a move a hard reset cut off after its adopt: running it again finishes it.
    const held = (m.sandboxes ?? []).find((x) => x.id === sb.id);
    if (held && !samePlace(held.path, sb.path)) out.push(`${m.id} already has a different sandbox "${sb.id}" (${held.path})`);
    for (const sid of sb.sessionIds) {
      const s = o.sessions.get(sid);
      if (!s) continue;
      if (BUSY.has(s.status) || o.busy(sid)) out.push(`agent ${sid} in ${sb.id} is mid-turn (${s.status})`);
      else if (s.pendingPermissions.length) out.push(`agent ${sid} in ${sb.id} waits on a permission answer`);
    }
  }
  const coming = o.host.filter((sb) => !halfMovedTo(m, sb)).length;
  if (pool && (m.sandboxes ?? []).length + coming > pool.maxSandboxes) out.push(`${m.id} may hold ${pool.maxSandboxes} sandboxes (max_sandboxes); it has ${(m.sandboxes ?? []).length} and this host ${coming} more`);
  return out;
}

/** A host sandbox the machine already holds at the same folder: a move to it that a hard reset cut off before the records moved. */
export const halfMovedTo = (m: Pick<Machine, 'sandboxes'>, sb: Pick<Sandbox, 'id' | 'path'>) => (m.sandboxes ?? []).some((x) => x.id === sb.id && samePlace(x.path, sb.path));

/** Why the local machine's sandboxes cannot move back to this host now, or an empty list. Exported for tests. */
export function backProblems(o: { machine: Machine | undefined; online: boolean; protocol: number | undefined; hostPaths: Map<string, string>; sessions: Map<string, SessionInfo>; live: (id: string) => boolean }): string[] {
  const m = o.machine;
  if (!m) return ["no machine is this host's own daemon (add_machine local): nothing to move back"];
  const out: string[] = [];
  if (!o.online) out.push(`${m.id}'s daemon is not connected (with the portal and the daemon stopped, scripts/host-migration.ts back does it offline)`);
  else if (o.protocol === undefined || o.protocol < ADOPT_PROTOCOL) out.push(`${m.id}'s daemon speaks protocol ${o.protocol ?? '?'} and cannot release sandboxes`);
  if (!(m.sandboxes ?? []).length) out.push(`${m.id} has no sandboxes to move back`);
  for (const sb of m.sandboxes ?? []) {
    if (sb.status !== 'ready') out.push(`sandbox ${m.id}/${sb.id} is ${sb.status}: wait until it is ready, or delete it`);
    // The same folder already here is a move back a hard reset cut off before the release: running it again finishes it.
    const here = o.hostPaths.get(sb.id);
    if (here !== undefined && !samePlace(here, sb.path)) out.push(`this host already has a different sandbox "${sb.id}" (${here})`);
    for (const sid of sb.sessionIds) if (o.live(sid)) out.push(`agent ${sid} in ${m.id}/${sb.id} still has a process: stop it first`);
  }
  return out;
}

/** The live migration (the migrate_host_sandboxes tool). One at a time. */
export class HostMigrator {
  private readonly d: MigratorDeps;
  private running = false;

  constructor(d: MigratorDeps) {
    this.d = d;
  }

  private get file() {
    return path.join(this.d.cfg.dataDir, 'host-migration.json');
  }

  /** The last migration, if any. */
  last(): MigrationRecord | undefined {
    return readJsonDurable<MigrationRecord>(this.file, { check: checkObject });
  }

  private record(r: MigrationRecord) {
    writeJsonDurable(this.file, r, { indent: 2 });
  }

  private now() {
    return this.d.now ? this.d.now() : new Date();
  }

  /** A copy of state.json before anything moves, named for the time: the offline rollback's starting point. */
  private backup(): string {
    this.d.store.flush();
    const from = path.join(this.d.cfg.dataDir, 'state.json');
    const to = path.join(this.d.cfg.dataDir, `state.pre-host-migration-${this.now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}.json`);
    fs.copyFileSync(from, to);
    return to;
  }

  /** Stop the idle agent processes of these sessions (idle agents keep a process), and wait until they are gone. */
  private async stopIdle(ids: string[]): Promise<string[]> {
    const live = ids.filter((id) => this.d.sessions.sessions.get(id)?.live);
    for (const id of live) this.d.sessions.sessions.get(id)?.stop(false);
    const until = Date.now() + (this.d.stopWaitMs ?? 30_000);
    while (live.some((id) => this.d.sessions.sessions.get(id)?.live) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    const still = live.filter((id) => this.d.sessions.sessions.get(id)?.live);
    if (still.length) throw new Error(`these agents did not stop within ${Math.round((this.d.stopWaitMs ?? 30_000) / 1000)} s: ${still.join(', ')}`);
    return live;
  }

  private plainState(): StateFile {
    const st = this.d.store;
    return { sandboxes: [...st.sandboxes.values()], sessions: [...st.sessions.values()], machines: [...st.machines.values()], delegations: [...st.delegations.values()] };
  }

  /** Move every host sandbox to this host's own daemon. `dryRun`: only say what would happen. */
  async toMachine(dryRun = false): Promise<string> {
    if (this.running) throw new Error('a migration is already running');
    const st = this.d.store;
    const m = this.d.machines.local();
    const host = [...st.sandboxes.values()];
    const problems = toMachineProblems({
      host,
      sessions: st.sessions,
      busy: (id) => {
        const h = this.d.sessions.sessions.get(id);
        return !!h?.live && BUSY.has(h.info.status);
      },
      machine: m,
      online: !!m && this.d.machines.isOnline(m.id),
      protocol: m && this.d.machines.protocolOf(m.id),
      outdated: m && this.d.machines.outdated(m.id),
      cfg: this.d.cfg,
    });
    if (problems.length) throw new Error(`cannot move this host's sandboxes now: ${problems.join('; ')}`);
    const machine = m!;
    const sessionIds = host.flatMap((s) => s.sessionIds).filter((id) => st.sessions.has(id));
    const idle = sessionIds.filter((id) => this.d.sessions.sessions.get(id)?.live);
    const summary = host.map((s) => `${s.id} (${s.path}, ${s.sessionIds.length} agent record(s), editor ${s.unity.state})`).join('; ');
    const half = host.filter((s) => halfMovedTo(machine, s)).map((s) => s.id);
    const halfNote = half.length ? ` ${half.join(', ')} ${half.length === 1 ? 'is' : 'are'} on ${machine.id}'s daemon already (a move cut off, e.g. by a reboot, before the records moved): this finishes ${half.length === 1 ? 'it' : 'them'}.` : '';
    if (dryRun) return `Would move ${host.length} sandbox(es) to ${machine.id}: ${summary}.${idle.length ? ` It would first stop the idle agent processes of ${idle.join(', ')}.` : ''}${halfNote} Folders, branches, Libraries and running editors stay as they are.`;
    this.running = true;
    try {
      const backup = this.backup();
      await this.stopIdle(sessionIds);
      const moved: string[] = [];
      const movedSessions: string[] = [];
      const failures: string[] = [];
      const finished: string[] = [];
      for (const sb of host) {
        // A wake, a resume or a message can start one of its agents here while earlier sandboxes move: then it stays.
        const liveNow = () => sb.sessionIds.filter((id) => this.d.sessions.sessions.get(id)?.live);
        if (liveNow().length) {
          failures.push(`${sb.id}: agent(s) ${liveNow().join(', ')} started again meanwhile`);
          continue;
        }
        // Held by the daemon already (a move a hard reset cut off after the adopt): only the records are left to move.
        const finishing = halfMovedTo(st.machines.get(machine.id) ?? {}, sb);
        if (!finishing) {
          try {
            const msb = machineSandboxFrom(sb);
            await this.d.machines.adoptSandbox(machine.id, { id: sb.id, path: sb.path, branch: msb.branch, base: sb.base, createdAt: sb.createdAt, logPath: sb.unity.logPath, purpose: sb.purpose });
          } catch (e) {
            // It may have been taken all the same (an answer that came too late): give it back, so only this host owns it.
            failures.push(`${sb.id}: ${(e as Error).message}${await this.undoAdopt(machine.id, sb.id)}`);
            continue;
          }
          const late = liveNow();
          if (late.length) {
            failures.push(`${sb.id}: agent(s) ${late.join(', ')} started while it was being moved, so it stays here${await this.undoAdopt(machine.id, sb.id)}`);
            continue;
          }
        }
        // From here to the end of the pass nothing awaits: no agent can start between the check above and the move.
        const r = this.recordsToMachine(machine.id, sb);
        moved.push(sb.id);
        movedSessions.push(...r.sessions);
        if (finishing) finished.push(sb.id);
      }
      this.record({ at: this.now().toISOString(), direction: 'to_machine', machine: machine.id, sandboxes: moved, sessions: movedSessions, backup });
      const refs = moved.map((id) => `${machine.id}/${id}`).join(', ');
      return [
        moved.length ? `Moved ${moved.length} sandbox(es) to ${machine.id}: ${refs} (bare names keep working). ${movedSessions.length} agent record(s) moved with them; their history and session ids are unchanged, and a message to one starts it on ${machine.id}'s daemon.` : 'Moved nothing.',
        finished.length ? `Of those, ${finished.join(', ')} ${finished.length === 1 ? 'was' : 'were'} on ${machine.id}'s daemon already (a move cut off before): finished.` : '',
        idle.length ? `Stopped the idle agent processes of ${idle.join(', ')} first.` : '',
        failures.length ? `NOT moved (still this host's): ${failures.join('; ')}.` : '',
        `A copy of state.json from before is ${backup}.`,
      ]
        .filter(Boolean)
        .join(' ');
    } finally {
      this.running = false;
    }
  }

  /**
   * The records of host sandbox `sb` and its agents onto the machine, whose daemon holds the folder already, written to
   * disk at once (w424: BEAST hard-resets): a reset right after leaves it moved, not held by both. `facts`: the machine's
   * own record to keep when its daemon's snapshot has not brought one (a release it refused, below).
   */
  private recordsToMachine(machineId: string, sb: Sandbox, facts?: MachineSandbox): MoveResult {
    const st = this.d.store;
    const state = this.plainState();
    const mm = state.machines!.find((x) => x.id === machineId)!;
    // The daemon's snapshot (sent before its answer) made the machine's record; the records move in one go.
    const adopted = (mm.sandboxes ?? []).find((x) => x.id === sb.id) ?? facts;
    mm.sandboxes = (mm.sandboxes ?? []).filter((x) => x.id !== sb.id);
    const r = moveStateToMachine(state, machineId, [sb.id]);
    // Keep the daemon's own facts (editor, git) over the host's copy.
    if (adopted) mm.sandboxes = mm.sandboxes!.map((x) => (x.id === sb.id ? { ...adopted, purpose: sb.purpose, sessionIds: [...sb.sessionIds] } : x));
    for (const sid of r.sessions) {
      const info = st.sessions.get(sid)!;
      st.putSession(info);
      const h = this.d.machines.restore(info);
      if (h) this.d.sessions.sessions.set(sid, h);
    }
    for (const did of r.delegations) st.putDelegation(st.delegations.get(did)!);
    st.putMachine(mm);
    st.removeSandbox(sb.id);
    fs.rmSync(statusDirFor(this.d.cfg.dataDir, sb.id), { recursive: true, force: true });
    st.flush();
    return r;
  }

  /**
   * The records of machine sandbox `msb` and its agents back to this host, written to disk before its daemon lets go of
   * the folder: a hard reset in between leaves it held by both (running back again only releases it), never by neither,
   * which would lose its label and agents (w424).
   */
  private recordsToHost(machineId: string, msb: MachineSandbox): MoveResult {
    const st = this.d.store;
    const state = this.plainState();
    const mm = state.machines!.find((x) => x.id === machineId)!;
    mm.sandboxes = [...(mm.sandboxes ?? []).filter((x) => x.id !== msb.id), msb];
    const r = moveStateToHost(state, machineId, [msb.id]);
    const hostRec = state.sandboxes.find((x) => x.id === msb.id)!;
    for (const sid of r.sessions) {
      const info = st.sessions.get(sid)!;
      st.putSession(info);
      this.d.sessions.sessions.set(sid, this.d.hostSession(info));
    }
    for (const did of r.delegations) st.putDelegation(st.delegations.get(did)!);
    st.putMachine(mm);
    st.putSandbox(hostRec);
    st.flush();
    return r;
  }

  /** A failed or overtaken adopt: make sure the daemon does not keep the sandbox too. Returns a note for the report. */
  private async undoAdopt(machineId: string, id: string): Promise<string> {
    try {
      await this.d.machines.releaseSandbox(machineId, id);
      return `; ${machineId} had taken it and gave it back`;
    } catch (e) {
      const msg = (e as Error).message;
      if (/no sandbox/i.test(msg)) return '';
      return `; CHECK ${machineId}: it may list ${id} as well (${msg}): release it with migrate_host_sandboxes back once it answers`;
    }
  }

  /** Move the local machine's sandboxes back to this host's own pool (the rollback). */
  async back(dryRun = false): Promise<string> {
    if (this.running) throw new Error('a migration is already running');
    const st = this.d.store;
    const m = this.d.machines.local();
    const live = (id: string) => !!this.d.sessions.sessions.get(id)?.live;
    const hostPaths = new Map([...st.sandboxes.values()].map((s) => [s.id, s.path]));
    const problems = backProblems({ machine: m, online: !!m && this.d.machines.isOnline(m.id), protocol: m && this.d.machines.protocolOf(m.id), hostPaths, sessions: st.sessions, live });
    if (problems.length) throw new Error(`cannot move ${m?.id ?? 'the local machine'}'s sandboxes back now: ${problems.join('; ')}`);
    const machine = m!;
    const list = [...(machine.sandboxes ?? [])];
    const half = list.filter((s) => hostPaths.has(s.id)).map((s) => s.id);
    const halfNote = half.length ? ` ${half.join(', ')} ${half.length === 1 ? 'is' : 'are'} this host's already (a move back cut off, e.g. by a reboot, before ${machine.id} let go): this only releases ${half.length === 1 ? 'it' : 'them'} there.` : '';
    if (dryRun) return `Would move ${list.length} sandbox(es) back from ${machine.id} to this host: ${list.map((s) => `${s.id} (${s.path})`).join(', ')}.${halfNote} Folders, branches, Libraries and running editors stay as they are; this host's own watch takes the editors over.`;
    this.running = true;
    try {
      const backup = this.backup();
      const moved: string[] = [];
      const movedSessions: string[] = [];
      const failures: string[] = [];
      const finished: string[] = [];
      for (const { id } of list) {
        // The record as it is now: an agent record made in this sandbox while earlier ones moved belongs to it too.
        const msb = st.machines.get(machine.id)?.sandboxes?.find((x) => x.id === id);
        if (!msb) {
          failures.push(`${id}: no longer on ${machine.id}`);
          continue;
        }
        const keep = { ...msb, sessionIds: [...msb.sessionIds] };
        // This host's already (a move back a hard reset cut off before the release): only the release is left.
        const finishing = st.sandboxes.has(id);
        // The records first, on disk before the daemon lets go (recordsToHost).
        const r: MoveResult = finishing ? { sandboxes: [id], sessions: [], delegations: [] } : this.recordsToHost(machine.id, keep);
        try {
          // The daemon refuses while an agent process runs there.
          await this.d.machines.releaseSandbox(machine.id, id);
        } catch (e) {
          const msg = (e as Error).message;
          // Gone from the daemon already: released before a reset cut the rest off. Anything else: it keeps the folder.
          if (!/no sandbox/i.test(msg)) {
            const sb = finishing ? undefined : st.sandboxes.get(id);
            if (sb) this.recordsToMachine(machine.id, sb, keep);
            failures.push(`${id}: ${msg}`);
            continue;
          }
        }
        // releaseSandbox drops it from the machine's record; one a reset left there too. Saved before the next.
        const mm = st.machines.get(machine.id);
        if (mm?.sandboxes?.some((x) => x.id === id)) {
          mm.sandboxes = mm.sandboxes.filter((x) => x.id !== id);
          st.putMachine(mm);
        }
        st.flush();
        moved.push(id);
        movedSessions.push(...r.sessions);
        if (finishing) finished.push(id);
      }
      this.record({ at: this.now().toISOString(), direction: 'back', machine: machine.id, sandboxes: moved, sessions: movedSessions, backup });
      return [
        moved.length ? `Moved ${moved.length} sandbox(es) back from ${machine.id} to this host: ${moved.join(', ')}, with ${movedSessions.length} agent record(s).` : 'Moved nothing.',
        finished.length ? `Of those, ${finished.join(', ')} ${finished.length === 1 ? 'was' : 'were'} this host's already (a move back cut off before): released on ${machine.id}.` : '',
        failures.length ? `NOT moved (still on ${machine.id}): ${failures.join('; ')}.` : '',
        `New sandboxes go to ${machine.id} while it has a sandbox_root: remove_machine ${machine.id} (it has no sandboxes now) to stop that, and its daemon with it.`,
        `A copy of state.json from before is ${backup}.`,
      ]
        .filter(Boolean)
        .join(' ');
    } finally {
      this.running = false;
    }
  }
}
