import { useEffect, useRef, useState } from 'react';
import type { AppState, WorkItem, WorkNeedsYou } from '../../../shared/types';
import { waitAge, type WaitingAsk, type WaitingItem } from '../../../shared/waiting';
import { namesReporter, sourceLabel, untrustedLabel } from '../../../shared/workLabels';
import { api } from '../api';
import { sessionRoute } from '../attention';
import { attempt, focusWait, sessionsByIds, toast, useStore } from '../store';
import { fmtClock, fmtRelative, navigate } from '../util';
import { Markdown } from './Markdown';
import { PermissionCard } from './Transcript';
import { Dot, Icon } from './ui';

const ASK_LABEL: Record<WaitingAsk, string> = { approve: 'Approve or decline', answer: 'Answer', check: 'Check' };
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
      <div className="wait-brief">{s?.untrusted ? <pre className="code intake-brief">{w.brief}</pre> : <Markdown text={w.brief} />}</div>
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

/** A still or a clip inline, a folder or a wildcard as code (server/needsYou.ts previewLine). */
const previewMd = (p: string) => {
  const name = p.split(/[\\/]/).pop() ?? p;
  // The path always, so it can be found when the file cannot be shown; the still or the clip under it.
  return !p.includes('*') && /\.(?:png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(p) ? `\`${p}\`\n\n![${name}](<${p}>)` : `\`${p}\``;
};

/**
 * The question in full with what it is about (w1378, Ben: "it wants me to reply to a conversation but I can't really see the
 * conversation"): who asks, the question, the files to look at, the pull requests and the end of the worker's report, and
 * where it went: the person's own orchestrator chat, which asks and relays the answer.
 */
function NeedsYouBlock({ app, w, r, mine }: { app: AppState; w: WorkItem; r: WorkNeedsYou; mine: boolean }) {
  const askedBy = r.kind === 'question' ? 'The dispatcher' : `Worker ${r.worker ?? ''}`.trim();
  return (
    <div className="wait-needs-you" data-testid={`wait-needs-you-${w.id}`}>
      {r.kind !== 'question' && (
        <div className="wait-question" data-testid={`wait-question-${w.id}`}>
          <p className="small">
            <strong>{askedBy} asks {r.who.join(', ')}:</strong>
          </p>
          <Markdown text={r.question} />
        </div>
      )}
      {r.previews.length > 0 && (
        <div className="wait-previews" data-testid={`wait-previews-${w.id}`}>
          <p className="small">
            <strong>Look at:</strong>
          </p>
          <Markdown text={r.previews.map(previewMd).join('\n\n')} />
        </div>
      )}
      {r.prs.length > 0 && (
        <p className="small" data-testid={`wait-prs-${w.id}`}>
          <strong>Pull requests:</strong>{' '}
          {r.prs.map((pr, i) => (
            <span key={pr}>
              {i ? ', ' : ''}
              <PrLink pr={pr} />
            </span>
          ))}
        </p>
      )}
      {r.report && r.report.trim() !== r.question.trim() && (
        <details className="wait-report" data-testid={`wait-report-${w.id}`}>
          <summary className="small">The end of {r.worker ? `worker ${r.worker}'s` : 'its worker’s'} last report</summary>
          <Markdown text={r.report} />
        </details>
      )}
      <p className="small dim" data-testid={`wait-routed-${w.id}`}>
        {r.answered
          ? `${r.answered.by} answered ${fmtClock(r.answered.at)}; ${r.worker ? `worker ${r.worker} resumes with it.` : 'the dispatcher carries on.'}`
          : mine
            ? `Sent to your orchestrator ${fmtClock(r.at)}: answer it there, in your own words, and it goes back to ${r.worker ? `worker ${r.worker}` : 'the dispatcher'}.`
            : `Sent to ${r.who.join(', ')}'s orchestrator ${fmtClock(r.at)}.`}{' '}
        {mine && !r.answered && app.orchestratorId && (
          <button className="link-btn small" onClick={() => navigate({ view: 'home' })} data-testid={`wait-chat-${w.id}`}>
            <Icon name="chevron" size={11} /> Answer in your chat
          </button>
        )}
      </p>
    </div>
  );
}

function WaitCard({ app, item, now }: { app: AppState; item: WaitingItem; now: number }) {
  const { w, ask, mine, since } = item;
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [answer, setAnswer] = useState('');
  const [sent, setSent] = useState(false);
  const workers = sessionsByIds(app.sessions, w.sessionIds);
  // A worker of it streams its Live view (w1430): the wait is often "drag the knobs", so the card opens it in one click.
  const live = app.config.live?.enabled ? app.live?.find((v) => v.state !== 'stopped' && w.sessionIds.includes(v.sessionId)) : undefined;
  const age = waitAge(since, now);
  const act = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    const ok = await attempt(f());
    setBusy(false);
    if (ok !== undefined && done) toast(done);
    return ok !== undefined;
  };
  const sendAnswer = async () => {
    const text = answer.trim();
    if (!text || !app.orchestratorId) return;
    const asked = w.question?.text ?? w.flag?.text ?? w.needsYou?.question ?? '';
    const ok = await act(
      () => api.sendMessage(app.orchestratorId, `Answer on ${w.id} (${w.title}). It asked: “${asked.slice(0, 300)}”\n\n${text}\n\nPlease put this on ${w.id} as my answer (update_work note).`),
      `Sent to your orchestrator: it records the answer on ${w.id}.`,
    );
    if (ok) setSent(true);
  };
  return (
    <article className={`wait-card${mine ? ' mine' : ''}`} data-testid={`wait-${w.id}`}>
      <header className="wait-head">
        <Dot tone={mine ? 'amber' : 'grey'} />
        <span className="wait-title">{w.title}</span>
        <span className="mono dim">{w.id}</span>
        <span className="spacer" />
        <span className={`wait-age tone-${AGE_TONE[age]}`} title={new Date(since).toLocaleString()} data-testid={`wait-age-${w.id}`}>
          {age === 'stale' ? 'stale · ' : ''}
          {fmtRelative(since, now)}
        </span>
      </header>
      <p className="small wait-ask" data-testid={`wait-ask-${w.id}`}>
        <strong>{mine ? ASK_LABEL[ask] : `Waits on ${item.on.join(', ') || 'someone else'}`}:</strong>{' '}
        {/* A worker's question is shown whole below (w1378); this line says only whose it is. */}
        {ask === 'check' && w.needsYou && !w.needsYou.answered && w.needsYou.kind !== 'question'
          ? `worker ${w.needsYou.worker ?? ''} waits on ${w.needsYou.who.join(', ')} (since ${fmtRelative(w.needsYou.at, now)}): its question is below.`
          : item.text}
      </p>
      {item.recommendation && (
        <p className="small tone-blue" data-testid={`wait-recommendation-${w.id}`}>
          FF Factory recommends: {item.recommendation}
        </p>
      )}
      {w.needsYou && <NeedsYouBlock app={app} w={w} r={w.needsYou} mine={mine} />}
      <Evidence w={w} />
      {ask === 'check' &&
        workers.flatMap((x) =>
          x.pendingPermissions.map((p) => (
            <div key={p.requestId}>
              <p className="small tone-amber">
                {x.title} ({x.id}) waits for an OK:
              </p>
              <PermissionCard sessionId={x.id} requestId={p.requestId} toolName={p.toolName} input={p.input} reason={p.reason} pending />
            </div>
          )),
        )}
      <div className="wait-actions">
        {mine && ask === 'approve' && !declining && (
          <>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(() => api.approveWork(w.id), `${w.id} approved: the dispatcher decides it now.`)}>
              Approve {w.id}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setDeclining(true)}>
              Decline…
            </button>
          </>
        )}
        {mine && ask === 'approve' && declining && (
          <>
            <input
              className="input wait-reason"
              autoFocus
              placeholder="Why (kept on the request)"
              aria-label={`Reason to decline ${w.id}`}
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void act(() => api.declineWork(w.id, reason.trim() || undefined), `${w.id} declined.`)}
            />
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(() => api.declineWork(w.id, reason.trim() || undefined), `${w.id} declined.`)}>
              Decline {w.id}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setDeclining(false)}>
              Back
            </button>
          </>
        )}
        {!mine && ask === 'approve' && <span className="dim small">{app.intake?.reviewers.join(' or ') || 'A reviewer'} decides</span>}
        {mine && (ask === 'answer' || (ask === 'check' && !!w.needsYou && !w.needsYou.answered)) && (
          <div className="wait-answer">
            {sent ? (
              <span className="small tone-green">Sent to your orchestrator. The card goes when it has recorded the answer.</span>
            ) : (
              <>
                <textarea
                  className="input wait-answer-text"
                  rows={2}
                  placeholder="Your answer"
                  aria-label={`Answer on ${w.id}`}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
                <button className="btn btn-sm btn-primary" disabled={busy || !answer.trim() || !app.orchestratorId} onClick={() => void sendAnswer()}>
                  Send answer
                </button>
              </>
            )}
          </div>
        )}
        {live && (
          <button type="button" className="btn btn-outline btn-xs lv-open" title="Watch the game beside the worker's conversation and move the asset's knobs" data-testid={`wait-live-${w.id}`} onClick={() => navigate({ view: 'live', sessionId: live.sessionId })}>
            <span className="lv-rec" /> Live view: go
          </button>
        )}
        <div className="spacer" />
        <button className="link-btn small" onClick={() => navigate({ view: 'dispatcher', tab: w.id })}>
          Open {w.id}
        </button>
        {ask === 'check' &&
          workers.slice(0, 2).map((x) => (
            <button key={x.id} className="link-btn small" onClick={() => navigate(sessionRoute(x, app))}>
              <Icon name="chevron" size={11} /> Open {x.id}
            </button>
          ))}
      </div>
    </article>
  );
}
