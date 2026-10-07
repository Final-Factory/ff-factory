// Every computer and what it is working on, grouped for the sidebar and the Overview board: the portal's own host
// first (with its own daemon's sandboxes when it has one, as BEAST does; the portal itself holds none, w510), then each
// machine, each with its sandboxes, the agents in them, and a machine's main-clone agents. Pure, so the server's tests
// can check it and the browser can run it.
import type { AppState, HostStats, Machine, MachineSandbox, MachinePlatform, SandboxStatus, SessionInfo, UnitySlotsReport, UnityState } from './types.ts';
import { holdsItsPlace, placeRank, sortAgents } from './agentState.ts';

/**
 * Agents with a process (working, waiting on someone, idle), and stopped ones their wake_me or a queued message will
 * resume (Waiting, w475). Other stopped and failed ones are only counted.
 */
export const isLiveAgent = (s: SessionInfo) => s.status === 'starting' || s.status === 'running' || s.status === 'idle' || s.status === 'waiting_permission' || holdsItsPlace(s);

/** Agents in one place: the live ones (Working, then Waiting, then Idle; the most recent first in each, w475) and how many more have stopped or failed. */
export interface PlaceAgents {
  live: SessionInfo[];
  stopped: number;
}

export interface FleetSandbox {
  /** "lothdesktop/sb1" (<machine>/<name>): unique across the fleet. */
  key: string;
  /** The folder name (the slot). */
  id: string;
  /** Set for a machine sandbox. */
  machineId?: string;
  /** Its label: the sandbox's name, fixed (w575). */
  purpose: string;
  /** What it is doing: its live agents' titles ("w513: LothDesktop fresh install"), Working first (w575). */
  doing: string[];
  /** The branch checked out now (git), else the one it was created on. */
  branch: string;
  status: SandboxStatus;
  statusDetail?: string;
  unity: UnityState;
  agents: PlaceAgents;
  /** Ready with no live agent: free to take. */
  free: boolean;
  /** Permission requests waiting in it, plus a blocked editor. */
  attention: number;
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

const busyAgent = (s: SessionInfo) => s.status === 'starting' || s.status === 'running' || s.status === 'waiting_permission';

function agentsIn(ids: string[], byId: Map<string, SessionInfo>, keep: (s: SessionInfo) => boolean = () => true): PlaceAgents {
  const all = ids.map((id) => byId.get(id)).filter((s): s is SessionInfo => !!s && keep(s));
  const live = sortAgents(all.filter(isLiveAgent));
  return { live, stopped: all.length - live.length };
}

const waiting = (a: PlaceAgents) => a.live.reduce((n, s) => n + s.pendingPermissions.length, 0);

/**
 * Sandboxes by status (w509, Lothsahn): a Working agent first, then Waiting, then Idle, then those with no live agent,
 * free ones last; the most recent activity first within each; otherwise in the order they came.
 */
const inUseFirst = (list: FleetSandbox[]) =>
  list
    .map((s, i) => ({ s, i, ...placeRank(s.agents.live) }))
    .sort((a, b) => a.rank - b.rank || Number(a.s.free) - Number(b.s.free) || b.latest.localeCompare(a.latest) || a.i - b.i)
    .map((x) => x.s);

function summarize(c: Omit<FleetComputer, 'live' | 'busy' | 'attention'>): FleetComputer {
  const places = [...c.sandboxes.map((s) => s.agents), ...(c.main ? [c.main] : [])];
  const live = places.reduce((n, p) => n + p.live.length, 0);
  const busy = places.reduce((n, p) => n + p.live.filter(busyAgent).length, 0);
  const attention = c.sandboxes.reduce((n, s) => n + s.attention, 0) + (c.main ? waiting(c.main) : 0);
  return { ...c, live, busy, attention };
}

const shortHost = (h: string) => h.replace(/\.(local|lan|home)$/i, '');

/** `byId`: the sessions by id, when the caller already has them (the page keeps one per sessions list). */
export function fleetOf(app: Pick<AppState, 'sessions' | 'machines' | 'system' | 'machineStats'>, byId: Map<string, SessionInfo> = new Map(app.sessions.map((s) => [s.id, s]))): FleetComputer[] {
  const host = (local?: Machine) => {
    // With its own daemon, this host's sandboxes are that daemon's; without one it holds none (the portal, w510).
    const daemonSandboxes = local ? machineSandboxes(local) : [];
    return summarize({
      key: 'host',
      name: app.system?.hostname ? shortHost(app.system.hostname) : 'This host',
      host: true,
      ...(local ? { daemon: local } : {}),
      platform: app.system?.platform,
      online: true,
      stats: app.system,
      sandboxes: inUseFirst(daemonSandboxes),
      sandboxLimit: local?.sandboxRoot ? (local.maxSandboxes ?? 3) : undefined,
      // Every Unity process there, as its daemon counts them (w469), else the sandbox editors it reports.
      editors: (local && app.machineStats?.[local.id]?.unity?.used) ?? daemonSandboxes.filter((s) => s.unity === 'running' || s.unity === 'starting').length,
      editorLimit: local?.sandboxRoot ? (local.maxUnity ?? 2) : undefined,
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
        doing: agents.live.map((s) => s.title),
        branch: sb.git?.branch ?? sb.branch,
        status: sb.status,
        statusDetail: sb.statusDetail,
        unity: sb.unity.state,
        agents,
        free: agents.live.length === 0 && sb.status === 'ready',
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
  // The portal's own host without a daemon of its own: it runs the orchestrators and the dispatcher only (w510).
  if (c.host && !c.daemon) return 'orchestrators only';
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
