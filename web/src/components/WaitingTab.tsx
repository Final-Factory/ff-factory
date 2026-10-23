import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Ask } from '../../../shared/ask';
import { answerMessage, answersText, cardMedia, cardQuestions, legacySteps, namesForPaths, plainQuestion } from '../../../shared/questionCard';
import type { AppState, WorkItem } from '../../../shared/types';
import { intakeRecommendation, waitAge, type AskItem, type WaitingItem } from '../../../shared/waiting';
import { APPROVE_LABEL, DECLINE_LABEL, approveAsk, waitSummary, waitedFor, whatOf, type WaitSummary } from '../../../shared/waitSummary';
import { namesReporter, sourceLabel, untrustedLabel } from '../../../shared/workLabels';
import { api } from '../api';
import { sessionRoute } from '../attention';
import { attempt, focusWait, sessionsByIds, toast, useStore } from '../store';
import { fmtClock, fmtRelative, navigate } from '../util';
import { LocalImages, Markdown } from './Markdown';
import { DetailLine, Previews, QuestionCard, type CardSummary } from './QuestionCard';
import { PermissionCard } from './Transcript';
import { Icon } from './ui';

const AGE_TONE = { fresh: 'grey', old: 'amber', stale: 'red' } as const;

/**
 * Every request that waits on a person (w1228, Ben: "please make a good UI for intake in FFF"): one queue, the viewer's own
 * moves first, then what waits on someone else. Each card says what it is, what is asked, how long it has waited, the
 * evidence (the player's words, the source, the triage, repeats) and FF Factory's recommendation, with the buttons that
 * clear it: Approve, Decline with a reason, Answer (sent to the viewer's own orchestrator, the way they would say it),
 * or Open. The same endpoints the Intake tab and the orchestrator chat use; nothing new is allowed here.
 */
