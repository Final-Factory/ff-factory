import { createContext, useContext, useMemo } from 'react';
import type { AppState } from '../../../shared/types';
import { buildIdIndex, isIdCandidate, linkIdsInTree, resolveIdToken, type IdHastNode, type IdIndex, type IdTarget } from '../../../shared/idLinks';
import { sessionRoute } from '../attention';
import { sessionIndex, useStore } from '../store';
import { href, type Route } from '../util';

/**
 * Clickable ids in a chat (w6216, shared/idLinks.ts): set by the orchestrator's view (OrchestratorView) around its
 * transcript, so the Markdown inside it links the sessions, sandboxes, machines and requests its messages name. Off
 * elsewhere: reports, cards and worker transcripts are drawn as before.
 */
export const IdLinksOn = createContext(false);

/** The words that name a machine on this page, as one string: it changes only when a machine is added or renamed. */
const machineKey = (app: AppState | null) => (app ? app.machines.map((m) => `${m.id}\t${m.name ?? ''}`).join('\n') : '');

/**
 * The rehype plugin for this chat's Markdown, or undefined when it links nothing: every word shaped like an id
 * (isIdCandidate) outside links and code becomes a span that resolves itself (IdRef), so the message is not drawn again
 * when a session starts or a request is filed; only that span is.
 */
export function useIdLinkPlugin(): (() => (tree: IdHastNode) => void) | undefined {
  const on = useContext(IdLinksOn);
  const key = useStore((s) => (on ? machineKey(s.app) : ''));
  return useMemo(() => {
    if (!on) return undefined;
    const words = new Set<string>();
    for (const line of key.split('\n').filter(Boolean)) {
      const [id, name] = line.split('\t');
      words.add(id).add(id.toUpperCase());
      if (name) words.add(name);
    }
    const wrap = (token: string): IdHastNode | undefined =>
      isIdCandidate(token, words) ? { type: 'element', tagName: 'span', properties: { dataIdToken: token }, children: [{ type: 'text', value: token }] } : undefined;
    return () => (tree: IdHastNode) => linkIdsInTree(tree, wrap);
  }, [on, key]);
}

let cached: { sessions: unknown; machines: unknown; work: unknown; ix: IdIndex } | undefined;

/** This state's index, built once per sessions, machines and work lists (a portal holds thousands of sessions). */
function idIndex(app: AppState): IdIndex {
  if (cached && cached.sessions === app.sessions && cached.machines === app.machines && cached.work === app.work) return cached.ix;
  const ix = buildIdIndex({ sessions: app.sessions, machines: app.machines, work: app.work });
  cached = { sessions: app.sessions, machines: app.machines, work: app.work, ix };
  return ix;
}

/** The dashboard page a target opens: the same right-panel page the sidebar opens for it. */
export function routeOf(t: IdTarget, app: AppState): Route | undefined {
  switch (t.kind) {
    case 'request':
      return { view: 'dispatcher', tab: t.id };
    case 'machine':
      return { view: 'machine', machineId: t.machineId };
    case 'sandbox':
      return { view: 'msandbox', machineId: t.machineId, sandboxId: t.sandboxId };
    case 'session': {
      const s = sessionIndex(app.sessions).get(t.sessionId);
      // The orchestrator's own chat is this page: a link to it would go nowhere.
      return s && s.id !== app.orchestratorId ? sessionRoute(s, app) : undefined;
    }
  }
}

const KIND_LABEL: Record<IdTarget['kind'], string> = { session: 'worker', sandbox: 'sandbox', machine: 'machine', request: 'request' };

/** A word shaped like an id: a link while this page knows exactly one thing it names, else its text. */
export function IdRef({ token }: { token: string }) {
  const link = useStore((s) => {
    if (!s.app) return '';
    const t = resolveIdToken(token, idIndex(s.app));
    const r = t && routeOf(t, s.app);
    return r && t ? `${t.kind} ${href(r)}` : '';
  });
  if (!link) return <>{token}</>;
  const [kind, to] = [link.slice(0, link.indexOf(' ')) as IdTarget['kind'], link.slice(link.indexOf(' ') + 1)];
  return (
    <a className="id-link" href={to} data-id-kind={kind} title={`Open ${KIND_LABEL[kind]} ${token}`}>
      {token}
    </a>
  );
}
