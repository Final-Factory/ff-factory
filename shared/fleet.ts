// Every computer and what it is working on, grouped for the sidebar and the Overview board: the host
// (BEAST) first, then each machine, each with its sandboxes, the agents in them, and a machine's
// main-clone agents. Pure, so the server's tests can check it and the browser can run it.
import type { AppState, HostStats, Machine, MachineSandbox, MachinePlatform, Sandbox, SandboxStatus, SessionInfo, UnitySlotsReport, UnityState } from './types.ts';

/** Agents with a process: working, waiting on someone or idle. Stopped and failed ones are only counted. */
export const isLiveAgent = (s: SessionInfo) => s.status === 'starting' || s.status === 'running' || s.status === 'idle' || s.status === 'waiting_permission';

/** Agents in one place: the live ones (oldest first) and how many more have stopped or failed. */
export interface PlaceAgents {
  live: SessionInfo[];
  stopped: number;
}

export interface FleetSandbox {
  /** "alpha" for the host's, "lothdesktop/sb1" for a machine's: unique across the fleet. */
  key: string;
  /** The folder name (the slot). */
  id: string;
  /** Set for a machine sandbox. */
  machineId?: string;
  purpose: string;
  /** The branch checked out now (git), else the one it was created on. */
  branch: string;
  status: SandboxStatus;
  statusDetail?: string;
  unity: UnityState;
  agents: PlaceAgents;
  /** Unused label and no live agent: free to take. */
  free: boolean;
  /** Permission requests waiting in it, plus a blocked editor. */
  attention: number;
  sandbox?: Sandbox;
  machineSandbox?: MachineSandbox;
}

export interface FleetComputer {
  /** "host", or the machine id. */
  key: string;
  name: string;
  host: boolean;
  machine?: Machine;
  /**
   * The host's own machine daemon (docs/beast-machine.md): shown in the host's group, which lists its sandboxes as the
   * host's own (they are on this computer); it has no group of its own.
   */
  daemon?: Machine;
  platform?: MachinePlatform | string;
  online: boolean;
  stats?: HostStats;
  sandboxes: FleetSandbox[];
  /** max_sandboxes (machines) or limits.maxSandboxes (host), when known. */
  sandboxLimit?: number;
  /** Unity editors there: every one its daemon counts (w469), else the sandbox editors running or starting. */
  editors: number;
  editorLimit?: number;
  /** A machine's main-clone agents (its workers not in a sandbox; standing agents have their own list). */
  main?: PlaceAgents;
  /** Live agents on this computer, in sandboxes and the main clone. */
  live: number;
  /** Busy agents (a turn in flight, or waiting on someone). */
  busy: number;
  attention: number;
}

/** labels.ts isUnused, repeated: a shared module cannot import another's values (Node wants ".ts", the web build refuses it). */
const isUnused = (purpose: string | undefined) => {
  const p = (purpose ?? '').trim().toLowerCase();
  return !p || p === 'unused';
};

const busyAgent = (s: SessionInfo) => s.status === 'starting' || s.status === 'running' || s.status === 'waiting_permission';

function agentsIn(ids: string[], byId: Map<string, SessionInfo>, keep: (s: SessionInfo) => boolean = () => true): PlaceAgents {
  const all = ids.map((id) => byId.get(id)).filter((s): s is SessionInfo => !!s && keep(s));
  const live = all.filter(isLiveAgent);
  return { live, stopped: all.length - live.length };
}

const waiting = (a: PlaceAgents) => a.live.reduce((n, s) => n + s.pendingPermissions.length, 0);

/** In-use sandboxes first, free ones last; otherwise in the order they came. */
const inUseFirst = (list: FleetSandbox[]) => [...list.filter((s) => !s.free), ...list.filter((s) => s.free)];

function summarize(c: Omit<FleetComputer, 'live' | 'busy' | 'attention'>): FleetComputer {
  const places = [...c.sandboxes.map((s) => s.agents), ...(c.main ? [c.main] : [])];
  const live = places.reduce((n, p) => n + p.live.length, 0);
  const busy = places.reduce((n, p) => n + p.live.filter(busyAgent).length, 0);
  const attention = c.sandboxes.reduce((n, s) => n + s.attention, 0) + (c.main ? waiting(c.main) : 0);
  return { ...c, live, busy, attention };
}

const shortHost = (h: string) => h.replace(/\.(local|lan|home)$/i, '');

