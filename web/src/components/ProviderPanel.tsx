// FFBox's page (docs/ffbox-integration.md): what its connector reports, read-only. The header shows the
// connection and each container class (network, model, tier, free slots); the tabs list its conversations and
// the crash/desync reports ffintake filed, newest first. Titles are FFBox's data and can quote players: they
// are shown as plain text, never acted on.
import { useEffect, useState } from 'react';
import type { Provider, ProviderConversation, ProviderIntakeEvent } from '../../../shared/types';
import { api } from '../api';
import { fmtCost, fmtRelative, navigate, providerGlance, useNow, type Glance } from '../util';
import { Chip, Dot, Icon } from './ui';

type Tab = 'conversations' | 'intake';

const convTone = (c: ProviderConversation): Glance['tone'] =>
  c.state === 'running' || c.state === 'queued' ? 'blue' : c.state === 'blocked' ? 'amber' : c.pr?.state === 'open' ? 'green' : 'grey';

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ProviderPanel({ provider: p, tab, onClose }: { provider: Provider; tab?: string; onClose?: () => void }) {
  const now = useNow(15_000);
  const current: Tab = tab === 'intake' ? 'intake' : 'conversations';
  const setTab = (t: Tab) => navigate({ view: 'provider', providerId: p.id, tab: t === 'conversations' ? undefined : t }, true);
  const [conversations, setConversations] = useState<ProviderConversation[]>();
  const [intake, setIntake] = useState<ProviderIntakeEvent[]>();
  const [error, setError] = useState<string>();
  const g = providerGlance(p, now);

  // Refetch when the summary moves (a new report, a conversation update, a reconnect); the socket carries only the summary.
  const version = `${p.counts.conversations}/${p.counts.active}/${p.counts.intake}/${p.lastIntakeAt}/${p.lastSeen}/${p.online}`;
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      Promise.all([api.providerConversations(200), api.providerIntake(300)]).then(
        ([c, i]) => {
          if (!live) return;
          setConversations(c);
          setIntake(i);
          setError(undefined);
        },
        (e: Error) => live && setError(e.message),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [version]);

  const c = p.capacity;
  return (
    <section className="sb-panel sa-panel pv-panel" data-testid="provider-panel">
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
            <a className="btn btn-sm btn-outline" href={p.web} target="_blank" rel="noreferrer noopener" title="FFBox's own page (on its network)">
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
                  <Chip tone={k.tier === 'simple' ? 'amber' : 'blue'} title={k.tier === 'simple' ? 'Small, well-scoped work only' : 'Any well-briefed task'}>
                    {k.tier === 'simple' ? 'simple work' : 'full'}
                  </Chip>
                  <span className="dim small mono">{k.model}</span>
                  {!k.gpu && <span className="dim small">no GPU</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {c && c.holds.length > 0 && <p className="small tone-amber">Waiting: {c.holds.join(' · ')}</p>}
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={current === 'conversations'} className={`tab${current === 'conversations' ? ' active' : ''}`} onClick={() => setTab('conversations')}>
          Conversations <span className="dim">{p.counts.conversations}</span>
        </button>
        <button role="tab" aria-selected={current === 'intake'} className={`tab${current === 'intake' ? ' active' : ''}`} onClick={() => setTab('intake')}>
          Intake reports <span className="dim">{p.counts.intake}</span>
        </button>
      </nav>

      <div className="sa-scroll">
        {error && <p className="small tone-red">Could not load the lists: {error}</p>}
        {current === 'conversations' && <Conversations list={conversations} />}
        {current === 'intake' && <Intake list={intake} />}
      </div>
    </section>
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
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer noopener">
                  {c.title}
                </a>
              ) : (
                c.title
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
