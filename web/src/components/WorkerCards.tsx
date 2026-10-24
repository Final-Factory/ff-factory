// The Overview's Workers mode (w1837): one compact card per worker, grouped by what it needs (a person, nothing: working,
// held up, resting), with filters by group, person and machine. The cards and their order are shared/workerCards.ts; this
// draws them from the fleet the machine view already built (fleetFor), so the mode adds no polling.
import { useMemo, useState } from 'react';
import { agentQueueAll } from '../../../shared/queueWaits';
import type { AppState } from '../../../shared/types';
import type { FleetComputer } from '../../../shared/fleet';
import {
  CARD_GROUPS,
  CARD_GROUP_LABEL,
  CARD_GROUP_TONE,
  OVERVIEW_FILTER_KEY,
  filterCards,
  filterChoices,
  groupCounts,
  readFilter,
  shortAge,
  workerCards,
  writeFilter,
  type CardFilter,
  type CardGroup,
  type WorkerCard,
} from '../../../shared/workerCards';
import { fmtCost, fmtRelative, localTime, lsGet, lsSet, navigate } from '../util';
import { Dot } from './ui';

/** The board's filters, kept in this browser across reloads, as the Dispatcher's state chips are (w418). */
function useCardFilter(): [CardFilter, (f: CardFilter) => void] {
  const [f, setF] = useState<CardFilter>(() => readFilter(lsGet(OVERVIEW_FILTER_KEY)));
  return [
    f,
    (next) => {
      setF(next);
      lsSet(OVERVIEW_FILTER_KEY, writeFilter(next));
    },
  ];
}

function Card({ c, now }: { c: WorkerCard; now: number }) {
  const open = () => navigate({ view: 'msandbox', machineId: c.machineId, sandboxId: c.sandbox, sessionId: c.id });
  const where = `${c.machine}/${c.sandbox}`;
  const hint = [c.requestTitle && c.request ? `${c.request}: ${c.requestTitle}` : c.session.title, `${c.word} for ${fmtRelative(c.since, now).replace(' ago', '')}${c.doing ? `: ${c.doing}` : ''}`, `${where}${c.person ? ` · for ${c.person}` : ''} · worker ${c.id}`].join('\n');
  return (
    <article className={`wc-card wc-${c.tone}${c.group === 'resting' ? ' wc-quiet' : ''}`} data-testid="wc-card" data-status={c.status}>
      <div className="wc-top">
        <span className={`wc-status tone-${c.tone}`} data-testid="wc-status">
          <Dot tone={c.tone} pulse={c.session.status === 'running' || c.session.status === 'starting'} />
          <span className="wc-word">{c.word}</span>
        </span>
        <span className="wc-age" title={`${c.word} since ${new Date(c.since).toLocaleString()}`} data-testid="wc-age">
          {shortAge(c.since, now)}
        </span>
        <span className="spacer" />
        {/* The machine view's quiet "Live view: go" chip (w1599), smaller: a view you may watch. */}
        {c.live && (
          <button type="button" className="fl-chip fl-call-quiet wc-live" onClick={() => navigate({ view: 'live', sessionId: c.id })} title="Its Live view is up: open it" data-testid="wc-live">
            <span className="lv-rec" aria-hidden />
            Live view
          </button>
        )}
      </div>
      <button type="button" className="wc-open" onClick={open} title={hint} data-testid="wc-open">
        <span className="wc-title">{c.title}</span>
      </button>
      <div className="wc-doing" title={c.tool ? `In the tool ${c.doing}` : c.doing}>
        {c.tool ? (
          <>
            Using <span className="mono wc-tool">{c.doing}</span>
          </>
        ) : (
          (c.doing ?? '\u00a0')
        )}
      </div>
      <div className="wc-foot">
        <span className="wc-meta">
          {/* Every card's foot reads alike: a dash where it serves no request. */}
          <span className="mono wc-req" title={c.request ? undefined : 'Not on a request'}>
            {c.request ?? '—'}
          </span>
          {c.person && <span className="wc-person">{c.person}</span>}
          {/* The machine's name gives way before the slot. */}
          <span className="wc-where" title={where}>
            <span className="wc-machine">{c.machine}</span>/{c.sandbox}
          </span>
        </span>
        {c.pr &&
          (c.pr.url ? (
            <a className="wc-pr" href={c.pr.url} target="_blank" rel="noreferrer" title={`${c.pr.repo}#${c.pr.number} (${c.pr.state})`} data-testid="wc-pr">
              #{c.pr.number}
            </a>
          ) : (
            <span className="wc-pr" title={`${c.pr.repo}#${c.pr.number} (${c.pr.state})`}>
              #{c.pr.number}
            </span>
          ))}
        {c.costUsd > 0 && (
          <span className="wc-cost" title="What this worker has cost so far">
            {fmtCost(c.costUsd)}
          </span>
        )}
      </div>
    </article>
  );
}

