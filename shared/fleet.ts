// Every computer and what it is working on, grouped for the sidebar and the Overview board: the portal's own host
// first (with its own daemon's sandboxes when it has one, as BEAST does; the portal itself holds none, w510), then each
// machine, each with its sandboxes and the agents in them (every worker runs in a sandbox, w536). Pure, so the server's
// tests can check it and the browser can run it.
import type { AppState, HostStats, LiveViewInfo, Machine, MachineSandbox, MachinePlatform, PlayerSeen, SandboxStatus, SessionInfo, UnitySlotsReport, UnityState, UserRole, WorkItem } from './types.ts';
import { AGENT_STATE_RANK, agentState, holdsSandbox, placeRank, sortAgents } from './agentState.ts';
import { holdsOf, workLiveAll } from './workState.ts';

/**
 * Agents with a process (working, waiting on someone, idle), and stopped ones their wake_me or a queued message will
 * resume (w475), unless they released their sandbox (w640). Other stopped and failed ones are only counted.
 */
export const isLiveAgent = (s: SessionInfo) => s.status === 'starting' || s.status === 'running' || s.status === 'idle' || s.status === 'waiting_permission' || holdsSandbox(s);

/** Agents in one place: the live ones (mid-turn, then between turns, then Idle; the most recent first in each, w475) and how many more have stopped or failed. */
export interface PlaceAgents {
  live: SessionInfo[];
  stopped: number;
  /** The chats the sidebar lists (w1430): those that matter now (chatMatters), a person's wait first, then in sortAgents order. */
  shown: SessionInfo[];
  /** The rest, the most recent first: folded behind "+N older" (w1430). Nothing is deleted. */
  older: SessionInfo[];
  /** Workers here that wait on a person (w1430): the slot's "Live view: go" button or its quiet "Asked you" (slotCall). */
  waits: PersonWait[];
}

/** A worker that waits on a person, as the ledger reads it (shared/workState.ts, state "waiting"): on which request, and on whom. */
export interface PersonWait {
  session: SessionInfo;
  request: string;
  /** Display names ("Ben"), as WorkLive.waitsOn says them. */
  on: string[];
}

/** What the sidebar reads of the ledger to decide which chats matter now (w1430): from AppState.work. */
export interface ChatLedger {
  /** The sessions that are the current worker of an open request (its latest worker that still holds it), with the requests. */
  current: Map<string, string[]>;
  /** The workers that wait on a person, by session id. */
  waits: Map<string, PersonWait>;
}

/** WORK_OPEN, spelled out: the web build takes only types from shared/types.ts. Stalled and closed requests are not open. */
const OPEN = new Set<WorkItem['status']>(['new', 'question', 'queued', 'blocked', 'active']);

/**
 * The ledger's view of the sessions (w1430): which are the current worker of an open request, and which wait on a person.
 * A request's current worker is the latest of its workers that still holds it (holdsOf): an earlier worker it was moved
 * from (w1325's 6e7c4ceb, after fff83521 took it over) is not. A worker waits on a person when its request's live state is
 * Waiting on input for something the worker asked (its declaration, its report), not for an intake approval or the
 * dispatcher's question, and not for a permission (the slot's amber badge counts those).
 */
export function chatLedger(work: readonly WorkItem[] | undefined, byId: Map<string, SessionInfo>, now: number = Date.now()): ChatLedger {
  const open = (work ?? []).filter((w) => OPEN.has(w.status));
  const current = new Map<string, string[]>();
  const holders = new Map<string, string>();
  for (const w of open) {
    const sid = [...w.sessionIds].reverse().find((id) => byId.has(id) && holdsOf(id, open).held.has(w.id));
    if (!sid) continue;
    holders.set(w.id, sid);
    current.set(sid, [...(current.get(sid) ?? []), w.id]);
  }
  const waits = new Map<string, PersonWait>();
  const live = workLiveAll(open, { session: (id) => byId.get(id), now });
  for (const w of open) {
    const l = live.get(w.id);
    if (l?.state !== 'waiting' || w.approval?.state === 'pending' || w.question || w.flag) continue;
    // The worker whose wait it is (w1504: the ledger says, so a settled wait of another worker is not it), else the one that
    // declared it (waiting_on_person), else the request's current worker.
    const declared = w.sessionIds.map((id) => byId.get(id)).find((s) => s?.waitingOn && (!s.waitingOn.request || s.waitingOn.request.toLowerCase() === w.id.toLowerCase()));
    const s = byId.get(l.worker ?? '') ?? declared ?? byId.get(holders.get(w.id) ?? '');
    if (!s || s.status === 'waiting_permission' || s.pendingPermissions.length || waits.has(s.id)) continue;
    waits.set(s.id, { session: s, request: w.id, on: l.waitsOn ?? [] });
  }
  return { current, waits };
}

