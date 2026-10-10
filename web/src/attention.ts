// What waits on the user, everywhere at once: agents asking for a permission, Unity editors stuck on
// a dialog, and standing agents' delegation requests. The sidebar lists them, the phone's bell and the
// tab title count them, and each one opens the place where it is answered.
import type { AppState, SessionInfo } from '../../shared/types';
import { summarizeToolInput, toolDisplayName } from './components/toolSummary';
import { focusPermission } from './store';
import { navigate, type Route } from './util';

export interface AttentionItem {
  key: string;
  kind: 'permission' | 'unity' | 'delegation';
  /** Who or where: the agent, the sandbox, the standing agent. */
  title: string;
  /** What it wants, in one line. */
  detail: string;
  at: string;
  open: () => void;
}

/**
 * Where a session's conversation is shown: your own orchestrator on the home page, someone else's on theirs, the
 * dispatcher on its page (docs/orchestrators.md).
 */
export function sessionRoute(s: SessionInfo, app: Pick<AppState, 'orchestratorId'>): Route {
  if (s.id === app.orchestratorId) return { view: 'home' };
  if (s.kind === 'orchestrator' && s.orchestratorRole === 'personal' && s.requestedBy) return { view: 'chat', userId: s.requestedBy.userId };
  if (s.kind === 'orchestrator' && s.orchestratorRole === 'dispatcher') return { view: 'dispatcher', tab: 'conversation' };
  if (s.standingId) return { view: 'agent', agentId: s.standingId, tab: 'conversation' };
  if (s.machineId && s.machineSandbox) return { view: 'msandbox', machineId: s.machineId, sandboxId: s.machineSandbox, sessionId: s.id };
  if (s.machineId) return { view: 'machine', machineId: s.machineId, sessionId: s.id };
  return { view: 'session', sessionId: s.id };
}

export function attentionItems(app: AppState): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of app.sessions) {
    // Someone else's orchestrator is theirs to answer; the dispatcher is the owner's.
    if (s.kind === 'orchestrator' && s.id !== app.orchestratorId && (s.orchestratorRole === 'personal' || app.me?.role !== 'owner')) continue;
    // The line says whose worker it is when it is not yours (w891: an owner answers any).
    const forOther = s.kind === 'worker' && s.requestedBy && s.requestedBy.userId.toLowerCase() !== app.me?.userId.toLowerCase() ? ` · for ${s.requestedBy.displayName}` : '';
    for (const p of s.pendingPermissions) {
      const what = summarizeToolInput(p.toolName, p.input);
      items.push({
        key: `p:${p.requestId}`,
        kind: 'permission',
        title: s.id === app.orchestratorId ? 'Orchestrator' : s.kind === 'orchestrator' ? 'Dispatcher' : `${s.title}${forOther}`,
        detail: `Allow ${toolDisplayName(p.toolName).tool}${what ? `: ${what}` : '?'}`,
        at: p.createdAt,
        open: () => {
          navigate(sessionRoute(s, app));
          focusPermission(p.requestId);
        },
      });
    }
  }
  for (const d of app.delegations) {
    if (d.status !== 'pending') continue;
    items.push({
      key: `d:${d.id}`,
      kind: 'delegation',
      title: d.agentName,
      detail: `Wants a worker: ${d.title}`,
      at: d.createdAt,
      open: () => navigate({ view: 'agent', agentId: d.agentId, tab: 'delegations' }),
    });
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

const attentionCache = new WeakMap<AppState, AttentionItem[]>();

/** The attention list, worked out once per state (the shell, the sidebar and the Overview all ask for it). */
export function useAttention(app: AppState | null): AttentionItem[] {
  if (!app) return NONE;
  let items = attentionCache.get(app);
  if (!items) {
    items = attentionItems(app);
    attentionCache.set(app, items);
  }
  return items;
}

const NONE: AttentionItem[] = [];