/** The filter bar: one chip per group with its count (several may be on), then a person and a machine. */
function Filters({ cards, f, set }: { cards: WorkerCard[]; f: CardFilter; set: (f: CardFilter) => void }) {
  const { people, machines } = filterChoices(cards);
  const n = groupCounts(filterCards(cards, { ...f, groups: [] }));
  const total = CARD_GROUPS.reduce((s, g) => s + n[g], 0);
  const toggle = (g: CardGroup) => set({ ...f, groups: f.groups.includes(g) ? f.groups.filter((x) => x !== g) : [...f.groups, g] });
  const any = f.groups.length > 0 || !!f.person || !!f.machine;
  return (
    <div className="wc-bar" role="toolbar" aria-label="Show workers by status, person or machine" data-testid="wc-filters">
      <div className="wc-chips">
        <button className={`ledger-state${f.groups.length === 0 ? ' on' : ''}`} aria-pressed={f.groups.length === 0} onClick={() => set({ ...f, groups: [] })} data-testid="wc-group-all">
          All <span className="mono">{total}</span>
        </button>
        {CARD_GROUPS.map((g) => (
          <button key={g} className={`ledger-state${f.groups.includes(g) ? ' on' : ''}`} aria-pressed={f.groups.includes(g)} onClick={() => toggle(g)} data-testid={`wc-group-${g}`}>
            <Dot tone={CARD_GROUP_TONE[g]} /> {CARD_GROUP_LABEL[g]} <span className="mono">{n[g]}</span>
          </button>
        ))}
      </div>
      <div className="wc-selects">
        <select className="input input-sm wc-select" value={f.person ?? ''} onChange={(e) => set({ ...f, person: e.target.value || undefined })} aria-label="Whose requests" data-testid="wc-person">
          <option value="">Everyone</option>
          {f.person && !people.includes(f.person) && <option value={f.person}>{f.person}</option>}
          {people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className="input input-sm wc-select" value={f.machine ?? ''} onChange={(e) => set({ ...f, machine: e.target.value || undefined })} aria-label="Which machine" data-testid="wc-machine">
          <option value="">All machines</option>
          {f.machine && !machines.some((m) => m.id === f.machine) && <option value={f.machine}>{f.machine}</option>}
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {/* Kept in its place while hidden, so the menus do not move when it comes. */}
        <button className={`link-btn small${any ? '' : ' wc-hidden'}`} onClick={() => set({ groups: [] })} aria-hidden={!any} tabIndex={any ? undefined : -1} data-testid="wc-clear">
          Clear
        </button>
      </div>
    </div>
  );
}

/**
 * The cards, once per change of what they read; empty while the Overview shows machines (`on` false), so the machine view
 * computes nothing more. The page's header counts them in this mode (cardsSummary), so its numbers and the chips agree.
 */
export function useWorkerCards(app: AppState, fleet: FleetComputer[], now: number, on: boolean): WorkerCard[] {
  const views = app.config.live?.enabled ? app.live : undefined;
  const me = app.me?.displayName;
  // w1968: the machines' queues, so a worker waiting in a bench queue reads Blocked on it, as list_work does.
  const queue = useMemo(() => agentQueueAll(app.machineStats), [app.machineStats]);
  return useMemo(() => (on ? workerCards(fleet, { work: app.work, views, me, now, time: localTime, queue }) : []), [on, fleet, app.work, views, me, now, queue]);
}

export function WorkerBoard({ cards, now, scrollRef }: { cards: WorkerCard[]; now: number; scrollRef: (el: HTMLDivElement | null) => void }) {
  const [f, setF] = useCardFilter();
  const shown = filterCards(cards, f);
  const groups = CARD_GROUPS.map((g) => ({ g, list: shown.filter((c) => c.group === g) })).filter((x) => x.list.length);
  return (
    <div className="wc-board" data-testid="worker-board">
      <div className="wc-scroll" ref={scrollRef}>
        <Filters cards={cards} f={f} set={setF} />
        {groups.map(({ g, list }) => (
          <section key={g} className="wc-group" data-testid={`wc-section-${g}`}>
            <h3 className="wc-group-head">
              <Dot tone={CARD_GROUP_TONE[g]} />
              {CARD_GROUP_LABEL[g]}
              <span className="wc-group-n">{list.length}</span>
            </h3>
            <div className="wc-grid">
              {list.map((c) => (
                <Card key={c.id} c={c} now={now} />
              ))}
            </div>
          </section>
        ))}
        {!shown.length && (
          <p className="side-empty wc-empty" data-testid="wc-empty">
            {cards.length ? (
              <>
                No worker matches these filters.{' '}
                <button className="link-btn" onClick={() => setF({ groups: [] })}>
                  Show them all
                </button>
              </>
            ) : (
              'No workers are running. Ask your orchestrator for work and they show here.'
            )}
          </p>
        )}
      </div>
    </div>
  );
}
