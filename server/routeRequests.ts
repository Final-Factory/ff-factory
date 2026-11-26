import type { PendingPermission, Requester, SessionInfo, WorkItem, WorkSourceKind } from '../shared/types.ts';
import { routeBrief, routeLandedMessage, routeLine, routeTitle, triageRoute, type RouteNeed } from './bashNudge.ts';
import type { SessionHandle } from './sessions.ts';
import { capProblem } from './intakeRules.ts';
import { isOpen } from './work.ts';

/**
 * w5914, the route requests (docs/bash-nudge.md): a worker that answers FF Factory's shell nudge with "no other route" gets
 * its approval card (server/sessions.ts askPermission), and FF Factory files a request to build that route, once per need:
 *
 * - The need is named by `routeKey` (bashNudge.ts): the same program (and sub-command) asked by many workers is one request,
 *   each worker added to it as a waiter, its card linked in the logs of the request and of the worker's own requests.
 * - Triage (bashNudge.ts triageRoute): low risk goes ahead with no approval; anything else waits for a reviewer (lothsahn)
 *   on the Intake tab, its brief listing the options with the recommended one.
 * - Once the request is done and a later portal commit runs (its PR merged and deployed), every worker still waiting on the
 *   card for it is denied with the route to use, and that card clears. A worker is told this once per route; asked again,
 *   a person answers as before.
 *
 * Nothing here approves a command: it files, links, and denies.
 */

const KINDS: readonly WorkSourceKind[] = ['harness-route'];
/** At most this many route requests filed a day (a flood of distinct needs waits for the next day; the cards still go up). */
export const ROUTE_DAILY_CAP = 10;
/** A declined or cancelled route request settles its need this long: a worker asking again gets a person, not a new request. */
const DECIDED_MS = 30 * 86_400_000;
const WATCH_MS = 2 * 60_000;

export interface RouteRequestsDeps {
  store: { work: Map<string, WorkItem>; putWork(w: WorkItem): void };
  sessions: { events: { on(ev: 'permission', fn: (s: SessionHandle, p?: unknown) => void): unknown }; get(id: string): SessionHandle };
  orchestrators: {
    fileIntake(f: Parameters<import('./orchestrators.ts').Orchestrators['fileIntake']>[0]): { item?: WorkItem; skipped?: string };
    itemsOf(sessionId: string): WorkItem[];
    noteOnWork(w: WorkItem, line: string): void;
  };
  systemPayer(): Requester;
  lookbackDays(): number;
  /** The portal's running commit; without one no deploy can be seen, and the waiting cards stay with people. */
  portalSha(): string | undefined;
  now?: () => Date;
}

export class RouteRequests {
  private timer?: NodeJS.Timeout;
  private readonly d: RouteRequestsDeps;
  constructor(d: RouteRequestsDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? new Date();
  }

