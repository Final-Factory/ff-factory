/**
 * Game sandboxes go out by priority (w3507, lothsahn: "Can you please make sure sandbox availability is considered based on
 * priority by the dispatcher?"). w3496 (lothsahn's strut fix, high then urgent) sat Queued for over an hour while m5 had 3
 * sandboxes held, 1 of 3 agents mid-turn and no editor open: workers waiting on CI, a pair run or another request kept
 * them, and priority only ordered the queue.
 *
 * Queued game work with no computer that has room for it (`Pressure`) now frees a sandbox from a worker of strictly lower
 * priority, on a computer where one free sandbox is all it lacks:
 *
 * - **Reclaim** a holder that is not mid-turn (blocked, waiting on a person, a check-in ahead, stopped, idle): the release
 *   pass (server/placeAgain.ts) stops it and releases its sandbox as for any release (w640, w656): its worktree clean or
 *   saved by its daemon and pushed, its branch kept in the machine's repository. It resumes like any released worker when
 *   its gate, check-in or a message comes, on its own branch, but not while higher queued work wants that computer.
 * - **Pre-empt** a mid-turn low or normal worker, for urgent work only and only when nothing is reclaimable: it is told
 *   (preemptNotice) to finish the step it is on, commit and push and end its turn; it is never interrupted, so a git
 *   command, a merge or a push is never cut. Its turn's end makes it reclaimable, and a message waits to resume it.
 *
 * Equal priority never takes from equal. A worker reclaimed is not taken from again for RECLAIM_PROTECT_MS after it was
 * placed again. What never moves (`blocked`): a pair run's leg, a timed leg, the release lane's builder or the nightly, a
 * person-approved bench turn, a bench lock or a Unity batch run or player of its sandbox, a Live view, a check-in with its
 * editor up, a background job, a worker starting or being moved. docs/machines.md, "Placing work".
 */
import { WORK_PRIORITIES, type SessionInfo, type WorkPriority } from '../shared/types.ts';

/**
 * How long a worker that was reclaimed or pre-empted is not taken from again, counted from when it was placed again. A move
 * costs about 2.5 min (measured, placeAgain.ts RELEASE_AFTER_MS: an editor stop, a switch, a warm editor start, a
 * recompile); half an hour caps it at two moves an hour, under a tenth of its time, the margin RELEASE_AFTER_MS uses.
 */
export const RECLAIM_PROTECT_MS = 30 * 60_000;

/**
 * How long a reclaim made for a request stands before another may be made for it: the release takes one or two passes (a
 * minute each), then the capacity ping's quiet spell and a dispatcher turn place the request. Past this, with the request
 * still Queued and no room, the sandbox went elsewhere and another is freed.
 */
export const RECLAIM_STANDS_MS = 15 * 60_000;

/** How long a pre-empted worker has to reach a safe point and end its turn before another worker may be asked instead. */
export const PREEMPT_STANDS_MS = 30 * 60_000;

/** urgent 3, high 2, normal 1, low 0; a worker with no open request -1. */
export const rankOf = (p: WorkPriority | undefined): number => (p ? WORK_PRIORITIES.indexOf(p) : -1);

/** The highest priority of `ps`, or undefined for none. */
export const topPriority = (ps: readonly (WorkPriority | undefined)[]): WorkPriority | undefined => ps.reduce<WorkPriority | undefined>((a, p) => (rankOf(p) > rankOf(a) ? p : a), undefined);

/** Queued game work and the computers one free sandbox would make room on for it (Agents.reclaimPressure). */
export interface Pressure {
  work: string;
  title: string;
  priority: WorkPriority;
  /** Whether a computer has room for it now: then it frees nothing, and only holds lower released workers back (claims). */
  room: boolean;
  /** Computers where a free sandbox is all it lacks (online, not held or paused, not reserved above its priority, it fits). */
  machines: string[];
  /** Computers where a free sandbox and one more agent slot are all it lacks: where a pre-emption makes room (urgent only). */
  preemptOn: string[];
  /**
   * w3522: computers left out of `machines` and `preemptOn` because a sandbox freed there would be held for other work (an
   * older pair run, w1945, or timed work on a small computer, w1995), each as "<machine>: <why>", for the Queued line.
   */
  held?: string[];
}

/** One occupied sandbox as reclaim sees it. */
export interface SandboxHolders {
  machine: string;
  sandbox: string;
  /** Its occupants (Agents placeAgain occupies), not released. */
  sessions: SessionInfo[];
  /** The highest open priority among them. */
  priority: WorkPriority | undefined;
  /** Whether any of them is mid-turn (or has a permission open). */
  midTurn: boolean;
  /** Why none of it may be taken now, or undefined. */
  blocked?: string;
  /** The latest activity of its occupants (ms): the longest idle goes first. */
  activeAt: number;
  editorStopped: boolean;
}

export type ReclaimPick = { reclaim: SandboxHolders } | { preempt: SandboxHolders } | { none: string };

