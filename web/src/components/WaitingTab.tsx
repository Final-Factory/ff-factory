import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Ask } from '../../../shared/ask';
import { answerMessage, answersText, cardMedia, cardQuestions, legacySteps, namesForPaths, plainQuestion } from '../../../shared/questionCard';
import { FLAG_LABEL, type AppState, type WorkItem } from '../../../shared/types';
import { intakeRecommendation, waitAge, type WaitingItem } from '../../../shared/waiting';
import { namesReporter, sourceLabel, untrustedLabel } from '../../../shared/workLabels';
import { api } from '../api';
import { sessionRoute } from '../attention';
import { attempt, focusWait, sessionsByIds, toast, useStore } from '../store';
import { fmtClock, fmtRelative, navigate } from '../util';
import { LocalImages, Markdown } from './Markdown';
import { DetailLine, Previews, QuestionCard } from './QuestionCard';
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
export function WaitingTab({ app, items, now }: { app: AppState; items: WaitingItem[]; now: number }) {
  const mine = items.filter((i) => i.mine);
  const others = items.filter((i) => !i.mine);
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
        {items.length
          ? `${items.length} ${items.length === 1 ? 'request waits' : 'requests wait'} on input: ${mine.length} on you, ${others.length} on someone else. The oldest waits first.`
          : 'Nothing waits on input.'}
      </p>
      <h3 className="intake-h">Waiting on you · {mine.length}</h3>
      {mine.length ? (
        <div className="wait-list" data-testid="waiting-mine">
          {mine.map((i) => (
            <WaitCard key={i.w.id} app={app} item={i} now={now} />
          ))}
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
      {w.flag && <DetailLine label={FLAG_LABEL[w.flag.kind]}>{namesForPaths(w.flag.text)}</DetailLine>}
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

/** The labels of an intake approval's two answers: a click on one approves or declines it, as the buttons did. */
export const APPROVE_LABEL = 'Approve it: the dispatcher picks it up and work starts';
export const DECLINE_LABEL = 'Decline it: nothing is worked on it';

/**
 * An intake request waiting for a reviewer, as a question (w1597): "Should FF Factory work on this?", Approve (marked
 * recommended when the triage says so) or Decline; the free box declines with a reason. The same endpoints as before.
 */
export function ApproveCard({ app, w, mine, reviewers, details, testId }: { app: AppState; w: WorkItem; mine: boolean; reviewers: string; details: ReactNode; testId: string }) {
  const rec = intakeRecommendation(w);
  const approveRec = !!rec?.startsWith('Approve');
  // A possible repeat (intakeRecommendation's "Check first"), named by its title on the answer it bears on.
  const repeat = w.overlaps[0];
  const asks: Ask[] = [
    {
      question: `Should FF Factory work on this ${w.source?.kind === 'discord-bug' ? 'player’s bug report' : 'request'}?`,
      options: [
        { label: APPROVE_LABEL, description: '', ...(approveRec ? { recommended: true } : {}) },
        { label: DECLINE_LABEL, description: '' },
      ],
    },
  ];
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
  if (ask === 'approve') return <ApproveCard app={app} w={w} mine={mine} reviewers={app.intake?.reviewers.join(' or ') || 'A reviewer'} details={details} testId={`wait-${w.id}`} />;
  const r = w.needsYou;
  const cq = cardQuestions(w);
  // A wait with no question of its own (a worker's permission, a report that ends asking): what the ledger says it waits on.
  const question = cq.asks.length ? '' : cq.text || plainQuestion(item.text);
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
    />
  );
}

/** The Intake tab's card for a request waiting for a reviewer (w1597): the same question card the Waiting on input tab shows. */
export function IntakeApproveCard({ app, w, reviewer, now }: { app: AppState; w: WorkItem; reviewer: boolean; now: number }) {
  const item = { w, ask: 'approve', mine: reviewer, on: [], since: w.createdAt, text: `Nothing is worked on it until it is approved${w.approval?.why ? ` (not approved automatically: ${w.approval.why})` : ''}.`, recommendation: intakeRecommendation(w) } as unknown as WaitingItem;
  return <ApproveCard app={app} w={w} mine={reviewer} reviewers={app.intake?.reviewers.join(' or ') || 'A reviewer'} details={<CardDetails app={app} item={item} now={now} />} testId={`intake-${w.id}`} />;
}
