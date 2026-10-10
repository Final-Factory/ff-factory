import { useEffect, useMemo, useState } from 'react';
import type { AppState, IntakeSummary, WorkItem, WorkSource } from '../../../shared/types';
import { decisionOf } from '../../../shared/decision';
import { api } from '../api';
import { isMine, ledgerOrder } from '../../../shared/workOrder';
import { WORK_LIVE_LABEL, WORK_LIVE_STATES, liveCounts, workLiveAll, type WorkLive, type WorkLiveState } from '../../../shared/workState';
import { gatesName, gatesOf } from '../../../shared/blockers';
import { FFBOX_LAN_LABEL, ffboxConversationHref, isFfboxConversationId } from '../../../shared/ffboxLinks';
import { sessionRoute } from '../attention';
import { attempt, reloadTranscript, sessionsByIds, toast } from '../store';
import { CostChip, RequestSpendBlock, SpendTab, useSpendSummary } from './Spend';
import { contextGlance, dispatcherGlance, fmtCost, fmtRelative, href, isBusy, isOpenWork, lsGet, lsSet, navigate, useNow, workLabel, workTone, type Tone } from '../util';
import { Markdown } from './Markdown';
import { SessionView } from './SessionView';
import { accountOf } from './SystemMeters';
import { Chip, Confirm, Dot, Icon, Menu } from './ui';
import { TimersButton } from './Timers';

type Tab = 'requests' | 'intake' | 'spend' | 'conversation';

const names = (w: WorkItem) => w.requesters.map((r) => r.displayName).join(', ');

/** "Discord bug", "Discord request", "FFBox branch", …: where an intake request came from (docs/intake.md). */
export function sourceLabel(s: WorkSource): string {
  switch (s.kind) {
    case 'discord-bug':
      return 'Discord bug';
    case 'discord-request':
      return `Discord request${s.reporter ? ` from ${s.reporter}` : ''}`;
    case 'ffbox-branch':
      return 'FFBox branch';
    case 'ffbox-diagnosis':
      return 'FFBox diagnosis';
    case 'ffbox-request':
      return 'FFBox request';
    case 'ffbox-dev':
      return `FFBox dev request${s.reporter ? ` from ${s.reporter}` : ''}`;
    case 'release':
      return 'Release follow-up';
    case 'nightly':
      return `Nightly e2e${s.nightly?.date ? ` ${s.nightly.date}` : ''}`;
    case 'nightly-run':
      return `Nightly run${s.nightlyRun?.date ? ` ${s.nightlyRun.date}` : ''}`;
  }
}

const pendingApproval = (w: WorkItem) => w.approval?.state === 'pending' && isOpenWork(w);

/** The triage in two words: "obvious bug", "needs a human", "asked by a person", "follow-up". */
export const triageLabel: Record<NonNullable<WorkItem['triage']>['class'], string> = {
  'obvious-bug': 'obvious bug',
  'needs-human': 'needs a human',
  person: 'asked by a person',
  'follow-up': 'follow-up',
  regression: 'nightly regression',
  'ffbox-desync': 'FFBox desync PR',
};

/** What a pending intake request waits for, as its status reads. */
const waitingLabel = (w: WorkItem) => (w.triage?.class === 'needs-human' ? 'Needs a human' : 'Awaiting approval');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A row's status in words (w319): "Needs a human" only while it waits; then who approved or declined it and when, or that
 * it closed by itself. Past approval, a working or finished request shows its status and the approval after it.
 */
function statusText(w: WorkItem): string {
  const d = decisionOf(w);
  if (w.autoClosed) return 'Auto-closed';
  if (pendingApproval(w)) return waitingLabel(w);
  if (!d) return workLabel[w.status];
  if (d.state === 'declined') return cap(d.text);
  if (d.state === 'approved' || d.state === 'auto-approved') return w.status === 'new' || w.status === 'queued' ? cap(d.text) : `${workLabel[w.status]} · ${d.text}`;
  return workLabel[w.status];
}

/** Where the dispatcher's input would be: nobody chats with it, a person talks to their own orchestrator (docs/orchestrators.md). */
function TalkToYourOrchestrator() {
  return (
    <>
      Nobody writes to the dispatcher.{' '}
      <a href={href({ view: 'home' })} data-testid="talk-to-orchestrator">
        Talk to your orchestrator
      </a>
      : it files work with the dispatcher for you.
    </>
  );
}

/**
 * The dispatcher (docs/orchestrators.md): the ledger of everyone's requests with what was decided and who works on
 * them, the intake from Discord and FFBox (docs/intake.md), and its conversation, which only the owner writes to.
 * `tab`: "intake", "conversation", or a request id to open.
 */