/**
 * Whether a chat matters now (w1430, Ben: "there are so many inactive chats in every slot ... we should clean them up so the UI
 * isnt so cluttered and so i can find things easier"): one mid-turn, starting or asking for a permission; one whose agent
 * host failed; one between turns with its own work going, or stopped but coming back to its sandbox (holdsSandbox); the
 * current worker of an open request, whatever its process does; and one that waits on a person. The rest (finished: idle
 * with nothing pending and no open request; stopped or failed on a closed request) fold behind "+N older".
 */
export function chatMatters(s: SessionInfo, ledger: ChatLedger, now: number = Date.now()): boolean {
  if (s.status === 'starting' || s.status === 'running' || s.status === 'waiting_permission' || s.pendingPermissions.length || s.hostFailure) return true;
  if (agentState(s, undefined, now).state === 'between_turns' || holdsSandbox(s, now)) return true;
  return ledger.current.has(s.id) || ledger.waits.has(s.id);
}

const NO_LEDGER: ChatLedger = { current: new Map(), waits: new Map() };

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
  stats?: HostStats & { unity?: UnitySlotsReport };
  sandboxes: FleetSandbox[];
  /** max_sandboxes (machines) or limits.maxSandboxes (host), when known. */
  sandboxLimit?: number;
  /** Unity editors there: every one its daemon counts (w469), else the sandbox editors running or starting. */
  editors: number;
  editorLimit?: number;
  /** Live agents in this computer's sandboxes (standing agents have their own list). */
  live: number;
  /** Busy agents (a turn in flight, or waiting on someone). */
  busy: number;
  attention: number;
}

const busyAgent = (s: SessionInfo) => s.status === 'starting' || s.status === 'running' || s.status === 'waiting_permission';

function agentsIn(ids: string[], byId: Map<string, SessionInfo>, ledger: ChatLedger = NO_LEDGER, now: number = Date.now()): PlaceAgents {
  const all = ids.map((id) => byId.get(id)).filter((s): s is SessionInfo => !!s);
  const live = sortAgents(all.filter(isLiveAgent));
  const rank = (s: SessionInfo) => (ledger.waits.has(s.id) ? -1 : AGENT_STATE_RANK[agentState(s, undefined, now).state]);
  const shown = all.filter((s) => chatMatters(s, ledger, now)).sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt));
  const listed = new Set(shown);
  const older = all.filter((s) => !listed.has(s)).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const waits = shown.map((s) => ledger.waits.get(s.id)).filter((x): x is PersonWait => !!x);
  return { live, stopped: all.length - live.length, shown, older, waits };
}

/**
 * The slot's call to a person (w1430, Ben: "if there is work waiting for live view workflow, it should be obvious maybe as a
 * go button next to the slot"): a worker here waits on the viewer. "Live view: go" opens its Live view when it has one
 * running (docs/live-view.md: `views` are the ones this person may watch); otherwise the slot only says "Asked you", with no
 * button and no badge (w1521, Ben: "needs you should just be approving/denying coommands, if they have questions for me they
 * should pipe it through you and then i answer you. i want to stay in this chat to the extent possible"): the question is
 * answered in the person's orchestrator chat ([needs you] and its buttons), and "Needs you" is a permission's alone. A Live
 * view running while its worker is between turns is a wait on the person who asked for that worker as well, said or not: the
 * knobs are theirs to move (docs/live-view.md). Undefined when nothing here waits on the viewer and no view up here is one they
 * may watch.
 *
 * w1599 (lothsahn: "Give everyone a button to go to the live view even if it's not theirs"): a view up that waits on nobody
 * here is still one the viewer may watch (the session's requester, or an owner: `LiveHub.canWatch`), so it gets the same
 * button in a quiet style, kind 'watch'. That one calls nobody: no amber, no "Asked you", and the FREE chip stays.
 */
export interface SlotCall {
  kind: 'live' | 'asked' | 'watch';
  session: SessionInfo;
  /** The request it waits on, when the ledger says ("w1325"). */
  request?: string;
  label: string;
}