  start() {
    this.d.sessions.events.on('permission', (s, p) => {
      try {
        const asked = (p && typeof p === 'object' && 'requestId' in p ? (p as PendingPermission) : undefined) ?? s.info.pendingPermissions.at(-1);
        if (asked) this.onPermission(s, asked);
      } catch (e) {
        console.error('[routeRequests] permission', e);
      }
    });
    this.check();
    this.timer = setInterval(() => this.check(), WATCH_MS);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** The route request for a need: the newest one with its key. */
  routeFor(key: string): WorkItem | undefined {
    let best: WorkItem | undefined;
    for (const w of this.d.store.work.values()) {
      if (w.route?.key !== key || w.status === 'merged') continue;
      if (!best || Date.parse(w.createdAt) > Date.parse(best.createdAt)) best = w;
    }
    return best;
  }

  /** A worker's card that came with a "no other route" (PendingPermission.noRoute). */
  onPermission(s: SessionHandle, p: PendingPermission) {
    if (!p.noRoute || s.info.kind === 'orchestrator') return;
    const key = p.noRoute.key;
    const command = commandText(p.input);
    const works = this.d.orchestrators.itemsOf(s.info.id).filter(isOpen);
    const found = this.routeFor(key);
    const now = this.now();
    if (found?.route?.landed && found.route.line) {
      // The route is live: tell the worker once; it may still have a need the route does not cover, and then a person answers.
      if (!(found.route.told ?? []).includes(s.info.id)) {
        found.route.told = [...(found.route.told ?? []), s.info.id].slice(-200);
        this.d.store.putWork(found);
        s.decide(p.requestId, false, routeLandedMessage(found.id, found.route.line));
        this.d.orchestrators.noteOnWork(found, `told ${s.info.id} to use the route instead of: ${clip(command, 120)}`);
        return;
      }
    }
    if (found && (isOpen(found) || (found.status === 'done' && !found.route?.landed))) {
      this.addWaiter(found, s.info, p, command, works.map((w) => w.id));
      for (const w of works) this.d.orchestrators.noteOnWork(w, `${s.info.id}'s approval card for a ${p.toolName} command is linked to route request ${found.id} (w5914): ${clip(command, 120)}`);
      return;
    }
    if (found && !isOpen(found) && found.status !== 'done' && now.getTime() - Date.parse(found.updatedAt) < DECIDED_MS) {
      for (const w of works) this.d.orchestrators.noteOnWork(w, `${s.info.id}'s approval card for a ${p.toolName} command waits for a person; route request ${found.id} for it closed ${found.status} (w5914): ${clip(command, 120)}`);
      return;
    }
    this.file(s, p, key, command, works);
  }

  private file(s: SessionHandle, p: PendingPermission, key: string, command: string, works: WorkItem[]) {
    const reason = p.noRoute?.reason ?? 'the worker gave no reason';
    const need: RouteNeed = { key, toolName: p.toolName, command, reason, worker: `${s.info.id} "${clip(s.info.title, 80)}"`, requests: works.map((w) => w.id) };
    const t = triageRoute(command, reason);
    const now = this.now();
    const res = this.d.orchestrators.fileIntake({
      title: routeTitle(need),
      brief: routeBrief(need, t),
      source: { kind: 'harness-route', untrusted: false, channel: 'route request' },
      requestedBy: works[0]?.requestedBy ?? s.info.requestedBy ?? this.d.systemPayer(),
      priority: 'normal',
      autoApprove: { enabled: false, maxPerDay: 0 },
      approved: t.path === 'go',
      kinds: KINDS,
      lookbackDays: this.d.lookbackDays(),
      triage: t.path === 'go' ? { class: 'follow-up', reason: `w5914 route, low risk: ${t.why}` } : { class: 'needs-human', reason: `w5914 route that needs ${t.why.join('; ')}: lothsahn approves or picks an option (docs/bash-nudge.md, "Triage")` },
      limit: () => capProblem(this.d.store.work.values(), KINDS, ROUTE_DAILY_CAP, now.getTime()),
      uncapped: true,
    });
    if (!res.item) {
      for (const w of works) this.d.orchestrators.noteOnWork(w, `${s.info.id} said no other route does a ${p.toolName} command; no route request was filed (${res.skipped ?? 'refused'}); a person answers its card: ${clip(command, 120)}`);
      return;
    }
    const item = res.item;
    item.route = { key, triage: t.path, waiters: [] };
    this.addWaiter(item, s.info, p, command, works.map((w) => w.id));
    for (const w of works) this.d.orchestrators.noteOnWork(w, `${s.info.id} said no other route does a ${p.toolName} command; filed route request ${item.id} (w5914, ${t.path === 'go' ? 'low risk, goes ahead' : 'waits for approval'}); its approval card is linked to it: ${clip(command, 120)}`);
  }

  private addWaiter(w: WorkItem, s: SessionInfo, p: PendingPermission, command: string, works: string[]) {
    const r = w.route!;
    if (r.waiters.some((x) => x.requestId === p.requestId)) return;
    r.waiters = [...r.waiters, { session: s.id, requestId: p.requestId, command: clip(command, 400), ...(p.noRoute?.reason ? { reason: clip(p.noRoute.reason, 400) } : {}), works, at: this.now().toISOString() }].slice(-100);
    this.d.orchestrators.noteOnWork(w, `waiting on it: ${s.id}${works.length ? ` (${works.join(', ')})` : ''}, its approval card for: ${clip(command, 120)}`);
  }

  /**
   * The landing watch: a route request done is stamped with the portal's commit then; a different commit running later is
   * its deploy (as a blocker's deploy clears, shared/blockers.ts), and every worker still waiting on its card is denied
   * with the route. Runs at start and every two minutes.
   */
  check() {
    const sha = this.d.portalSha();
    if (!sha) return;
    for (const w of this.d.store.work.values()) {
      const r = w.route;
      if (!r) continue;
      if (w.status !== 'done') continue;
      if (!r.doneSha) {
        r.doneSha = sha;
        this.d.orchestrators.noteOnWork(w, `done; the waiting workers are told the route once a portal commit after ${sha.slice(0, 9)} runs`);
        continue;
      }
      if (!r.landed) {
        if (r.doneSha === sha) continue;
        r.landed = this.now().toISOString();
        // The worker's reports, newest first (a DONE's close note keeps only its first line), then the close note.
        r.line = routeLine([...(w.findings ?? [])].reverse().map((f) => f.text).concat(w.outcome ?? '').join('\n'), w.title);
        this.d.orchestrators.noteOnWork(w, `the route is deployed (portal ${sha.slice(0, 9)}): ${clip(r.line, 200)}`);
      }
      if (!r.waiters.length) continue;
      const left: typeof r.waiters = [];
      for (const x of r.waiters) {
        let s: SessionHandle | undefined;
        try {
          s = this.d.sessions.get(x.session);
        } catch {
          s = undefined;
        }
        if (!s || !s.info.pendingPermissions.some((pp) => pp.requestId === x.requestId)) continue;
        if (s.decide(x.requestId, false, routeLandedMessage(w.id, r.line!))) {
          r.told = [...(r.told ?? []), x.session].slice(-200);
          this.d.orchestrators.noteOnWork(w, `denied ${x.session}'s waiting approval with the new route: ${clip(x.command, 120)}`);
        } else left.push(x);
      }
      r.waiters = left;
      this.d.store.putWork(w);
    }
  }
}

function commandText(input: unknown): string {
  const c = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  return typeof c === 'string' ? c : JSON.stringify(input);
}

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