/** `byId`: the sessions by id, when the caller already has them (the page keeps one per sessions list). */
export function fleetOf(app: Pick<AppState, 'sandboxes' | 'sessions' | 'machines' | 'system' | 'machineStats'>, byId: Map<string, SessionInfo> = new Map(app.sessions.map((s) => [s.id, s]))): FleetComputer[] {

  const hostSandboxes = app.sandboxes.map((sb): FleetSandbox => {
    const agents = agentsIn(sb.sessionIds, byId);
    return {
      key: sb.id,
      id: sb.id,
      purpose: sb.purpose,
      branch: sb.git?.branch ?? sb.branch,
      status: sb.status,
      statusDetail: sb.statusDetail,
      unity: sb.unity.state,
      agents,
      free: isUnused(sb.purpose) && agents.live.length === 0 && sb.status === 'ready',
      attention: waiting(agents) + (sb.unity.state === 'blocked' ? 1 : 0),
      sandbox: sb,
    };
  });
  const hostEditors = app.sandboxes.filter((s) => s.unity.state === 'running' || s.unity.state === 'starting' || s.unity.state === 'blocked' || s.unity.state === 'stopping').length;
  const host = (local?: Machine) => {
    // With its own daemon, this host's sandboxes are that daemon's (plus any the host's old pool still has).
    const daemonSandboxes = local ? machineSandboxes(local) : [];
    return summarize({
      key: 'host',
      name: app.system?.hostname ? shortHost(app.system.hostname) : 'This host',
      host: true,
      ...(local ? { daemon: local } : {}),
      platform: app.system?.platform,
      online: true,
      stats: app.system,
      sandboxes: inUseFirst([...hostSandboxes, ...daemonSandboxes]),
      sandboxLimit: local?.sandboxRoot ? (local.maxSandboxes ?? 3) : app.system?.limits.maxSandboxes,
      // Every Unity process there, as its daemon counts them (w469), else the sandbox editors it reports.
      editors: (local && app.machineStats?.[local.id]?.unity?.used) ?? hostEditors + daemonSandboxes.filter((s) => s.unity === 'running' || s.unity === 'starting').length,
      editorLimit: local?.sandboxRoot ? (local.maxUnity ?? 2) : app.system?.limits.maxUnity,
    });
  };

  const machineSandboxes = (m: Machine) =>
    (m.sandboxes ?? []).map((sb): FleetSandbox => {
      const agents = agentsIn(sb.sessionIds, byId);
      return {
        key: `${m.id}/${sb.id}`,
        id: sb.id,
        machineId: m.id,
        purpose: sb.purpose,
        branch: sb.git?.branch ?? sb.branch,
        status: sb.status,
        statusDetail: sb.statusDetail,
        unity: sb.unity.state,
        agents,
        free: isUnused(sb.purpose) && agents.live.length === 0 && sb.status === 'ready',
        attention: waiting(agents),
        machineSandbox: sb,
      };
    });
  const local = app.machines.find((m) => m.local);
  const machines = app.machines.filter((m) => m !== local).map((m) => {
    const sandboxes = machineSandboxes(m);
    return summarize({
      key: m.id,
      name: m.name ?? m.id,
      host: false,
      machine: m,
      platform: m.platform ?? 'darwin',
      online: m.online,
      stats: app.machineStats?.[m.id],
      sandboxes: inUseFirst(sandboxes),
      // Pool defaults as the daemon applies them (docs/machines.md): 3 sandboxes, 2 editors once sandbox_root is set.
      sandboxLimit: m.sandboxRoot ? (m.maxSandboxes ?? 3) : undefined,
      editors: app.machineStats?.[m.id]?.unity?.used ?? sandboxes.filter((s) => s.unity === 'running' || s.unity === 'starting').length,
      editorLimit: m.sandboxRoot ? (m.maxUnity ?? 2) : undefined,
      main: agentsIn(m.sessionIds, byId, (s) => !s.machineSandbox && s.kind !== 'standing'),
    });
  });

  return [host(local), ...machines];
}

/** "2/3 sandboxes · 1/2 editors", or what a computer without a pool has. */
export function capacityLine(c: FleetComputer): string {
  if (!c.host && c.sandboxLimit === undefined) return 'main clone only';
  // "1/3 sandboxes" counts against the limit, so it stays plural; "1 sandbox" without one does not.
  const n = (count: number, limit: number | undefined, one: string, many: string) => (limit !== undefined ? `${count}/${limit} ${many}` : `${count} ${count === 1 ? one : many}`);
  return `${n(c.sandboxes.length, c.sandboxLimit, 'sandbox', 'sandboxes')} · ${n(c.editors, c.editorLimit, 'editor', 'editors')}`;
}

/**
 * A machine's Unity editors as its daemon counts them (w469): "editors 4 of 3: 1 interactive, 3 batch", then what is
 * over, waiting or held up by RAM, and the game players beside them (not counted).
 */
export function unitySlotsLine(r: UnitySlotsReport): string {
  const reserved = r.used - r.interactive - r.batch;
  const parts = [`editors ${r.used} of ${r.limit ?? 'no limit'}: ${r.interactive} interactive, ${r.batch} batch${reserved > 0 ? `, ${reserved} granted not started yet` : ''}`];
  if (r.overLimit) parts.push('OVER LIMIT: nothing more starts until it drops');
  if (r.waiting.length) parts.push(`${r.waiting.length} waiting (${r.waiting.slice(0, 3).map((w) => `"${w.label}" for ${w.count}`).join(', ')}${r.waiting.length > 3 ? ', ...' : ''})`);
  if (r.ramPct !== undefined && r.ramPct >= r.ramLimitPct) parts.push(`RAM ${r.ramPct}%: new launches wait below ${r.ramLimitPct}%`);
  if (r.players) parts.push(`${r.players} game player${r.players === 1 ? '' : 's'} (not counted)`);
  return parts.join('; ');
}