export function DispatcherPanel({ app, tab, onClose }: { app: AppState; tab?: string; onClose?: () => void }) {
  const now = useNow(15_000);
  const [confirmReset, setConfirmReset] = useState(false);
  const session = app.sessions.find((s) => s.id === app.dispatcherId);
  // Open requests first (questions, new, queued, active), then the closed ones; the viewer's own first within each (shared/workOrder.ts).
  const work = ledgerOrder(app.work ?? [], app.me?.userId);
  const open = work.filter(isOpenWork);
  const stalled = work.filter((w) => w.status === 'stalled');
  const closed = work.filter((w) => !isOpenWork(w) && w.status !== 'stalled');
  const current: Tab = tab === 'conversation' ? 'conversation' : tab === 'intake' ? 'intake' : tab === 'spend' ? 'spend' : 'requests';
  const focus = tab && /^w\d+$/.test(tab) ? tab : undefined;
  const setTab = (t: Tab) => navigate({ view: 'dispatcher', tab: t === 'requests' ? undefined : t }, true);
  const owner = app.me?.role === 'owner';
  const glance = dispatcherGlance(session, open, app.me?.userId);
  const account = session ? accountOf(app, session.id) : undefined;
  // Its context and last compaction (w535).
  const ctx = session ? contextGlance(session, now) : undefined;
  const waiting = work.filter((w) => w.source && pendingApproval(w)).length;

  return (
    <section className="sb-panel sa-panel dispatcher-panel">
      <header className="sb-head">
        <div className="sb-head-top">
          {onClose && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="back" />
            </button>
          )}
          <Dot tone={glance.tone} pulse={isBusy(session)} />
          <h2 className="ellipsis">Dispatcher</h2>
          <div className="spacer" />
          {ctx && (
            <span className="hb-on hide-phone" title={ctx.line} data-testid="context-size">
              Context {ctx.short}
            </span>
          )}
          {owner && session && <TimersButton sessionId={session.id} label="Dispatcher" />}
          {owner && session && (
            <Menu label="Dispatcher options">
              {(close) => (
                <>
                  <button
                    className="menu-item"
                    onClick={() => {
                      close();
                      setConfirmReset(true);
                    }}
                  >
                    <Icon name="plus" size={15} /> New conversation…
                  </button>
                  <button
                    className="menu-item"
                    title="Summarise the dispatcher's conversation so far, so each of its turns costs less"
                    onClick={async () => {
                      close();
                      const ok = await attempt(api.compact(session.id));
                      if (ok?.note) toast(ok.note);
                    }}
                  >
                    <Icon name="refresh" size={15} /> Compact conversation
                  </button>
                  <div className="menu-foot">
                    {session.model ?? 'default model'}
                    {account ? ` on ${account.label}` : ''} · {fmtCost(session.costUsd)} over {session.turns} turns · active {fmtRelative(session.lastActivityAt, now)}
                    {ctx && (
                      <>
                        <br />
                        {ctx.line}
                      </>
                    )}
                  </div>
                </>
              )}
            </Menu>
          )}
        </div>
        <p className="sb-head-purpose">Everyone’s requests for work, what was decided, and who is on them.</p>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'requests'} className={`tab${current === 'requests' ? ' active' : ''}`} onClick={() => setTab('requests')}>
          Requests <span className="dim">{open.length}</span>
        </button>
        {app.intake && (
          <button role="tab" aria-selected={current === 'intake'} className={`tab${current === 'intake' ? ' active' : ''}`} onClick={() => setTab('intake')}>
            Intake {waiting > 0 && <span className="tone-amber" title="Needs a human">{waiting}</span>}
          </button>
        )}
        <button role="tab" aria-selected={current === 'spend'} className={`tab${current === 'spend' ? ' active' : ''}`} onClick={() => setTab('spend')}>
          Spend
        </button>
        <button role="tab" aria-selected={current === 'conversation'} className={`tab${current === 'conversation' ? ' active' : ''}`} onClick={() => setTab('conversation')}>
          Conversation
        </button>
      </nav>

      {current === 'requests' && <Requests app={app} work={work} open={open} stalled={stalled} closed={closed} focus={focus} now={now} />}
      {current === 'intake' && app.intake && <IntakeTab app={app} intake={app.intake} work={work} now={now} />}
      {current === 'spend' && <SpendTab />}
      {current === 'conversation' &&
        (session ? (
          <SessionView key={session.id} session={session} embedded readOnly={<TalkToYourOrchestrator />} answeredBy={owner ? undefined : 'the owner'} />
        ) : (
          <div className="panel-empty">
            <p>No dispatcher yet.</p>
          </div>
        ))}

      {confirmReset && (
        <Confirm
          title="Start the dispatcher afresh?"
          confirmLabel="New conversation"
          body="The dispatcher forgets its conversation. The requests, sandboxes and agents all stay, and it is told which requests still wait for it."
          onConfirm={async () => {
            const ok = await attempt(api.resetOrchestrator('dispatcher'));
            if (ok !== undefined) reloadTranscript(ok.id);
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </section>
  );
}

/** A live state's tone: working blue, waiting on input amber, queued grey, blocked violet, merged with a follow-up green, stalled red. */
const LIVE_TONE: Record<WorkLiveState, Tone> = { working: 'blue', waiting: 'amber', queued: 'grey', blocked: 'violet', followup: 'green', stalled: 'red' };

/**
 * What each open or stalled request is doing now (shared/workState.ts, w418), from the page's own sessions: it follows
 * them live. A message held in the send queue shows from the session's own copy (queuedSend), and a Queued request
 * while a computer has room is flagged from the server's `room` (w643).
 */
export function useWorkLive(app: AppState, work: readonly WorkItem[], now: number): Map<string, WorkLive> {
  return useMemo(() => {
    const byId = new Map(app.sessions.map((s) => [s.id, s]));
    return workLiveAll(work, { session: (id) => byId.get(id), ...(app.room ? { room: app.room } : {}), now });
  }, [app.sessions, app.room, work, now]);
}

/** The live states picked on one list, kept in this browser across reloads (w418, Lothsahn: "select multiple types"). */
function usePickedStates(key: string): [ReadonlySet<WorkLiveState>, (next: ReadonlySet<WorkLiveState>) => void] {
  const storage = `ffsb.ledgerStates.${key}`;
  const [picked, setPicked] = useState<ReadonlySet<WorkLiveState>>(() => new Set((lsGet(storage) ?? '').split(',').filter((s): s is WorkLiveState => (WORK_LIVE_STATES as readonly string[]).includes(s))));
  const set = (next: ReadonlySet<WorkLiveState>) => {
    setPicked(next);
    lsSet(storage, WORK_LIVE_STATES.filter((s) => next.has(s)).join(','));
  };
  return [picked, set];
}

/**
 * One toggle chip per live state with its count; several can be on at once. "All" (or "Clear") turns them all off,
 * which shows the usual list. A picked state with no request now stays shown, so it can be turned off.
 */
function StateFilter({ live, picked, onChange, testId }: { live: ReadonlyMap<string, WorkLive>; picked: ReadonlySet<WorkLiveState>; onChange: (next: ReadonlySet<WorkLiveState>) => void; testId: string }) {
  const n = liveCounts(live.values());
  const toggle = (s: WorkLiveState) => {
    const next = new Set(picked);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onChange(next);
  };
  return (
    <div className="ledger-states" role="toolbar" aria-label="Show requests by what they are doing now (pick several)" data-testid={testId}>
      <button className={`ledger-state${picked.size === 0 ? ' on' : ''}`} aria-pressed={picked.size === 0} onClick={() => onChange(new Set())} data-testid="ledger-state-all">
        All <span className="mono">{live.size}</span>
      </button>
      {WORK_LIVE_STATES.filter((s) => n[s] || picked.has(s)).map((s) => (
        <button key={s} className={`ledger-state${picked.has(s) ? ' on' : ''}`} aria-pressed={picked.has(s)} onClick={() => toggle(s)} data-testid={`ledger-state-${s}`}>
          <Dot tone={LIVE_TONE[s]} /> {WORK_LIVE_LABEL[s]} <span className="mono">{n[s]}</span>
        </button>
      ))}
      {picked.size > 0 && (
        <button className="link-btn small" onClick={() => onChange(new Set())} data-testid="ledger-state-clear">
          Clear
        </button>
      )}
    </div>
  );
}

const pickedLabel = (picked: ReadonlySet<WorkLiveState>) => WORK_LIVE_STATES.filter((s) => picked.has(s)).map((s) => WORK_LIVE_LABEL[s].toLowerCase()).join(' or ');

function Requests({ app, work, open, stalled, closed, focus, now }: { app: AppState; work: WorkItem[]; open: WorkItem[]; stalled: WorkItem[]; closed: WorkItem[]; focus?: string; now: number }) {
  const live = useWorkLive(app, work, now);
  const [picked, setPicked] = usePickedStates('requests');
  const only = picked.size > 0;
  const [expanded, setExpanded] = useState<string | null>(focus ?? null);
  const [showClosed, setShowClosed] = useState(() => !!focus && closed.some((w) => w.id === focus));
  const [showStalled, setShowStalled] = useState(() => !!focus && stalled.some((w) => w.id === focus));
  const [cleaning, setCleaning] = useState(false);
  const ledger = app.ledger;
  useEffect(() => {
    if (!focus) return;
    setExpanded(focus);
    if (closed.some((w) => w.id === focus)) setShowClosed(true);
    if (stalled.some((w) => w.id === focus)) setShowStalled(true);
    requestAnimationFrame(() => document.getElementById(`work-${focus}`)?.scrollIntoView({ block: 'nearest' }));
    // The focus comes from a link (a notice in a chat): open it once, then leave the rows to the user.
  }, [focus]);

  if (!open.length && !closed.length && !stalled.length) {
    return (
      <div className="panel-empty">
        <Icon name="inbox" size={28} />
        <p>No requests yet.</p>
        <p className="dim small">When someone asks their orchestrator for work, the request shows here with what the dispatcher decided.</p>
      </div>
    );
  }
  const row = (w: WorkItem) => <WorkRow key={w.id} app={app} w={w} live={live.get(w.id)} open={expanded === w.id} onToggle={() => setExpanded(expanded === w.id ? null : w.id)} now={now} />;
  // States picked: every open and stalled request in one of them, whatever its stored status.
  const shown = only ? [...open, ...stalled].filter((w) => picked.has(live.get(w.id)?.state as WorkLiveState)) : [];
  return (
    <div className="sa-scroll">
      {live.size > 0 && <StateFilter live={live} picked={picked} onChange={setPicked} testId="ledger-states" />}
      {only ? (
        shown.length ? <div className="run-list" data-testid="ledger-picked">{shown.map(row)}</div> : <p className="dim small ledger-none">None {pickedLabel(picked)} now.</p>
      ) : open.length ? (
        <div className="run-list">{open.map(row)}</div>
      ) : (
        <p className="dim small ledger-none">Nothing open.</p>
      )}
      {!only && stalled.length > 0 && (
        <>
          <button className="link-btn small ledger-closed" data-testid="stalled-filter" onClick={() => setShowStalled(!showStalled)} aria-expanded={showStalled}>
            {showStalled ? 'Hide stalled by the cleanup' : `${stalled.length} stalled by the cleanup`}
          </button>
          {showStalled && (
            <>
              <p className="dim small ledger-none">Nothing is working on these. The cleanup never closes them on its own: close or reopen each (tell your orchestrator, or write a note on it to revive it).</p>
              <div className="run-list" data-testid="stalled-list">{stalled.map(row)}</div>
            </>
          )}
        </>
      )}
      {!only && closed.length > 0 && (
        <>
          <button className="link-btn small ledger-closed" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed}>
            {showClosed ? 'Hide closed' : `${closed.length} closed`}
          </button>
          {showClosed && <div className="run-list">{closed.map(row)}</div>}
        </>
      )}
      {ledger?.enabled && (
        <p className="dim small ledger-none" data-testid="ledger-cleanup">
          Cleanup every {ledger.everyHours} h: {ledger.lastRunAt ? `last ${fmtRelative(ledger.lastRunAt, now)}, ${ledger.lastSummary ?? 'nothing to do'}` : 'not run yet'}.{' '}
          {app.me?.role === 'owner' && (
            <button
              className="link-btn small"
              disabled={cleaning || ledger.running}
              onClick={async () => {
                setCleaning(true);
                const r = await attempt(api.ledgerCleanup());
                setCleaning(false);
                if (r?.summary) toast(`Cleanup: ${r.summary}`);
              }}
            >
              Clean up now
            </button>
          )}
        </p>
      )}
    </div>
  );
}

const onOff = (on: boolean) => (on ? 'on' : 'off');

/**
 * The intake (docs/intake.md): what is switched on, today's numbers, the Discord and FFBox requests waiting for a
 * person's approval (Approve / Decline), those already in the ledger with their state and how the fix reaches players,
 * and what the intake saw lately. The settings are config.json's; this page only shows them.
 */
function IntakeTab({ app, intake: s, work, now }: { app: AppState; intake: IntakeSummary; work: WorkItem[]; now: number }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = work.filter((w) => w.source);
  const pending = items.filter(pendingApproval);
  const reviewer = !!app.me && s.reviewerIds.some((id) => id.toLowerCase() === app.me!.userId.toLowerCase());
  const auto = items.filter((w) => w.autoClosed).sort((a, b) => b.autoClosed!.at.localeCompare(a.autoClosed!.at));
  const rest = items.filter((w) => !pendingApproval(w) && !w.autoClosed);
  const anyOn = s.discord.enabled || s.ffbox.enabled || s.release.enabled || !!s.nightly?.enabled;
  const act = async (id: string, f: () => Promise<unknown>) => {
    setBusy(id);
    await attempt(f());
    setBusy(null);
  };
  const live = useWorkLive(app, work, now);
  const [picked, setPicked] = usePickedStates('intake');
  // The ledger list's filter counts only its own (intake) requests.
  const restLive = new Map([...live].filter(([id]) => rest.some((w) => w.id === id)));
  const restShown = picked.size ? rest.filter((w) => picked.has(live.get(w.id)?.state as WorkLiveState)) : rest;
  const row = (w: WorkItem) => <WorkRow key={w.id} app={app} w={w} live={live.get(w.id)} open={expanded === w.id} onToggle={() => setExpanded(expanded === w.id ? null : w.id)} now={now} />;
  const d = s.discord;
  const f = s.ffbox;
  const n = s.nightly;
  return (
    <div className="sa-scroll intake-tab" data-testid="intake-tab">
      <section className="intake-settings" data-testid="intake-settings">
        <div className="intake-source">
          <Chip tone={d.enabled ? 'green' : 'grey'}>Discord {onOff(d.enabled)}</Chip>
          <span className="dim small">
            bug reports from {d.bugChannels.map((c) => `#${c.replace(/_/g, '-')}`).join(', ') || 'no channel'}{d.ffboxOwned?.length ? ` (${d.ffboxOwned.map((c) => `#${c.replace(/_/g, '-')}`).join(', ')}: FFBox's, never filed from)` : ''}; requests to Max in {d.requestChannels.map((c) => `#${c.replace(/_/g, '-')}`).join(', ') || 'no channel'} from {d.trustedPeople.length ? d.trustedPeople.join(', ') : 'nobody trusted yet'}; at most {d.dailyCap} a day, {d.perReporterPerDay} per reporter; auto-approve {d.autoApprove.enabled ? `on, ${d.autoApprove.maxPerDay} a day${!d.autoApprove.bugs ? ', not bug reports' : ''}${!d.autoApprove.requests ? ', not requests' : ''}` : 'off'}
            {d.polledAt ? `; checked ${fmtRelative(d.polledAt, now)}` : ''}
          </span>
        </div>
        <div className="intake-source">
          <Chip tone={f.enabled ? 'green' : 'grey'}>FFBox {onOff(f.enabled)}</Chip>
          <span className="dim small">
            fix branches {onOff(f.branches)}, diagnoses {onOff(f.diagnoses)}, its own requests {onOff(f.requests)}, its ledger check {onOff(f.boardCheck)}, sending it work {onOff(f.sendWork)}; at most {f.dailyCap} a day; auto-approve {f.autoApprove.enabled ? `on, ${f.autoApprove.maxPerDay} a day` : 'off'}
            {f.desync ? `; desync PRs ${f.desync.enabled ? `approved at once under the desync PR policy, ${f.desync.maxPerDay} a day` : 'off (the usual triage)'}` : ''}
          </span>
        </div>
        <div className="intake-source">
          <Chip tone={s.release.enabled ? 'green' : 'grey'}>Release follow-ups {onOff(s.release.enabled)}</Chip>
          <span className="dim small">
            a “live in {s.release.lastVersion ?? '<version>'}” reply {s.release.delayMinutes} min after the release that carries each fix{s.release.checkedAt ? `; checked ${fmtRelative(s.release.checkedAt, now)}` : ''}
          </span>
        </div>
        {n && (
          <div className="intake-source">
            <Chip tone={n.enabled ? 'green' : 'grey'}>Nightly e2e {onOff(n.enabled)}</Chip>
            <span className="dim small">
              new regressions, and scenarios flaky {n.flakyNights} nights running, from the lab's report; more than {n.batchOver} in a night become one request; at most {n.dailyCap} a day; auto-approve {n.autoApprove.enabled ? `on, ${n.autoApprove.maxPerDay} a day` : 'off'}
              {n.last ? `; last report ${n.last.date} from ${n.last.lab} (develop ${n.last.sha.slice(0, 9)}): ${n.last.filed} filed, ${n.last.attached} added to open requests, ${n.last.skipped} skipped` : ''}
            </span>
          </div>
        )}
        {n?.run && (
          <div className="intake-source" data-testid="nightly-run">
            <Chip tone={n.run.enabled ? 'green' : 'grey'}>Nightly run {onOff(n.run.enabled)}</Chip>
            <span className="dim small">
              the portal starts the lab every night at {n.run.time} {n.run.tz} on {n.run.machine}
              {n.run.person ? ` for ${n.run.person}` : ''}; no report within {n.run.reportWithinHours} h is an alarm{n.run.next ? `; next ${fmtRelative(n.run.next, now)}` : ''}
            </span>
          </div>
        )}
        {!!n?.nights?.length && (
          <ul className="small intake-nights" data-testid="nightly-nights">
            {n.nights.map((x) => (
              <li key={x.date}>
                <Chip tone={x.status === 'passed' ? 'green' : x.status === 'running' ? 'grey' : 'red'}>{x.date} {x.status}</Chip>{' '}
                <span className="dim">
                  {x.counts ? `${x.counts.passed} of ${x.counts.ran} passed${x.counts.failed ? `, ${x.counts.failed} failed` : ''}${x.counts.flaky ? `, ${x.counts.flaky} flaky` : ''}` : ''}
                  {x.cause ? ` ${x.cause}` : ''}
                  {x.sha ? ` (develop ${x.sha.slice(0, 9)})` : ''}
                  {x.workId ? ` run ${x.workId}` : ''}
                  {x.work?.length ? `; filed on ${x.work.join(', ')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="dim small">
          Today: {s.today.filed} filed, {s.today.autoApproved} auto-approved, {s.today.skipped} skipped, {s.today.pending} need a human. Reviewers (approve, decline, answer design questions): {s.reviewers.join(', ') || 'the owner'}. Only obvious bugs and nightly regressions are ever worked without them, and only with their auto-approve on.{' '}
          {anyOn ? 'Settings live in config.json, "intake".' : 'Everything is off: switch it on in config.json, "intake" (docs/intake.md).'}
        </p>
        {d.error && <p className="small tone-red">Last problem: {d.error}</p>}
        {d.enabled && (
          <button className="btn btn-sm btn-outline" disabled={busy === 'poll'} onClick={() => void act('poll', () => api.intakePoll())}>
            <Icon name="refresh" size={14} /> Check Discord now
          </button>
        )}
      </section>

      <h3 className="intake-h">Needs a human</h3>
      <p className="dim small ledger-none">
        Player reports that are not obvious bugs, design questions and FFBox work wait here. Nothing is worked until {s.reviewers.join(' or ') || 'a reviewer'} approves it (then the dispatcher decides it like any request) or declines it.
      </p>
      {pending.length ? (
        <div className="run-list">
          {pending.map((w) => (
            <div key={w.id} className="intake-pending">
              {row(w)}
              <div className="intake-actions">
                <span className="dim small">{w.approval?.why}</span>
                <div className="spacer" />
                {reviewer ? (
                  <>
                    <button className="btn btn-sm btn-primary" disabled={busy === w.id} onClick={() => void act(w.id, () => api.approveWork(w.id))}>
                      Approve {w.id}
                    </button>
                    <button className="btn btn-sm btn-ghost" disabled={busy === w.id} onClick={() => void act(w.id, () => api.declineWork(w.id))}>
                      Decline
                    </button>
                  </>
                ) : (
                  <span className="dim small">{s.reviewers.join(' or ')} decides</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="dim small ledger-none">Nothing needs a human.</p>
      )}

      {auto.length > 0 && (
        <section data-testid="intake-auto-closed">
          <h3 className="intake-h">Closed automatically · {auto.length}</h3>
          <p className="dim small ledger-none">Their work already merged (a branch, a PR, or a linked request that is done), so they closed as done without a review.</p>
          <div className="run-list">{auto.map(row)}</div>
        </section>
      )}

      <h3 className="intake-h">In the ledger</h3>
      {restLive.size > 0 && <StateFilter live={restLive} picked={picked} onChange={setPicked} testId="intake-states" />}
      {restShown.length ? (
        <div className="run-list" data-testid="intake-ledger">{restShown.map(row)}</div>
      ) : (
        <p className="dim small ledger-none">{picked.size ? `None ${pickedLabel(picked)} now.` : 'No Discord or FFBox requests yet.'}</p>
      )}

      {s.recent.length > 0 && (
        <details className="deleg-log intake-recent">
          <summary className="dim small">What the intake saw lately · {s.recent.length}</summary>
          <ul className="intake-log">
            {s.recent.map((e, i) => (
              <li key={`${e.at}-${i}`} className="small">
                <span className="mono dim">{fmtRelative(e.at, now)}</span> <span className={e.action === 'filed' || e.action === 'closed' ? 'tone-green' : e.action === 'skipped' ? 'tone-amber' : 'dim'}>{e.action}</span> {e.title}
                {e.workId ? <span className="mono"> {e.workId}</span> : null}
                {e.why ? <span className="dim"> ({e.why})</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** How an intake fix is reaching players: landed, replied in Discord, thread closed, released. */
function deliveryLine(w: WorkItem): string {
  const d = w.delivery;
  if (!d) return '';
  return [d.fixCommit && `fix ${d.fixCommit.slice(0, 10)}`, d.landedAt && 'on develop', d.repliedAt && 'replied in Discord', d.closedAt && 'thread closed', d.releasedIn && `live in ${d.releasedIn}`, d.announcedBy && `follow-up ${d.announcedBy}`].filter(Boolean).join(' · ');
}

function WorkRow({ app, w, live, open, onToggle, now }: { app: AppState; w: WorkItem; live?: WorkLive; open: boolean; onToggle: () => void; now: number }) {
  const workers = sessionsByIds(app.sessions, w.sessionIds);
  const spend = useSpendSummary();
  const tone = live ? LIVE_TONE[live.state] : w.approval?.state === 'pending' && isOpenWork(w) ? 'amber' : workTone(w.status);
  const s = w.source;
  const delivery = deliveryLine(w);
  return (
    <div id={`work-${w.id}`} className={`run-row work-row${open ? ' open' : ''}`} data-testid={`work-${w.id}`}>
      <button className="run-row-top" onClick={onToggle} aria-expanded={open}>
        <Dot tone={tone} pulse={live?.state === 'working'} title={live ? WORK_LIVE_LABEL[live.state] : workLabel[w.status]} />
        <span className="work-main">
          <span className="work-title">{w.title}</span>
          <span className="work-sub">
            {live ? (
              <span className={`tone-${tone}`} title={live.why} data-testid={`live-${w.id}`}>
                {WORK_LIVE_LABEL[live.state]}
                {live.waitsOn?.length ? ` on ${live.waitsOn.join(', ')}` : ''}
                {live.roomOn?.length ? (
                  <span className="tone-red" data-testid={`room-${w.id}`}>
                    {' '}
                    · but {live.roomOn.join(', ')} {live.roomOn.length > 1 ? 'have' : 'has'} room
                  </span>
                ) : null}
                <span className="dim"> · {statusText(w)}</span>
              </span>
            ) : (
              <span className={`tone-${tone}`}>{statusText(w)}</span>
            )}
            {w.mergedInto ? ` into ${w.mergedInto}` : ''} · <span className="mono">{w.id}</span> · {s ? sourceLabel(s) : names(w)}
            {w.delegation ? (
              <span data-testid={`work-delegation-${w.id}`}>
                {' '}
                · from {w.delegation.agentName}
                {w.delegation.auto ? ' (auto-approved)' : ''}
              </span>
            ) : null}
            {isMine(w, app.me?.userId) ? <span className="tone-blue" data-testid="work-yours"> · yours</span> : null}
            {w.triage && w.triage.class !== 'needs-human' ? <span> · {triageLabel[w.triage.class]}</span> : null}
            {w.priority === 'urgent' || w.priority === 'high' ? <span className="tone-amber"> · {w.priority}</span> : null}
            {w.flag ? <span className="tone-amber"> · design question</span> : null}
            <CostChip id={w.id} summary={spend} />
          </span>
        </span>
        <span className="run-cost mono dim" title={new Date(w.updatedAt).toLocaleString()}>
          {fmtRelative(w.updatedAt, now)}
        </span>
      </button>
      {open && (
        <div className="run-detail work-detail">
          {s && (
            <p className="small intake-facts">
              {sourceLabel(s)}
              {s.untrusted ? <span className="tone-amber"> · players’ text, untrusted</span> : null}
              {s.version ? ` · version ${s.version}` : ''}
              {s.reporter ? ` · reported by ${s.reporter}` : ''}
              {s.kind.startsWith('ffbox') && isFfboxConversationId(s.conversation) ? (
                <>
                  {' · '}
                  <a href={ffboxConversationHref(s.conversation)} data-testid={`work-ffbox-conversation-${w.id}`}>
                    FFBox conversation
                  </a>
                </>
              ) : null}
              {s.url ? (
                <>
                  {' · '}
                  {s.url.startsWith('https://discord.com/') ? (
                    <a href={s.url} target="_blank" rel="noreferrer noopener">
                      Discord thread
                    </a>
                  ) : (
                    <a href={s.url} target="_blank" rel="noreferrer noopener" title="FFBox's own page: it opens only on Lothsahn's home network">
                      FFBox {FFBOX_LAN_LABEL}
                    </a>
                  )}
                </>
              ) : null}
              {s.alsoThreads?.length ? ` · also reported ${s.alsoThreads.length} more time(s)` : ''}
              {' · for '}
              {names(w)}
            </p>
          )}
          {live && (
            <p className={`small tone-${tone}`} data-testid={`live-why-${w.id}`}>
              {WORK_LIVE_LABEL[live.state]}
              {live.waitsOn?.length ? ` on ${live.waitsOn.join(', ')}` : ''}: {live.why}
            </p>
          )}
          {w.triage && (
            <p className={`small ${pendingApproval(w) && w.triage.class === 'needs-human' ? 'tone-amber' : 'dim'}`} data-testid="triage">
              {decisionOf(w) && decisionOf(w)!.state !== 'waiting' ? 'Triage at filing' : 'Triage'}: {w.triage.reason}
            </p>
          )}
          {decisionOf(w) && decisionOf(w)!.state !== 'waiting' && (
            <p className="small" data-testid="decision">
              {cap(decisionOf(w)!.text)}
            </p>
          )}
          {/* Players' text is shown as it is, never as Markdown: no links, images or formatting from it. */}
          {s?.untrusted ? <pre className="code intake-brief">{w.brief}</pre> : <Markdown text={w.brief} />}
          {w.constraints && <p className="dim small">Constraints: {w.constraints}</p>}
          {w.flag && (
            <p className="small tone-amber">
              Design question for {w.flag.for.map((r) => r.displayName).join(', ')}: {w.flag.text}
            </p>
          )}
          {w.outcome && (
            <p className="small">
              <span className="dim">Latest: </span>
              {w.outcome}
            </p>
          )}
          {w.autoClosed && (
            <p className="small dim" data-testid={`auto-closed-${w.id}`}>
              Closed automatically, no review needed: {w.autoClosed.text}.
            </p>
          )}
          {w.stalled && (
            <p className="small tone-amber" data-testid={`stalled-${w.id}`}>
              Stalled ({w.stalled.kind}): {w.stalled.reason}
            </p>
          )}
          {w.status === 'blocked' && w.blocked && (
            <p className="small tone-violet" data-testid={`blocked-${w.id}`}>
              Blocked on {gatesName(gatesOf(w), now)}: {gatesOf(w).map((g) => g.what).join('; ')} (set by {w.blocked.by}, {fmtRelative(w.blocked.at, now)}). It starts by itself when {w.alsoBlocked?.length ? 'all of them clear' : 'that clears'}.
            </p>
          )}
          <RequestSpendBlock id={w.id} app={app} />
          {w.prs?.length ? (
            <p className="small dim" data-testid={`prs-${w.id}`}>
              Pull requests:{' '}
              {w.prs.map((p, i) => (
                <span key={`${p.repo}#${p.number}`}>
                  {i ? ', ' : ''}
                  {p.url ? (
                    <a href={p.url} target="_blank" rel="noreferrer noopener">
                      #{p.number}
                    </a>
                  ) : (
                    `#${p.number}`
                  )}{' '}
                  {p.state}
                </span>
              ))}
            </p>
          ) : null}
          {delivery && <p className="small dim">To players: {delivery}</p>}
          {w.ffbox && (
            <p className="small dim">
              On FFBox: {w.ffbox.state} ({w.ffbox.class}){w.ffbox.branch ? `, branch ${w.ffbox.branch}` : ''}
              {w.ffbox.reason ? `, ${w.ffbox.reason}` : ''}
            </p>
          )}
          {w.mergedInto && (
            <button className="link-btn small" onClick={() => navigate({ view: 'dispatcher', tab: w.mergedInto })}>
              Continues as {w.mergedInto}
            </button>
          )}
          {workers.map((x) => (
            <button key={x.id} className="link-btn small" onClick={() => navigate(sessionRoute(x, app))}>
              Open {x.title}
              {x.sandboxId ? ` in ${x.sandboxId}` : x.machineId && x.machineSandbox ? ` in ${x.machineId}/${x.machineSandbox}` : x.machineId ? ` on ${x.machineId}` : ''}
            </button>
          ))}
          {w.overlaps.length > 0 && (
            <p className="dim small">
              Found at filing, may repeat: {w.overlaps.map((o) => `${o.ref} “${o.title}” (${o.why})`).join('; ')}
            </p>
          )}
          {w.log.length > 0 && (
            <details className="deleg-log">
              <summary className="dim small">Log · {w.log.at(-1)}</summary>
              <pre className="code">{w.log.join('\n')}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
