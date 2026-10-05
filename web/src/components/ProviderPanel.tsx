// FFBox's page (docs/ffbox-integration.md): what its connector reports, read-only. The header shows the
// connection and each container class (network, model, tier, free slots); the tabs list its conversations and
// the crash/desync reports ffintake filed, newest first. Titles are FFBox's data and can quote players: they
// are shown as plain text, never acted on.
import { useEffect, useState, type ReactNode } from 'react';
import type { IntakeGroups, Provider, ProviderClass, ProviderConversation, ProviderConversationView, ProviderIntakeEvent, ProviderTurn } from '../../../shared/types';
import { api } from '../api';
import { fmtCost, fmtRelative, navigate, providerGlance, useNow, type Glance } from '../util';
import { Chip, Dot, Icon } from './ui';
import { updaterHealth } from '../../../shared/updaterHealth';
import { FFBOX_LAN_LABEL, ffboxConversationHref } from '../../../shared/ffboxLinks';

type Tab = 'conversations' | 'signatures' | 'intake';

/** The connector's contract, for whoever sets it up (docs/ffbox-connector-contract.md). */
export const CONTRACT_URL = 'https://github.com/Final-Factory/ff-factory/blob/main/docs/ffbox-connector-contract.md';

const convTone = (c: ProviderConversation): Glance['tone'] =>
  c.state === 'running' || c.state === 'queued' ? 'blue' : c.state === 'blocked' ? 'amber' : c.pr?.state === 'open' ? 'green' : 'grey';

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ProviderPanel({ provider: p, tab, item, onClose }: { provider: Provider; tab?: string; item?: string; onClose?: () => void }) {
  const now = useNow(15_000);
  // One conversation, rendered here from the connector's answer (w426): FFBox's own page is on Lothsahn's network only.
  const conversationId = tab === 'conversation' && item ? item : undefined;
  const current: Tab = tab === 'intake' ? 'intake' : tab === 'signatures' ? 'signatures' : 'conversations';
  const setTab = (t: Tab) => navigate({ view: 'provider', providerId: p.id, tab: t === 'conversations' ? undefined : t }, true);
  const [conversations, setConversations] = useState<ProviderConversation[]>();
  const [intake, setIntake] = useState<ProviderIntakeEvent[]>();
  const [groups, setGroups] = useState<IntakeGroups>();
  const [error, setError] = useState<string>();
  // The newest PAGE of each list at first; "Show more" asks for the next PAGE (the server keeps 500 conversations and 2000 reports).
  const [limits, setLimits] = useState({ conversations: PAGE, intake: PAGE });
  const g = providerGlance(p, now);
  const updater = updaterHealth(p.updater, now);

  // Refetch when the summary moves (a new report, a conversation update, a reconnect); the socket carries only the summary.
  const version = `${p.counts.conversations}/${p.counts.active}/${p.counts.intake}/${p.lastIntakeAt}/${p.lastSeen}/${p.online}`;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      Promise.all([api.providerConversations(limits.conversations), api.providerIntake(limits.intake), api.providerSignatures()]).then(
        ([c, i, sg]) => {
          if (!live) return;
          setConversations(c);
          setIntake(i);
          setGroups(sg);
          setError(undefined);
        },
        (e: Error) => live && setError(e.message),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [version, limits]);

  const c = p.capacity;
  // Never connected and nothing reported: what it takes to switch it on, instead of empty lists.
  const setup = !p.online && !p.lastSeen && !c && !p.counts.conversations && !p.counts.intake;
  return (
    <section className="sb-panel sa-panel pv-panel" data-testid="provider-panel">
      {/* One scroller for the header and the lists: a tall header (several classes, holds, a phone's width) would
          otherwise leave the lists a sliver. The panel itself must not scroll (web/src/viewport.ts LOCKED). */}
      <div className="pv-scroll" data-testid="provider-scroll">
      <header className="sb-head">
        <div className="sb-head-top">
          {onClose && (
            <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close" aria-label="Close">
              <Icon name="back" />
            </button>
          )}
          <Dot tone={g.tone} pulse={g.tone === 'blue'} />
          <h2 className="ellipsis">{p.name}</h2>
          <span className={`small tone-${g.tone}`} data-testid="provider-state">
            {g.label}
            {g.detail ? ` · ${g.detail}` : ''}
          </span>
          <div className="spacer" />
          {p.web && (
            <a className="btn btn-sm btn-outline" href={p.web} target="_blank" rel="noreferrer noopener" title="FFBox's own page: it opens only on Lothsahn's home network">
              Open FFBox
            </a>
          )}
        </div>
        <p className="sb-head-purpose">
          CPU-only containers on Lothsahn's build server, reached through the connector it runs. Read-only for now: FF Factory shows what FFBox reports and cannot send it work.
        </p>
        <div className="sb-facts">
          <span className="fact">
            <Icon name="pulse" size={13} />
            <span>
              {p.online ? `connected ${fmtRelative(p.connectedSince, now)}` : p.lastSeen ? `last seen ${fmtRelative(p.lastSeen, now)}` : 'never connected'}
              {p.connector ? ` · connector ${p.connector.version}${p.connector.commit ? ` (${p.connector.commit.slice(0, 7)})` : ''}` : ''}
              {p.statusDetail && !p.online ? ` · ${p.statusDetail}` : ''}
            </span>
          </span>
          {c && (
            <span className="fact">
              <Icon name="inbox" size={13} />
              <span>
                {c.state} · queue {c.queue} · {p.counts.intake24h} report{p.counts.intake24h === 1 ? '' : 's'} in 24 h
              </span>
            </span>
          )}
        </div>
        {c && c.classes.length > 0 && (
          <div className="pv-classes" data-testid="provider-classes">
            {c.classes.map((k) => (
              <div key={k.name} className="pv-class" title={k.note ?? ''}>
                <div className="pv-class-top">
                  <span className="mono">{k.name}</span>
                  <span className="mono dim">
                    {k.free}/{k.max} free
                  </span>
                </div>
                <div className="pv-class-tags">
                  <Chip tone={k.network === 'open' ? 'amber' : 'green'}>{k.network === 'open' ? 'open internet' : 'fenced'}</Chip>
                  {!k.models?.length && <ModelTags tier={k.tier} model={k.model} />}
                  {!k.gpu && <span className="dim small">no GPU</span>}
                </div>
                {k.models?.map((m) => (
                  <div key={m.requester} className="pv-class-tags" data-testid="provider-class-model">
                    <span className="dim small">{m.requester === 'operator' ? 'operators' : 'Discord'}</span>
                    <ModelTags tier={m.tier} model={m.model} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {c && c.holds.length > 0 && <p className="small tone-amber">Waiting: {c.holds.join(' · ')}</p>}
        {updater && p.updater && (
          <p
            className={`small ${updater.state === 'ok' ? 'dim' : 'tone-red'}`}
            data-testid="provider-updater"
            title={[
              ...p.updater.checkouts.map((k) => `${k.name}${k.path ? ` (${k.path})` : ''}: ${k.status}${k.message ? `, ${k.message}` : ''}${k.local ? `; local ${k.local.slice(0, 7)}` : ''}${k.origin ? `, origin ${k.origin.slice(0, 7)}` : ''}${k.okAt ? `; last ok ${when(k.okAt)}` : ''}${k.updatedAt ? `; last updated ${when(k.updatedAt)}` : ''}`),
              ...p.updater.warnings,
            ].join('\n')}
          >
            {updater.state !== 'ok' && <Dot tone="red" />} {updater.line}
            {p.updater.runningSince && Date.parse(p.updater.runningSince) > Date.parse(p.updater.at) ? ` · a pass is running (since ${fmtRelative(p.updater.runningSince, now)})` : ''}
          </p>
        )}
      </header>

      {setup ? (
        <div className="sa-scroll pv-body">
          <Setup p={p} />
        </div>
      ) : (
      <>
      {!p.online && <p className="small pv-offline" data-testid="provider-offline-note">{p.enabled ? 'The connector is not connected: the lists below are what it reported last.' : 'Switched off (providers.ffbox.enabled): the lists below are what it reported last.'}</p>}
      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'conversations'} className={`tab${current === 'conversations' ? ' active' : ''}`} onClick={() => setTab('conversations')}>
          Conversations <span className="dim">{p.counts.conversations}</span>
        </button>
        <button role="tab" aria-selected={current === 'signatures'} className={`tab${current === 'signatures' ? ' active' : ''}`} onClick={() => setTab('signatures')}>
          Signatures <span className="dim">{groups?.signatures.length ?? ''}</span>
        </button>
        <button role="tab" aria-selected={current === 'intake'} className={`tab${current === 'intake' ? ' active' : ''}`} onClick={() => setTab('intake')}>
          Intake reports <span className="dim">{p.counts.intake}</span>
        </button>
      </nav>

      <div className="sa-scroll pv-body">
        {conversationId ? (
          <ConversationPage key={conversationId} id={conversationId} providerId={p.id} />
        ) : (
          <>
        {error && <p className="small tone-red">Could not load the lists: {error}</p>}
        {current === 'conversations' && <Conversations list={conversations} />}
        {current === 'signatures' && <Signatures groups={groups} now={now} />}
        {current === 'intake' && <Intake list={intake} />}
        {current === 'conversations' && <More shown={conversations?.length} total={p.counts.conversations} what="conversations" onMore={() => setLimits((l) => ({ ...l, conversations: l.conversations + PAGE }))} />}
        {current === 'intake' && <More shown={intake?.length} total={p.counts.intake} what="reports" onMore={() => setLimits((l) => ({ ...l, intake: l.intake + PAGE }))} />}
          </>
        )}
      </div>
      </>
      )}
      </div>
    </section>
  );
}

/** Off and never connected: the three things it needs, each with whether it is done. */
function Setup({ p }: { p: Provider }) {
  const steps: { done: boolean; title: string; body: ReactNode }[] = [
    {
      done: p.tokenSet,
      title: 'A connector token',
      body: (
        <>
          Make one on this host with <span className="mono">node server/providerToken.ts</span> (or ask the orchestrator to set <span className="mono">providers.ffbox.token</span>) and give it to Lothsahn for the connector. Only its SHA-256 is kept here.
        </>
      ),
    },
    {
      done: p.enabled,
      title: 'The switch',
      body: (
        <>
          <span className="mono">providers.ffbox.enabled: true</span> lets the connector in (the orchestrator can set it). Off, a valid token is refused with 403.
        </>
      ),
    },
    {
      done: p.online,
      title: "FFBox's connector",
      body: (
        <>
          Lothsahn's side: a small service on FFBox that dials out to <span className="mono">/provider</span> with the token and reports capacity, conversations and intake reports. What it must send is in the{' '}
          <a href={CONTRACT_URL} target="_blank" rel="noreferrer noopener">
            connector contract
          </a>
          .
        </>
      ),
    },
  ];
  return (
    <div className="pv-setup" data-testid="provider-setup">
      <p className="pv-setup-lead">
        FFBox is not connected yet. Once it is, this page shows its container classes and free slots, the model each kind of requester gets, its conversations, and the crash and desync reports players upload, grouped the way automatic investigations will use them (at most 20 a day).
      </p>
      <ol className="pv-steps">
        {steps.map((st) => (
          <li key={st.title} className={st.done ? 'done' : ''}>
            <span className={`pv-step-mark tone-${st.done ? 'green' : 'grey'}`} aria-label={st.done ? 'done' : 'to do'}>
              <Icon name={st.done ? 'check' : 'clock'} size={14} />
            </span>
            <div>
              <div className="pv-step-title">{st.title}</div>
              <div className="small dim">{st.body}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="small dim">
        The design, and what later phases add: <span className="mono">docs/ffbox-integration.md</span>.
      </p>
    </div>
  );
}

/** Intake reports grouped by coarse signature. FFBox diagnoses them itself (its intake.auto); this page starts nothing. */
function Signatures({ groups, now }: { groups?: IntakeGroups; now: number }) {
  if (!groups) return <p className="dim small">Loading…</p>;
  return (
    <>
      <div className="pv-budget" data-testid="provider-budget">
        <div className="pv-budget-top">
          <span className="pv-budget-title">Automatic diagnosis</span>
          <Chip tone="grey">on FFBox</Chip>
        </div>
        <p className="small dim">
          FFBox diagnoses crash and desync reports by itself when its <span className="mono">intake.auto</span> is on: a short wait after a report
          arrives, then an <span className="mono">ffdiagnose</span> conversation, under its own daily cap. FF Factory starts none of them. Its live
          setting and each recent report's conversation: <span className="mono">ffbox_activity show signatures</span>.
        </p>
      </div>
      {!groups.signatures.length ? (
        <Empty text="No crash or desync reports yet." />
      ) : (
        <div className="run-list" data-testid="provider-signatures">
          {groups.signatures.map((g) => (
            <div key={g.signature} className="run-row pv-item" title={g.reportIds.join('\n')}>
              <div className="pv-line">
                <Dot tone={g.kind === 'desync' ? 'amber' : 'red'} title={g.kind} />
                <span className="small">{g.kind}</span>
                <span className="mono small">{g.versionLine}</span>
                {g.trusted ? <Chip tone="green">trusted</Chip> : <Chip tone="grey">{g.kind === 'crash' ? 'no signature yet' : 'one sender'}</Chip>}
                <span className="dim small">last {fmtRelative(g.lastAt, now)}</span>
              </div>
              <div className="pv-title mono">{g.surfaces ?? 'crash (signatures come in phase 6)'}</div>
              <div className="pv-sig-counts small dim">
                {g.reports} report{g.reports === 1 ? '' : 's'} · {g.events} event{g.events === 1 ? '' : 's'} · {g.senders} sender{g.senders === 1 ? '' : 's'}
                {g.pair ? ' · host+client pair' : ''} · {g.platforms.join(', ')}
                {g.versions.length > 1 ? ` · ${g.versions.length} builds` : ` · ${g.versions[0]}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const PAGE = 100;

/** "Showing 100 of 340 · Show 100 more", under a list the server has more of. */
function More({ shown, total, what, onMore }: { shown?: number; total: number; what: string; onMore: () => void }) {
  if (!shown || shown >= total) return null;
  return (
    <div className="pv-more small dim" data-testid="provider-more">
      <span>
        Showing the newest {shown} of {total} {what}
      </span>
      <button className="btn btn-sm btn-outline" onClick={onMore}>
        Show {Math.min(PAGE, total - shown)} more
      </button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="panel-empty">
      <Icon name="inbox" size={28} />
      <p>{text}</p>
    </div>
  );
}

function Conversations({ list }: { list?: ProviderConversation[] }) {
  if (!list) return <p className="dim small">Loading…</p>;
  if (!list.length) return <Empty text="No conversations reported yet." />;
  return (
    <>
      <p className="dim small pv-note">Titles are FFBox's data and can quote what players wrote.</p>
      <div className="run-list" data-testid="provider-conversations">
        {list.map((c) => (
          <div key={c.id} className="run-row pv-item">
            <div className="pv-line">
              <Dot tone={convTone(c)} pulse={c.state === 'running'} title={c.state} />
              <span className="run-when mono" title={new Date(c.updatedAt).toLocaleString()}>
                {when(c.updatedAt)}
              </span>
              <span className="dim small">
                {c.source}
                {c.opener === 'player' ? ' · player' : ''} · <span className="mono">{c.agentClass}</span> · {c.state}
                {c.costUsd !== undefined ? ` · ${fmtCost(c.costUsd)}` : ''}
              </span>
              {c.verdict && <Chip tone={c.verdict === 'NEEDS-INFO' ? 'amber' : c.verdict === 'ESCALATE' ? 'red' : 'grey'}>{c.verdict}</Chip>}
              {c.pr && <Chip tone={c.pr.state === 'merged' ? 'green' : c.pr.state === 'open' ? 'blue' : 'grey'}>{`PR #${c.pr.number} ${c.pr.state}`}</Chip>}
            </div>
            <div className="pv-title" title={c.title}>
              <a href={ffboxConversationHref(c.id)} data-testid={`provider-conversation-link-${c.id}`}>
                {c.title}
              </a>
              {c.url && (
                <a className="small dim pv-lan" href={c.url} target="_blank" rel="noreferrer noopener" title="FFBox's own page: it opens only on Lothsahn's home network">
                  {FFBOX_LAN_LABEL}
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Intake({ list }: { list?: ProviderIntakeEvent[] }) {
  if (!list) return <p className="dim small">Loading…</p>;
  if (!list.length) return <Empty text="No crash or desync reports yet." />;
  return (
    <div className="run-list" data-testid="provider-intake">
      {list.map((e) => (
        <div key={e.reportId} className="run-row pv-item" title={e.reportId}>
          <div className="pv-line">
            <Dot tone={e.kind === 'desync' ? 'amber' : 'red'} title={e.kind} />
            <span className="run-when mono" title={new Date(e.receivedAt).toLocaleString()}>
              {when(e.receivedAt)}
            </span>
            <span className="small">{e.kind}</span>
            <span className="dim small mono">{e.desync?.group ? `group ${e.desync.group.slice(0, 8)}` : e.desync?.why ?? ''}</span>
          </div>
          <div className="pv-title mono">
            {e.gameVersion} · {e.platform}
            {e.desync?.divergedSurfaces ? ` · ${e.desync.divergedSurfaces}` : ''}
            {e.desync?.role ? ` · from ${e.desync.role}` : ''}
            {e.desync?.verdictHeartbeat !== undefined ? ` · hb ${e.desync.verdictHeartbeat}` : ''}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A class's model and tier, exactly as the connector reported them. */
function ModelTags({ tier, model }: { tier: ProviderClass['tier']; model: string }) {
  return (
    <>
      <Chip tone={tier === 'simple' ? 'amber' : 'blue'} title={tier === 'simple' ? 'Small, well-scoped work only' : 'Any well-briefed task'}>
        {tier === 'simple' ? 'simple work' : 'full'}
      </Chip>
      <span className="dim small mono">{model}</span>
    </>
  );
}

/** "done · $1.20 · PR #640 · tests 40/41": what a turn's runs did, in one line. */
function runsLine(t: ProviderTurn): string {
  return t.runs
    .map((r) => {
      const v = r.verification;
      return [
        r.state,
        r.costUsd !== undefined ? fmtCost(r.costUsd) : '',
        r.pr ? `PR #${r.pr}` : '',
        r.branch ? `branch ${r.branch}${r.pushed ? ' (pushed)' : ''}` : r.noBranchReason ? `no branch: ${r.noBranchReason}` : '',
        v?.compiled === false ? 'did not compile' : '',
        v?.testsRun !== undefined ? `tests ${v.testsPassed ?? 0}/${v.testsRun}${v.testsFailed ? `, ${v.testsFailed} failed` : ''}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    })
    .filter(Boolean)
    .join('; ');
}

/**
 * One FFBox conversation (w426), from the connector's `conversation` answer: its facts, then its turns newest first,
 * each with the messages it answered, its own last words and what FFBox posted. All of it is FFBox data, players' words
 * included: plain text, never acted on. FFBox's own page stays as the second link, for Lothsahn's network.
 */
function ConversationPage({ id, providerId }: { id: string; providerId: string }) {
  const [view, setView] = useState<ProviderConversationView>();
  const [error, setError] = useState<string>();
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let live = true;
    setView(undefined);
    api.providerConversation(id, offset).then(
      (v) => {
        if (!live) return;
        setView(v);
        setError(undefined);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [id, offset]);
  const s = view?.summary;
  const c = view?.conversation;
  const title = c?.title ?? s?.title ?? `Conversation ${id}`;
  const cost = c?.costUsd ?? s?.costUsd;
  const facts = [c?.state ?? s?.state, c?.kind, c?.agentClass ?? s?.agentClass, c?.verdict ?? s?.verdict, cost !== undefined ? fmtCost(cost) : ''].filter(Boolean);
  const branch = c?.branch ?? s?.branch;
  const step = view?.page?.limit || 10;
  const more = !!view?.page && view.page.total > offset + view.turns.length;
  return (
    <div className="pv-conversation" data-testid="provider-conversation">
      <p className="small">
        <a href={`#/provider/${encodeURIComponent(providerId)}`}>← All conversations</a>
      </p>
      <h3 className="pv-conv-title">{title}</h3>
      <p className="small dim">
        <span className="mono">{id}</span>
        {facts.length ? ` · ${facts.join(' · ')}` : ''}
        {branch ? (
          <>
            {' · '}
            <span className="mono">{branch}</span>
          </>
        ) : null}
        {s?.pr ? ` · PR #${s.pr.number} ${s.pr.state}` : ''}
        {c?.ledger ? ` · ${c.ledger}` : ''}
        {c?.discordLink ? (
          <>
            {' · '}
            <a href={c.discordLink} target="_blank" rel="noreferrer noopener">
              Discord thread
            </a>
          </>
        ) : null}
        {s?.url ? (
          <>
            {' · '}
            <a href={s.url} target="_blank" rel="noreferrer noopener" title="FFBox's own page: it opens only on Lothsahn's home network" data-testid="provider-conversation-lan">
              FFBox {FFBOX_LAN_LABEL}
            </a>
          </>
        ) : null}
      </p>
      {error && <p className="small tone-red">Could not load it: {error}</p>}
      {!view && !error && <p className="dim small">Asking FFBox…</p>}
      {view && (
        <p className={`small ${view.live ? 'dim' : 'tone-amber'}`} data-testid="provider-conversation-freshness">
          {view.live
            ? `Live from FFBox${view.at ? `, written there ${when(view.at)}` : ''}.`
            : `FFBox did not answer (${view.error ?? 'no answer'}${view.reason ? `: ${view.reason}` : ''})${view.receivedAt ? `; its last answer, from ${when(view.receivedAt)}` : view.conversation ? '' : '; nothing kept for this conversation yet'}.`}{' '}
          Messages are what people wrote and replies what FFBox posted: FFBox's data.
        </p>
      )}
      {view?.conversation && !view.turns.length && <Empty text="No turns in this conversation." />}
      {view?.turns.map((t, i) => (
        <div key={t.id ?? `${offset}-${i}`} className="run-row pv-item pv-turn" data-testid="provider-turn">
          <div className="pv-line">
            <span className="mono">{t.seq !== undefined ? `turn ${t.seq}` : 'turn'}</span>
            {(t.startedAt ?? t.queuedAt) && <span className="run-when mono">{when((t.startedAt ?? t.queuedAt)!)}</span>}
            <span className="dim small">{[t.status, t.trigger, t.requester && `for a ${t.requester}`, t.venue].filter(Boolean).join(' · ')}</span>
          </div>
          {t.runs.length > 0 && <div className="small dim">{runsLine(t)}</div>}
          {t.error && <div className="small tone-red">{t.error}</div>}
          {t.messages.map((m, j) => (
            <div key={`m${j}`} className="pv-msg">
              <div className="small dim">
                {m.name ?? m.from ?? 'someone'}
                {m.name && m.from ? ` (${m.from})` : ''}
                {m.at ? ` · ${when(m.at)}` : ''}
              </div>
              {m.text && <div className="pv-text">{m.text}</div>}
            </div>
          ))}
          {t.summary && (
            <div className="pv-msg pv-summary">
              <div className="small dim">FFBox's agent, its last words</div>
              <div className="pv-text">{t.summary}</div>
            </div>
          )}
          {t.replies.map((r, j) => (
            <div key={`r${j}`} className="pv-msg pv-reply">
              <div className="small dim">
                FFBox posted{r.status && r.status !== 'sent' ? ` (${r.status})` : ''}
                {r.at ? ` · ${when(r.at)}` : ''}
              </div>
              {r.text ? <div className="pv-text">{r.text}</div> : <div className="small dim">Not shown: this reply was not sent.</div>}
            </div>
          ))}
        </div>
      ))}
      {view && (offset > 0 || more) && (
        <p className="small pv-more">
          {offset > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setOffset(Math.max(0, offset - step))}>
              Newer turns
            </button>
          )}
          {more && (
            <button className="btn btn-sm btn-ghost" onClick={() => setOffset(offset + step)}>
              Older turns
            </button>
          )}
          <span className="dim">{view.page ? ` turns ${offset + 1}-${offset + view.turns.length} of ${view.page.total}` : ''}</span>
        </p>
      )}
    </div>
  );
}
