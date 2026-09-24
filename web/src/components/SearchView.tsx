import { useEffect, useRef, useState } from 'react';
import type { AppState, SearchHit } from '../../../shared/types';
import { api } from '../api';
import { focusEvent, toastError } from '../store';
import { displayName, navigate, type Route } from '../util';
import { Icon } from './ui';

/** Where a hit's session lives in the app, and a label for it. */
function placeOf(h: SearchHit): { route: Route; label: string } {
  if (h.sessionKind === 'orchestrator') return { route: { view: 'home' }, label: 'Orchestrator' };
  if (h.sandboxId) return { route: { view: 'sandbox', sandboxId: h.sandboxId, sessionId: h.sessionId }, label: `slot ${h.sandboxId}` };
  if (h.standingId) return { route: { view: 'agent', agentId: h.standingId, tab: 'conversation' }, label: `standing · ${h.standingId}` };
  if (h.machineId) return { route: { view: 'machine', machineId: h.machineId, sessionId: h.sessionId }, label: `machine ${h.machineId}` };
  return { route: { view: 'session', sessionId: h.sessionId }, label: '' };
}

/** The snippet with every search term marked. */
function Highlighted({ text, q }: { text: string; q: string }) {
  const words = [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).toLowerCase()).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) =>
        words.includes(part.toLowerCase()) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

const KIND_LABEL: Partial<Record<SearchHit['kind'], string>> = { user: 'message', assistant: 'reply', tool_use: 'tool call', tool_result: 'tool output', thinking: 'thinking', result: 'turn end', error: 'error', system: 'note', permission: 'permission' };

/** Full-text search across every transcript (server/search.ts); a hit opens its session at that event. */
export function SearchView({ app, initial }: { app: AppState; initial?: string }) {
  const [q, setQ] = useState(initial ?? '');
  const [place, setPlace] = useState('');
  const [agent, setAgent] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [result, setResult] = useState<{ hits: SearchHit[]; scanned: number; ms: number; q: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const run = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const [kind, id] = place.split(':');
      const r = await api.search({ q: q.trim(), [kind]: id || undefined, agent: agent.trim() || undefined, since: since || undefined, until: until || undefined });
      setResult({ ...r, q: q.trim() });
      history.replaceState(null, '', `#/search/${encodeURIComponent(q.trim())}`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    input.current?.focus();
    if (initial) void run();
  }, []);

  const open = (h: SearchHit) => {
    focusEvent(h.sessionId, h.seq);
    navigate(placeOf(h).route);
  };

  return (
    <section className="search-view">
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="search-input">
          <Icon name="search" size={16} />
          <input ref={input} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder='Search every transcript… ("quoted phrase" works)' enterKeyHint="search" />
          <button className="btn btn-primary" disabled={!q.trim() || busy}>
            {busy ? <span className="spinner spinner-dark" /> : 'Search'}
          </button>
        </div>
        <div className="search-filters">
          <select className="input" value={place} onChange={(e) => setPlace(e.target.value)} aria-label="Where">
            <option value="">Everywhere</option>
            {app.sandboxes.map((s) => (
              <option key={s.id} value={`sandbox:${s.id}`}>
                {displayName(s)} (slot {s.id})
              </option>
            ))}
            {app.machines.map((m) => (
              <option key={m.id} value={`machine:${m.id}`}>
                {displayName(m)} (machine {m.id})
              </option>
            ))}
          </select>
          <input className="input" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="Agent (title, id, orchestrator)" list="search-agents" />
          <datalist id="search-agents">
            <option value="orchestrator" />
            {app.sessions
              .filter((s) => s.kind !== 'orchestrator')
              .map((s) => (
                <option key={s.id} value={s.title} />
              ))}
          </datalist>
          <label className="search-date">
            <span className="dim small">from</span>
            <input className="input" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
          <label className="search-date">
            <span className="dim small">to</span>
            <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
        </div>
      </form>
      <div className="search-results">
        {result && (
          <p className="dim small">
            {result.hits.length ? `${result.hits.length}${result.hits.length >= 100 ? '+' : ''} match(es)` : 'No matches'} in {result.scanned} transcript(s), {result.ms} ms.
          </p>
        )}
        {result?.hits.map((h) => {
          const p = placeOf(h);
          return (
            <button key={`${h.sessionId}:${h.seq}`} className="search-hit" onClick={() => open(h)}>
              <div className="search-hit-head">
                <span className="search-hit-title ellipsis">{h.title}</span>
                {p.label && <span className="chip chip-grey search-where">{p.label}</span>}
                <span className="dim small">{KIND_LABEL[h.kind] ?? h.kind}</span>
                <span className="spacer" />
                <time className="dim small mono">{new Date(h.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
              </div>
              <div className="search-snippet">
                <Highlighted text={h.snippet} q={result.q} />
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