export function slotCall(
  agents: Pick<PlaceAgents, 'shown' | 'older' | 'waits'>,
  views: readonly LiveViewInfo[] | undefined,
  me: { userId: string; displayName: string; role?: UserRole } | undefined,
): SlotCall | undefined {
  if (!me) return undefined;
  const name = me.displayName.toLowerCase();
  const streams = (s: SessionInfo) => !!views?.some((v) => v.sessionId === s.id && v.state !== 'stopped');
  const mine = agents.waits.filter((x) => x.on.some((n) => n.toLowerCase() === name));
  const live = mine.find((x) => streams(x.session));
  if (live) return { kind: 'live', session: live.session, request: live.request, label: 'Live view: go' };
  if (mine[0]) return { kind: 'asked', session: mine[0].session, request: mine[0].request, label: 'Asked you' };
  const asked = (s: SessionInfo) => [s.requestedBy, s.lastRequestedBy].some((r) => r?.userId.toLowerCase() === me.userId.toLowerCase());
  const idle = [...agents.shown, ...agents.older].find((s) => s.status !== 'running' && s.status !== 'starting' && streams(s) && asked(s));
  if (idle) return { kind: 'live', session: idle, label: 'Live view: go' };
  const watch = [...agents.shown, ...agents.older].find((s) => streams(s) && (me.role === 'owner' || asked(s)));
  return watch && { kind: 'watch', session: watch, label: 'Live view: go' };
}

const waiting = (a: PlaceAgents) => a.live.reduce((n, s) => n + s.pendingPermissions.length, 0);

/**
 * Sandboxes by status (w509, Lothsahn): an agent mid-turn first, then one between turns, then Idle, then those with no live agent,
 * free ones last; the most recent activity first within each; otherwise in the order they came.
 */
const inUseFirst = (list: FleetSandbox[]) =>
  list
    .map((s, i) => ({ s, i, ...placeRank(s.agents.live) }))
    .sort((a, b) => a.rank - b.rank || Number(a.s.free) - Number(b.s.free) || b.latest.localeCompare(a.latest) || a.i - b.i)
    .map((x) => x.s);

function summarize(c: Omit<FleetComputer, 'live' | 'busy' | 'attention'>): FleetComputer {
  const places = c.sandboxes.map((s) => s.agents);
  const live = places.reduce((n, p) => n + p.live.length, 0);
  const busy = places.reduce((n, p) => n + p.live.filter(busyAgent).length, 0);
  const attention = c.sandboxes.reduce((n, s) => n + s.attention, 0);
  return { ...c, live, busy, attention };
}

const shortHost = (h: string) => h.replace(/\.(local|lan|home)$/i, '');

/**
 * `byId`: the sessions by id, when the caller already has them (the page keeps one per sessions list). With `work` (the
 * ledger the page has), each place's chats are split into those that matter now and the older ones (w1430).
 */
export function fleetOf(
  app: Pick<AppState, 'sessions' | 'machines' | 'system' | 'machineStats'> & Partial<Pick<AppState, 'work'>>,
  byId: Map<string, SessionInfo> = new Map(app.sessions.map((s) => [s.id, s])),
  now: number = Date.now(),
): FleetComputer[] {
  const ledger = chatLedger(app.work, byId, now);
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
      const agents = agentsIn(sb.sessionIds, byId, ledger, now);
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
    });
  });

  return [host(local), ...machines];
}

/** "2/3 sandboxes · 1/2 editors", or what a computer without a pool has. */
export function capacityLine(c: FleetComputer): string {
  // The portal's own host without a daemon of its own: it runs the orchestrators and the dispatcher only (w510).
  if (c.host && !c.daemon) return 'orchestrators only';
  // A machine without a sandbox root takes no workers (w536): it gets one through the worker installer (w513).
  if (!c.host && c.sandboxLimit === undefined) return 'no sandboxes';
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
  if (r.players) parts.push(`${r.players} game player${r.players === 1 ? '' : 's'} (not counted)${r.playerList?.length ? `: ${r.playerList.map(playerText).join(', ')}` : ''}`);
  if (r.leftoverProcesses) parts.push(`${r.leftoverProcesses} other process${r.leftoverProcesses === 1 ? '' : 'es'} of stopped workers, ending`);
  return parts.join('; ');
}

/** "pid 2459040 slot1-1, worker a33e1437 (stopped: ends in 2 min), up 27.0 h", "pid 7 slot2-0, ORPHAN (no owner: ends in 9 min)" (w1196). */
export function playerText(p: PlayerSeen): string {
  const age = p.ageMin === undefined ? '' : `, up ${p.ageMin >= 120 ? `${(p.ageMin / 60).toFixed(1)} h` : `${p.ageMin} min`}`;
  const ends = p.endsInMin !== undefined ? `: ends in ${p.endsInMin} min` : '';
  const who =
    p.owner === 'orphan'
      ? `ORPHAN (no owner${ends})`
      : p.owner === 'held'
        ? 'no worker named (its starter or slot still holds it)'
        : `worker ${p.session ?? '?'}${p.sandbox ? ` in ${p.sandbox}` : ''} (${p.owner === 'live' ? 'running' : `stopped${ends}`})`;
  return `pid ${p.pid}${p.slot ? ` ${p.slot}` : ''}, ${who}${age}`;
}