/** Whether `s` is within its protection after a reclaim or pre-emption (RECLAIM_PROTECT_MS), and until when. */
export function protectedUntil(s: Pick<SessionInfo, 'reclaimed'>): number | undefined {
  const r = s.reclaimed;
  if (!r) return undefined;
  const from = Math.max(Date.parse(r.at) || 0, Date.parse(r.backAt ?? '') || 0);
  return from + RECLAIM_PROTECT_MS;
}

const order = (a: SandboxHolders, b: SandboxHolders) => rankOf(a.priority) - rankOf(b.priority) || a.activeAt - b.activeAt || Number(b.editorStopped) - Number(a.editorStopped) || `${a.machine}/${a.sandbox}`.localeCompare(`${b.machine}/${b.sandbox}`);

/**
 * Which sandbox queued work `p` takes, or why none: the lowest-priority holder first, then the longest idle, then one whose
 * editor is stopped (cheapest to restore); only strictly lower priority, never blocked or protected ones. A mid-turn holder
 * only for urgent work, only low or normal, only where nothing is reclaimable, and only on a computer in `preemptOn`.
 */
export function pickReclaim(p: Pick<Pressure, 'priority' | 'machines' | 'preemptOn' | 'held'>, sbs: readonly SandboxHolders[]): ReclaimPick {
  const mine = sbs.filter((x) => p.machines.includes(x.machine) || p.preemptOn.includes(x.machine));
  const held = p.held?.length ? `; ${p.held.slice(0, 2).join('; ')}${p.held.length > 2 ? `; and ${p.held.length - 2} more held` : ''}` : '';
  if (!p.machines.length && !p.preemptOn.length) return { none: p.held?.length ? `a sandbox freed for it would be held for other work: ${p.held.slice(0, 2).join('; ')}${p.held.length > 2 ? `; and ${p.held.length - 2} more` : ''}` : 'no computer it can run on lacks only a free sandbox (offline, held, paused, short of RAM or agent slots, or it does not fit there)' };
  const why = new Map<string, string>();
  const ok: SandboxHolders[] = [];
  for (const x of mine) {
    const key = `${x.machine}/${x.sandbox}`;
    if (x.blocked) why.set(key, x.blocked);
    else if (rankOf(x.priority) >= rankOf(p.priority)) why.set(key, `its work is ${x.priority}, not lower than ${p.priority}`);
    else ok.push(x);
  }
  const idle = ok.filter((x) => !x.midTurn && p.machines.includes(x.machine)).sort(order)[0];
  if (idle) return { reclaim: idle };
  if (p.priority === 'urgent') {
    const mid = ok.filter((x) => x.midTurn && rankOf(x.priority) <= rankOf('normal') && (p.preemptOn.includes(x.machine) || p.machines.includes(x.machine))).sort(order)[0];
    if (mid) return { preempt: mid };
  }
  for (const x of ok) if (x.midTurn) why.set(`${x.machine}/${x.sandbox}`, p.priority === 'urgent' ? `mid-turn on ${x.priority} work, which only urgent work pre-empts, and only low or normal` : `mid-turn (only urgent work pre-empts a turn)`);
  const lines = [...why].map(([k, v]) => `${k}: ${v}`);
  return { none: (lines.length ? `no sandbox it may take: ${lines.slice(0, 4).join('; ')}${lines.length > 4 ? `; and ${lines.length - 4} more` : ''}` : `no occupied sandbox on ${[...new Set([...p.machines, ...p.preemptOn])].join(', ')}`) + held };
}

/** What a mid-turn worker is told when urgent work pre-empts it (once). */
export function preemptNotice(p: Pick<Pressure, 'work' | 'title' | 'priority'>, sandbox: string, requests: readonly string[]): string {
  const example = requests[0] ?? 'wNNN';
  return [
    `[FF Factory] PRE-EMPTED (w3507): urgent work ${p.work} ("${p.title}") is Queued and no sandbox is free for it, so your sandbox ${sandbox} goes to it. You are not stopped and lose nothing:`,
    '1. Finish the step you are on, at a safe point: never stop in the middle of a git command, a merge, a push or a release step, and finish a merge or release you have started. Start no new compile, test run, build or batch Unity run.',
    '2. Commit what is unfinished on your branch (a WIP commit is fine) and push it. Stop your sandbox\'s Unity editor (mcp__machine__unity stop) and any player or batch run you started.',
    `3. End your turn with one line per request: \`${example}: paused for urgent ${p.work}; <where you stopped>\`. Set no wake_me and no blocked_on for it.`,
    'FF Factory then releases your sandbox and a message resumes you, in this same conversation and on your branch (perhaps in another sandbox on this computer; the message says where), as soon as a sandbox is free and no higher work waits for it.',
  ].join('\n');
}

/** The message that resumes a pre-empted worker once its sandbox was released (it waits in the send queue until it is placed). */
export const preemptResume = (work: string) => `[FF Factory] Carry on (w3507): you were paused for urgent ${work}, which has its sandbox now. You are placed again on your branch; carry on where you stopped.`;
