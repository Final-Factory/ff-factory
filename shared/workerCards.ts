// The Overview's Workers mode (w1837, Ben: "a mode where it shows an individual card for every worker ... concise, compact,
// show the status, like a header, like a title that briefly describes what it's doing ... what machine it's on"): one card
// per worker the machine view lists (each sandbox's chats that matter now, shared/fleet.ts chatMatters), with its status
// in the dashboard's words and colours, what it is doing now, where it runs, its request and whose it is. Pure, so the
// server's tests check the status, the order and the filters, and the page runs it on the fleet it already has (no new
// polling: fleetFor and the page's own ledger).
import type { LiveViewInfo, SessionInfo, WorkItem, WorkPr } from './types.ts';
import { agentState } from './agentState.ts';
import { gatesOf } from './blockers.ts';
import { chatLedger, type FleetComputer } from './fleet.ts';
import { workLiveAll, type WorkLive } from './workState.ts';

/**
 * A card's status. Needs you is a permission only (w1521: a question is answered in the orchestrator chat); Waiting is a
 * person's wait the ledger reads (waiting_on_person, a report that asks); Working is mid-turn, or between turns with a job
 * of its own still running (CI, a build: w643); Due back waits for its own check-in and nothing else (the ledger counts it
 * Working, the machine view Stopped or Idle: the card says neither, w1837's critic); Queued is capacity and Blocked a thing
 * (w643); Stalled is its request's red state (nothing works on it and nothing waits on a person); Idle finished its turn;
 * Stopped has no process and nothing brings it back by itself.
 */
export type CardStatus = 'needs_you' | 'waiting' | 'working' | 'due_back' | 'queued' | 'blocked' | 'stalled' | 'error' | 'idle' | 'stopped';

/** The dashboard's tones (web/src/util.ts Tone): the ledger's LIVE_TONE and the agent dots (DispatcherPanel.tsx, Fleet.tsx). */
export type CardTone = 'amber' | 'blue' | 'grey' | 'violet' | 'red';

export const CARD_STATUS_TONE: Record<CardStatus, CardTone> = {
  needs_you: 'amber',
  waiting: 'amber',
  working: 'blue',
  due_back: 'grey',
  queued: 'grey',
  blocked: 'violet',
  stalled: 'red',
  error: 'red',
  idle: 'grey',
  stopped: 'grey',
};

/**
 * The card groups, in the board's order (the brief: "needs-a-person first, then working, then queued/blocked, then idle"):
 * a person must act, work goes on, something holds it up, nothing happens.
 */
export type CardGroup = 'person' | 'working' | 'held' | 'resting';
export const CARD_GROUPS: readonly CardGroup[] = ['person', 'working', 'held', 'resting'];
export const CARD_GROUP_LABEL: Record<CardGroup, string> = { person: 'Needs a person', working: 'Working', held: 'Held up', resting: 'Idle or stopped' };
export const CARD_GROUP_TONE: Record<CardGroup, CardTone> = { person: 'amber', working: 'blue', held: 'violet', resting: 'grey' };

/** Held up: queued for capacity, blocked on a thing, due back at a check-in, stalled or failed. */
const GROUP_OF: Record<CardStatus, CardGroup> = { needs_you: 'person', waiting: 'person', working: 'working', due_back: 'held', queued: 'held', blocked: 'held', stalled: 'held', error: 'held', idle: 'resting', stopped: 'resting' };
/**
 * Within a group: a permission before a question (a worker stands mid-turn on a permission), failed and stalled before
 * blocked, then queued, then due back; idle before stopped.
 */
const STATUS_RANK: Record<CardStatus, number> = { needs_you: 0, waiting: 1, working: 0, error: 0, stalled: 1, blocked: 2, queued: 3, due_back: 4, idle: 0, stopped: 1 };

export interface WorkerCard {
  /** The session id. */
  id: string;
  session: SessionInfo;
  /** What it is doing, in a few words: the worker's title without its "w1837:" (Ben's header), else the request's title. */
  title: string;
  status: CardStatus;
  /** The status as the card says it: "Working", "Needs you", "Asked you", "Waits on Lothsahn", "Blocked", …. */
  word: string;
  tone: CardTone;
  group: CardGroup;
  /** What it is on now: the tool mid-turn, the job or check-in between turns, what a person must do, what blocks it. */
  doing?: string;
  /** `doing` names the tool it is in mid-turn ("Bash", "run_tests"): the card marks it as one. */
  tool?: boolean;
  /** Since when it has had this status (ISO): the card's "12m". */
  since: string;
  /** The machine's id, its display name, and the sandbox (the slot). */
  machineId: string;
  machine: string;
  sandbox: string;
  /** Its request (the one it holds now), the request's title, and whose it is. */
  request?: string;
  requestTitle?: string;
  person?: string;
  /** The request's pull request: an open one first, else the latest. */
  pr?: Pick<WorkPr, 'repo' | 'number' | 'url' | 'state'>;
  /** A Live view of it is up. */
  live: boolean;
  costUsd: number;
}