export function WaitingTab({ app, items, asks = [], now }: { app: AppState; items: WaitingItem[]; asks?: AskItem[]; now: number }) {
  const mine = items.filter((i) => i.mine);
  const others = items.filter((i) => !i.mine);
  // The viewer's own orchestrator's open questions (w1868) sit among their own requests' cards, oldest first.
  const ownCards = [...mine.map((i) => ({ at: i.since, key: `w:${i.w.id}`, el: <WaitCard key={`w:${i.w.id}`} app={app} item={i} now={now} /> })), ...asks.map((a) => ({ at: a.a.at, key: `a:${a.sessionId}:${a.a.seq}`, el: <AskWaitCard key={`a:${a.sessionId}:${a.a.seq}`} app={app} item={a} now={now} /> }))].sort((x, y) => x.at.localeCompare(y.at));
  const onYou = mine.length + asks.length;
  // A "Needs you" item names the request it is about (w1356): put its card at the top, with its buttons in view, and flash it.
  const focusId = useStore((s) => s.focusWaitId);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusId) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-testid="wait-${CSS.escape(focusId)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'start' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
    focusWait(null);
  }, [focusId, items.length]);
  return (
    <div className="sa-scroll waiting-tab" data-testid="waiting-tab" ref={root}>
      <p className="dim small ledger-none" data-testid="waiting-summary">
        {items.length || asks.length
          ? `${items.length} ${items.length === 1 ? 'request waits' : 'requests wait'} on input: ${mine.length} on you, ${others.length} on someone else.${asks.length ? ` Your orchestrator asks you ${asks.length} more question${asks.length > 1 ? 's' : ''}.` : ''} The oldest waits first.`
          : 'Nothing waits on input.'}
      </p>
      <h3 className="intake-h">Waiting on you · {onYou}</h3>
      {onYou ? (
        <div className="wait-list" data-testid="waiting-mine">
          {ownCards.map((c) => c.el)}
        </div>
      ) : (
        <p className="dim small ledger-none">Nothing waits on you.</p>
      )}
      {others.length > 0 && (
        <>
          <h3 className="intake-h">Waiting on someone else · {others.length}</h3>
          <div className="wait-list" data-testid="waiting-others">
            {others.map((i) => (
              <WaitCard key={i.w.id} app={app} item={i} now={now} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Evidence({ w }: { w: WorkItem }) {
  const s = w.source;
  return (
    <div className="wait-evidence" data-testid={`wait-evidence-${w.id}`}>
      {s && (
        <p className="small intake-facts">
          {sourceLabel(s)}
          {s.untrusted ? <span className="tone-amber"> · {untrustedLabel(s)}</span> : null}
          {s.version ? ` · version ${s.version}` : ''}
          {namesReporter(s) ? ` · reported by ${s.reporter}` : ''}
          {s.url?.startsWith('https://') ? (
            <>
              {' · '}
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                {s.url.startsWith('https://discord.com/') ? 'Discord thread' : 'source'}
              </a>
            </>
          ) : null}
          {s.alsoThreads?.length ? ` · also reported ${s.alsoThreads.length} more time(s)` : ''}
        </p>
      )}
      {w.triage && (
        <p className="small dim" data-testid="triage">
          Triage: {w.triage.reason}
        </p>
      )}
      {/* Players' text is shown as it is, never as Markdown: no links, images or formatting from it. */}
      <div className="wait-brief">{s?.untrusted ? <pre className="code intake-brief">{w.brief}</pre> : <Markdown text={namesForPaths(w.brief)} />}</div>
      {w.overlaps.length > 0 && (
        <p className="dim small">Found at filing, may repeat: {w.overlaps.map((o) => `${o.ref} “${o.title}” (${o.why})`).join('; ')}</p>
      )}
    </div>
  );
}

/** A pull request ref ("owner/repo#12" or "#12") as a link to it on GitHub when its repo is known. */
function PrLink({ pr }: { pr: string }) {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(pr);
  if (!m) return <span className="mono">{pr}</span>;
  return (
    <a href={`https://github.com/${m[1]}/pull/${m[2]}`} target="_blank" rel="noreferrer noopener" className="mono">
      {pr}
    </a>
  );
}

/** Review stills in Details text are shown as stills (the review folder needs no session); other paths are names. */
const reviewImage = (p: string) => `/api/image?${new URLSearchParams({ path: p })}`;

/**
 * Everything a card does not ask (w1597, behind its Details link): who asked and when, the request, the worker's own words
 * and the dispatcher's restatement, the pull requests, the end of the worker's report, and the request's evidence. Paths
 * are shown as file names.
 */
function CardDetails({ app, item, now }: { app: AppState; item: WaitingItem; now: number }) {
  const { w, ask, since } = item;
  const r = w.needsYou;
  const workers = sessionsByIds(app.sessions, w.sessionIds);
  const asker = ask === 'approve' ? 'The intake' : r && r.kind !== 'question' ? `Worker ${r.worker ?? ''}`.trim() : 'The dispatcher';
  const age = waitAge(since, now);
  return (
    <LocalImages.Provider value={reviewImage}>
      <DetailLine label="Asked">
        {asker},{' '}
        <span className={`tone-${AGE_TONE[age]}`} title={new Date(since).toLocaleString()} data-testid={`wait-age-${w.id}`}>
          {age === 'stale' ? 'stale · ' : ''}
          {fmtRelative(since, now)}
        </span>{' '}
        · <span className="mono">{w.id}</span>{' '}
        <button className="link-btn small" onClick={() => navigate({ view: 'dispatcher', tab: w.id })}>
          Open {w.id}
        </button>
        {workers.slice(0, 2).map((x) => (
          <button key={x.id} className="link-btn small" onClick={() => navigate(sessionRoute(x, app))}>
            {' '}
            <Icon name="chevron" size={11} /> Open {x.id}
          </button>
        ))}
      </DetailLine>
      {!item.mine && <DetailLine label="Waits on">{item.on.join(', ') || 'someone else'}</DetailLine>}
      {ask === 'approve' && <DetailLine label="Why it waits">{item.text}</DetailLine>}
      {item.recommendation && <DetailLine label="FF Factory recommends">{item.recommendation}</DetailLine>}
      {r && r.kind !== 'question' && (
        <div className="small" data-testid={`wait-question-${w.id}`}>
          <span className="dim">Its worker’s words:</span> <Markdown text={namesForPaths(r.question)} />
        </div>
      )}
      {w.question && (
        <div className="small">
          <span className="dim">The dispatcher’s words:</span> <Markdown text={namesForPaths(w.question.text)} />
        </div>
      )}
      {w.flag && <DetailLine label="Design question">{namesForPaths(w.flag.text)}</DetailLine>}
      {r && r.prs.length > 0 && (
        <p className="small" data-testid={`wait-prs-${w.id}`}>
          <span className="dim">Pull requests:</span>{' '}
          {r.prs.map((pr, i) => (
            <span key={pr}>
              {i ? ', ' : ''}
              <PrLink pr={pr} />
            </span>
          ))}
        </p>
      )}
      {r && !r.answered && r.asks?.length && r.previews.length > 0 ? (
        <div className="small">
          <span className="dim">Review files it names:</span>
          <Previews media={cardMedia(undefined, r.previews)} {...(r.worker ? { session: r.worker } : {})} />
        </div>
      ) : null}
      {r?.report && r.report.trim() !== r.question.trim() && (
        <details className="wait-report" data-testid={`wait-report-${w.id}`}>
          <summary className="small">The end of its worker’s last report</summary>
          <Markdown text={namesForPaths(r.report)} />
        </details>
      )}
      {r && (
        <p className="small dim" data-testid={`wait-routed-${w.id}`}>
          {r.answered ? `${r.answered.by} answered ${fmtClock(r.answered.at)}.` : `Also sent to ${r.who.join(', ')}'s orchestrator chat ${fmtClock(r.at)}.`}
        </p>
      )}
      <Evidence w={w} />
    </LocalImages.Provider>
  );
}

export { APPROVE_LABEL, DECLINE_LABEL };

/** A summary's parts as the card shows them (w1868): what it is, who acts and for how long, the step, what follows, stale. */
export function cardSummary(s: WaitSummary, now: number, title?: string): CardSummary {
  const age = waitAge(s.since, now);
  return {
    what: s.what,
    meta: (
      <>
        <span className={age === 'fresh' ? '' : `tone-${AGE_TONE[age]}`}>
          {s.who} must act · waiting {waitedFor(s.since, now)}
        </span>
        {title ? <span title={title}> · {title}</span> : null}
      </>
    ),
    ...(s.step ? { step: s.step } : {}),
    after: s.after,
    ...(s.stale ? { stale: s.stale } : {}),
    ...(s.noMedia ? { noMedia: true } : {}),
  };
}

/**
 * An intake request waiting for a reviewer, as a question (w1597): "Should FF Factory work on this?", Approve (marked
 * recommended when the triage says so) or Decline; the free box declines with a reason. The same endpoints as before.
 */
export function ApproveCard({ app, w, mine, reviewers, details, testId, summary }: { app: AppState; w: WorkItem; mine: boolean; reviewers: string; details: ReactNode; testId: string; summary?: CardSummary }) {
  const rec = intakeRecommendation(w);
  // A possible repeat (intakeRecommendation's "Check first"), named by its title on the answer it bears on.
  const repeat = w.overlaps[0];
  const asks: Ask[] = [approveAsk(w, rec)];
  const onAnswer = async (text: string) => {
    const ok = await attempt(text === APPROVE_LABEL ? api.approveWork(w.id) : api.declineWork(w.id, text === DECLINE_LABEL ? undefined : text.slice(0, 300)));
    if (ok !== undefined) toast(text === APPROVE_LABEL ? `${w.id} approved: the dispatcher decides it now.` : `${w.id} declined.`);
    return ok !== undefined;
  };
  void app;
  return (
    <QuestionCard
      id={`approve.${w.id}`}
      testId={testId}
      title={w.title}
      asks={asks}
      question=""
      previews={[]}
      mine={mine}
      answeredBy={reviewers}
      onAnswer={onAnswer}
      freeLabel="Or decline with a reason"
      {...(repeat ? { note: `It may repeat “${repeat.title.length > 80 ? `${repeat.title.slice(0, 79)}…` : repeat.title}” (${repeat.why}).` } : {})}
      details={details}
      {...(summary ? { summary } : {})}
    />
  );
}

function WaitCard({ app, item, now }: { app: AppState; item: WaitingItem; now: number }) {
  const { w, ask, mine } = item;
  const [sent, setSent] = useState(false);
  const workers = sessionsByIds(app.sessions, w.sessionIds);
  // A worker of it streams its Live view (w1430): the wait is often "drag the knobs", so the card opens it in one click.
  const live = app.config.live?.enabled ? app.live?.find((v) => v.state !== 'stopped' && w.sessionIds.includes(v.sessionId)) : undefined;
  const details = <CardDetails app={app} item={item} now={now} />;
  const reviewers = app.intake?.reviewers.join(' or ') || 'A reviewer';
  // The six parts (w1868, shared/waitSummary.ts): what it is, who acts and since when, the question, its answers, media, what follows.
  const sum = waitSummary(item, { session: (id) => app.sessions.find((x) => x.id === id), reviewers: app.intake?.reviewers.join(' or ') });
  const summary = cardSummary(sum, now, w.title);
  if (ask === 'approve') return <ApproveCard app={app} w={w} mine={mine} reviewers={reviewers} details={details} testId={`wait-${w.id}`} summary={summary} />;
  const r = w.needsYou;
  const cq = cardQuestions(w);
  // A wait with no question of its own (a worker's permission, a report that ends asking): the summary's question.
  const question = cq.asks.length ? '' : cq.text || sum.question || plainQuestion(item.text);
  // A free-text list of decisions is asked one at a time, each answered in words.
  const asks = cq.asks.length ? cq.asks : (legacySteps(question) ?? []);
  const answerable = mine && (ask === 'answer' || (ask === 'check' && !!r && !r.answered));
  // A click on an answer and a typed answer send the same message (w1597; shared/questionCard.ts answerMessage).
  const onAnswer = async (_text: string, answers: string[]) => {
    if (!app.orchestratorId) return false;
    const ok = await attempt(api.sendMessage(app.orchestratorId, answerMessage(w, answersText(asks, answers))));
    if (ok === undefined) return false;
    toast(`Sent to your orchestrator: it records the answer on ${w.id}.`);
    setSent(true);
    return true;
  };
  const permissions =
    ask === 'check' &&
    workers.flatMap((x) =>
      x.pendingPermissions.map((p) => (
        <div key={p.requestId}>
          <p className="small tone-amber">{x.title} waits for an OK:</p>
          <PermissionCard sessionId={x.id} requestId={p.requestId} toolName={p.toolName} input={p.input} reason={p.reason} pending />
        </div>
      )),
    );
  const look = live && (
    <button type="button" className="btn btn-sm btn-ghost qc-live" title="Watch the game beside the worker's conversation and move the asset's knobs" data-testid={`wait-live-${w.id}`} onClick={() => navigate({ view: 'live', sessionId: live.sessionId })}>
      <span className="lv-rec" aria-hidden /> Watch it in the Live view
    </button>
  );
  const done = sent ? (
    <p className="small tone-green" data-testid={`wait-sent-${w.id}`}>
      Sent to your orchestrator. The card goes when it has recorded the answer.
    </p>
  ) : r?.answered ? (
    <p className="small dim">
      {r.answered.by} answered {fmtClock(r.answered.at)}; {r.worker ? 'its worker resumes with it.' : 'the dispatcher carries on.'}
    </p>
  ) : undefined;
  return (
    <QuestionCard
      id={`wait.${w.id}`}
      testId={`wait-${w.id}`}
      title={w.title}
      asks={asks}
      question={question}
      previews={r && !r.answered ? r.previews : []}
      {...(r?.worker ? { mediaSession: r.worker } : {})}
      mine={answerable}
      answeredBy={item.on.join(', ') || undefined}
      {...(answerable ? { onAnswer } : {})}
      {...(done ? { done } : {})}
      look={look}
      extra={permissions}
      details={details}
      summary={summary}
    />
  );
}

/**
 * One open question of the viewer's own orchestrator (w1868): what it is about, the question with its buttons, its stills and
 * clips, and what follows. A click answers it exactly as the click in the chat does (POST /api/sessions/<id>/answer: the
 * person's own message, the question quoted); typed words go as a reply to it. The card goes once the server sees the answer.
 */
function AskWaitCard({ app, item, now }: { app: AppState; item: AskItem; now: number }) {
  const { a, w, sessionId } = item;
  const [sent, setSent] = useState(false);
  const me = app.me?.displayName ?? 'you';
  const summary: CardSummary = {
    what: w ? whatOf(w) : 'A question from your orchestrator, in your chat with it.',
    meta: (
      <span className={waitAge(a.at, now) === 'fresh' ? '' : `tone-${AGE_TONE[waitAge(a.at, now)]}`}>
        {me} must act · waiting {waitedFor(a.at, now)} · asked by your orchestrator{a.request ? ` about ${a.request}` : ''}
      </span>
    ),
    after: a.after ?? 'Your orchestrator carries on with your answer, as if you had clicked it in your chat.',
  };
  const onAnswer = async (text: string) => {
    const i = a.ask.options.findIndex((o) => o.label === text);
    const ok = i >= 0 ? await attempt(api.answer(sessionId, a.seq, i)) : await attempt(api.sendMessage(sessionId, text, undefined, undefined, a.seq));
    if (ok === undefined) return false;
    toast('Sent to your orchestrator as your answer.');
    setSent(true);
    return true;
  };
  const details = (
    <>
      <DetailLine label="Asked">
        your orchestrator, {fmtRelative(a.at, now)}{' '}
        <button className="link-btn small" onClick={() => { const chat = app.sessions.find((x) => x.id === sessionId); navigate(chat ? sessionRoute(chat, app) : { view: 'session', sessionId }); }}>
          Open the chat
        </button>
        {w && (
          <button className="link-btn small" onClick={() => navigate({ view: 'dispatcher', tab: w.id })}>
            {' '}
            Open {w.id}
          </button>
        )}
      </DetailLine>
      {w && <DetailLine label="The request">{w.title}</DetailLine>}
    </>
  );
  return (
    <QuestionCard
      id={`ask.${sessionId}.${a.seq}`}
      testId={`ask-${a.seq}`}
      title={w?.title ?? 'Your orchestrator asks'}
      asks={[a.ask]}
      question=""
      previews={[]}
      mine
      onAnswer={onAnswer}
      {...(sent ? { done: <p className="small tone-green">Sent to your orchestrator. The card goes when it has your answer.</p> } : {})}
      details={details}
      summary={summary}
    />
  );
}

/** The Intake tab's card for a request waiting for a reviewer (w1597): the same question card the Waiting on input tab shows. */
export function IntakeApproveCard({ app, w, reviewer, now }: { app: AppState; w: WorkItem; reviewer: boolean; now: number }) {
  const item = { w, ask: 'approve', mine: reviewer, on: [], since: w.createdAt, text: `Nothing is worked on it until it is approved${w.approval?.why ? ` (not approved automatically: ${w.approval.why})` : ''}.`, recommendation: intakeRecommendation(w) } as unknown as WaitingItem;
  const summary = cardSummary(waitSummary({ ...item, live: { state: 'waiting', why: '' } }, { reviewers: app.intake?.reviewers.join(' or ') }), now, w.title);
  return <ApproveCard app={app} w={w} mine={reviewer} reviewers={app.intake?.reviewers.join(' or ') || 'A reviewer'} details={<CardDetails app={app} item={item} now={now} />} testId={`intake-${w.id}`} summary={summary} />;
}