/** "w1837: Overview toggle" → "Overview toggle": the request id is on the card's foot already. */
export const plainTitle = (title: string) => title.replace(/^\s*w\d+\s*[:\-–·]\s*/i, '').trim();

/** "mcp__machine__read_work" → "read_work"; other tools as they are ("Bash"). */
export const toolName = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');

/** How long, in the card's few characters: "now", "45s", "12m", "3h", "2d". */
export function shortAge(since: string, now: number): string {
  const t = Date.parse(since);
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The facts beside a session that decide its status: its request's live state and a person's wait (shared/fleet.ts). */
export interface CardFacts {
  /** The request it holds, when it is the current worker of an open one. */
  work?: WorkItem;
  live?: WorkLive;
  /** Display names a person-wait of it is on (ChatLedger.waits). */
  waitsOn?: string[];
  /** The viewer's display name: a wait on them is "Asked you". */
  me?: string;
  /**
   * A Live view of it is up, and who asked for it: between turns that is a wait on that person (shared/fleet.ts slotCall,
   * docs/live-view.md: the knobs are theirs to move), said or not.
   */
  liveUp?: boolean;
  requester?: string;
  now: number;
  /** How a check-in time reads ("16:29 UTC"); the page passes local time. */
  time?: (iso: string, now: number) => string;
}

const lastSaid = (s: SessionInfo) => s.lastResultAt ?? s.lastActivityAt;

/** A card's status, what it says, what it is on now (a sentence, or a tool's own name as it is) and since when. */
export function cardStatus(s: SessionInfo, f: CardFacts): Pick<WorkerCard, 'status' | 'word' | 'doing' | 'since' | 'tool'> {
  const st = statusOf(s, f);
  return st.doing && !st.tool ? { ...st, doing: st.doing.charAt(0).toUpperCase() + st.doing.slice(1) } : st;
}

/** Its check-in's note in a few words, as the line under a "Back at …" status. */
const noteOf = (s: SessionInfo) => {
  const words = (s.wakeNote ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.length ? `Check-in: ${words.slice(0, 12).join(' ')}${words.length > 12 ? '…' : ''}` : 'Its own check-in';
};

function statusOf(s: SessionInfo, f: CardFacts): Pick<WorkerCard, 'status' | 'word' | 'doing' | 'since' | 'tool'> {
  const perm = s.pendingPermissions[0];
  if (perm || s.status === 'waiting_permission') return { status: 'needs_you', word: 'Needs you', doing: perm ? `Asks to use ${toolName(perm.toolName)}` : 'Asks for a permission', since: perm?.createdAt ?? s.lastActivityAt };
  const a = agentState(s, f.time, f.now);
  if (s.hostFailure) return { status: 'blocked', word: 'Blocked', doing: a.waitsOn, since: s.hostFailure.at };
  if (s.status === 'running' || s.status === 'starting') {
    const tool = s.activeTool;
    return {
      status: 'working',
      word: s.status === 'starting' ? 'Starting' : 'Working',
      ...(tool ? { doing: toolName(tool.name), tool: true } : { doing: s.status === 'starting' ? 'Starting up' : 'Thinking' }),
      since: s.turnOpenSince ?? s.lastActivityAt,
    };
  }
  if (f.waitsOn) {
    const mine = !!f.me && f.waitsOn.some((n) => n.toLowerCase() === f.me!.toLowerCase());
    return { status: 'waiting', word: mine ? 'Asked you' : `Waits on ${f.waitsOn.join(', ') || 'a person'}`, doing: s.waitingOn?.what, since: s.waitingOn?.at ?? lastSaid(s) };
  }
  if (f.liveUp && f.requester) {
    const mine = !!f.me && f.requester.toLowerCase() === f.me.toLowerCase();
    return { status: 'waiting', word: mine ? 'Asked you' : `Waits on ${f.requester}`, doing: 'Its Live view is up for the knobs', since: lastSaid(s) };
  }
  if (s.status === 'error') return { status: 'error', word: 'Error', doing: s.statusDetail, since: s.lastActivityAt };
  // Blocked on its request's gates (w754: CI, a pull request, another request), whatever check-in it left behind.
  if (f.live?.state === 'blocked' && f.work) {
    const gates = gatesOf(f.work);
    const at = gates.length ? new Date(Math.max(...gates.map((g) => Date.parse(g.at) || 0))).toISOString() : lastSaid(s);
    return { status: 'blocked', word: 'Blocked', doing: f.live.waitsOn?.length ? `Waits for ${f.live.waitsOn.join(' and ')}` : f.live.why, since: at };
  }
  const time = f.time ?? ((iso: string) => iso.slice(11, 16));
  const dueBack = () => ({ status: 'due_back' as const, word: `Back at ${time(s.wakeAt!, f.now)}`, doing: noteOf(s), since: lastSaid(s) });
  if (a.state === 'between_turns') {
    if (a.label === 'Queued') return { status: 'queued', word: 'Queued', doing: a.waitsOn, since: lastSaid(s) };
    if (a.label === 'Blocked') return { status: 'blocked', word: 'Blocked', doing: a.waitsOn, since: lastSaid(s) };
    // A job of its own still runs (CI, a build): work goes on. Only a check-in ahead: it is due back then.
    if (a.kind === 'timer' && s.wakeAt) return dueBack();
    return { status: 'working', word: 'Working', doing: a.waitsOn, since: lastSaid(s) };
  }
  if (f.live?.state === 'queued') return { status: 'queued', word: 'Queued', doing: f.live.why, since: lastSaid(s) };
  if (a.state === 'stopped' && a.resumes?.startsWith('check-in') && s.wakeAt) return dueBack();
  if (f.live?.state === 'stalled') return { status: 'stalled', word: 'Stalled', doing: `Its request is stalled: ${f.live.why}`, since: lastSaid(s) };
  if (a.state === 'stopped') {
    if (a.resumes) return { status: 'queued', word: 'Queued', doing: `Resumes with ${a.resumes}`, since: lastSaid(s) };
    return { status: 'stopped', word: 'Stopped', doing: a.held ? `Kept for it: ${a.held}` : undefined, since: lastSaid(s) };
  }
  return { status: 'idle', word: 'Idle', doing: f.live?.state === 'followup' ? 'Merged; its follow-up is pending' : undefined, since: lastSaid(s) };
}

/** The request's pull request worth a link: an open one first, else the newest. */
export function cardPr(prs: readonly WorkPr[] | undefined): WorkerCard['pr'] {
  const list = prs ?? [];
  const p = list.find((x) => x.state === 'open') ?? list.at(-1);
  return p && { repo: p.repo, number: p.number, url: p.url, state: p.state };
}

export interface CardInputs {
  work?: readonly WorkItem[];
  /** Live views the viewer may watch (the page passes none when Live view is off). */
  views?: readonly LiveViewInfo[];
  me?: string;
  now: number;
  time?: (iso: string, now: number) => string;
}

/**
 * One card per worker the machine view lists in its sandboxes (PlaceAgents.shown: those that matter now), from the fleet the
 * page already built. The request is the one the worker is the current worker of (ChatLedger.current), so the title, the
 * person, the PR and a Blocked or Queued state come from the ledger, as the machine view and the Dispatcher read it.
 */
export function workerCards(fleet: readonly FleetComputer[], x: CardInputs): WorkerCard[] {
  const sessions = fleet.flatMap((c) => c.sandboxes.flatMap((sb) => [...sb.agents.shown, ...sb.agents.older]));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ledger = chatLedger(x.work, byId, x.now);
  const live = workLiveAll(x.work ?? [], { session: (id) => byId.get(id), now: x.now });
  const workOf = new Map((x.work ?? []).map((w) => [w.id, w]));
  const cards: WorkerCard[] = [];
  for (const c of fleet) {
    for (const sb of c.sandboxes) {
      // A worker whose Live view is up is listed too: the machine view's slot calls its person with "Live view: go" (w1430).
      const streams = (s: SessionInfo) => !!x.views?.some((v) => v.sessionId === s.id && v.state !== 'stopped');
      for (const s of [...sb.agents.shown, ...sb.agents.older.filter(streams)]) {
        const wait = ledger.waits.get(s.id);
        const reqId = wait?.request ?? ledger.current.get(s.id)?.[0];
        const w = reqId ? workOf.get(reqId) : undefined;
        const requester = (s.lastRequestedBy ?? s.requestedBy)?.displayName;
        const st = cardStatus(s, { work: w, live: w ? live.get(w.id) : undefined, waitsOn: wait?.on, me: x.me, liveUp: streams(s), requester, now: x.now, time: x.time });
        const title = plainTitle(s.title) || (w ? plainTitle(w.title) : '') || s.title;
        cards.push({
          id: s.id,
          session: s,
          title,
          ...st,
          tone: CARD_STATUS_TONE[st.status],
          group: GROUP_OF[st.status],
          machineId: sb.machineId ?? c.key,
          machine: c.name,
          sandbox: sb.id,
          ...(w ? { request: w.id, requestTitle: w.title } : {}),
          ...((w?.requestedBy ?? s.requestedBy) ? { person: (w?.requestedBy ?? s.requestedBy)!.displayName } : {}),
          ...(w && cardPr(w.prs) ? { pr: cardPr(w.prs) } : {}),
          live: streams(s),
          costUsd: s.costUsd,
        });
      }
    }
  }
  return sortCards(cards);
}

/**
 * The board's order: by group (a person first, then working, then held up, then resting), then the status within it, then
 * the longest in that status first (who has waited longest on a person is the first to answer), then the session id, so
 * the cards keep their places between updates.
 */
export function sortCards<T extends Pick<WorkerCard, 'id' | 'status' | 'group' | 'since'>>(cards: readonly T[]): T[] {
  const g = (c: T) => CARD_GROUPS.indexOf(c.group);
  return [...cards].sort((a, b) => g(a) - g(b) || STATUS_RANK[a.status] - STATUS_RANK[b.status] || (Date.parse(a.since) || 0) - (Date.parse(b.since) || 0) || a.id.localeCompare(b.id));
}

/** The board's filters: groups picked (none: all), and one person and one machine (undefined: anyone, anywhere). */
export interface CardFilter {
  groups: CardGroup[];
  person?: string;
  machine?: string;
}

export const NO_FILTER: CardFilter = { groups: [] };

export function filterCards<T extends Pick<WorkerCard, 'group' | 'person' | 'machineId'>>(cards: readonly T[], f: CardFilter): T[] {
  return cards.filter((c) => (!f.groups.length || f.groups.includes(c.group)) && (!f.person || c.person?.toLowerCase() === f.person.toLowerCase()) && (!f.machine || c.machineId === f.machine));
}

/** How many cards each group holds, for the filter chips (before the group filter, after person and machine). */
export function groupCounts(cards: readonly Pick<WorkerCard, 'group'>[]): Record<CardGroup, number> {
  const n = { person: 0, working: 0, held: 0, resting: 0 };
  for (const c of cards) n[c.group]++;
  return n;
}

/** The Overview's header line in Workers mode, counted from the same cards as the chips: "26 workers · 13 working · 5 need a person · 6 held up". */
export function cardsSummary(cards: readonly Pick<WorkerCard, 'group'>[]): string {
  const n = groupCounts(cards);
  const parts = [`${cards.length} ${cards.length === 1 ? 'worker' : 'workers'}`, `${n.working} working`];
  if (n.person) parts.push(`${n.person} ${n.person === 1 ? 'needs' : 'need'} a person`);
  if (n.held) parts.push(`${n.held} held up`);
  return parts.join(' · ');
}

/** The people and machines on the cards, for the filter menus: each once, sorted by name. */
export function filterChoices(cards: readonly Pick<WorkerCard, 'person' | 'machineId' | 'machine'>[]): { people: string[]; machines: { id: string; name: string }[] } {
  const people = [...new Set(cards.map((c) => c.person).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b));
  const machines = [...new Map(cards.map((c) => [c.machineId, c.machine])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  return { people, machines };
}

// ---------------------------------------------------------------- remembered in the browser

/** The Overview's mode, kept in localStorage under OVERVIEW_MODE_KEY: the machine view unless Workers was picked. */
export type OverviewMode = 'machines' | 'workers';
export const OVERVIEW_MODE_KEY = 'ffsb.overview.mode';
export const OVERVIEW_FILTER_KEY = 'ffsb.overview.cardFilter';

export const readMode = (raw: string | null | undefined): OverviewMode => (raw === 'workers' ? 'workers' : 'machines');
/** What to store: nothing for the default, so a cleared browser and an untouched one read the same. */
export const writeMode = (m: OverviewMode): string | null => (m === 'workers' ? 'workers' : null);

export function readFilter(raw: string | null | undefined): CardFilter {
  try {
    const v = JSON.parse(raw ?? '') as Partial<CardFilter>;
    const groups = Array.isArray(v.groups) ? CARD_GROUPS.filter((g) => v.groups!.includes(g)) : [];
    return { groups, ...(typeof v.person === 'string' && v.person ? { person: v.person } : {}), ...(typeof v.machine === 'string' && v.machine ? { machine: v.machine } : {}) };
  } catch {
    return { groups: [] };
  }
}

export const writeFilter = (f: CardFilter): string | null => (!f.groups.length && !f.person && !f.machine ? null : JSON.stringify({ groups: CARD_GROUPS.filter((g) => f.groups.includes(g)), ...(f.person ? { person: f.person } : {}), ...(f.machine ? { machine: f.machine } : {}) }));
