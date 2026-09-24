// What waits on the user, everywhere at once: agents asking for a permission, Unity editors stuck on
// a dialog, and standing agents' delegation requests. The sidebar lists them, the phone's bell and the
// tab title count them, and each one opens the place where it is answered.
import { useMemo } from 'react';
import type { AppState, SessionInfo } from '../../shared/types';
import { summarizeToolInput, toolDisplayName } from './components/toolSummary';
import { focusDetails, focusPermission } from './store';
import { displayName, navigate, type Route } from './util';

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

/** Where a session's conversation is shown. */
export function sessionRoute(s: SessionInfo, orchestratorId: string): Route {
  if (s.id === orchestratorId) return { view: 'home' };
  if (s.sandboxId) return { view: 'sandbox', sandboxId: s.sandboxId, sessionId: s.id };
  if (s.standingId) return { view: 'agent', agentId: s.standingId, tab: 'conversation' };
  if (s.machineId) return { view: 'machine', machineId: s.machineId, sessionId: s.id };
  return { view: 'session', sessionId: s.id };
}

export function attentionItems(app: AppState): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const s of app.sessions) {
    for (const p of s.pendingPermissions) {
      const what = summarizeToolInput(p.toolName, p.input);
      items.push({
        key: `p:${p.requestId}`,
        kind: 'permission',
        title: s.id === app.orchestratorId ? 'Orchestrator' : s.title,
        detail: `Allow ${toolDisplayName(p.toolName).tool}${what ? `: ${what}` : '?'}`,
        at: p.createdAt,
        open: () => {
          navigate(sessionRoute(s, app.orchestratorId));
          focusPermission(p.requestId);
        },
      });
    }
  }
  for (const sb of app.sandboxes) {
    if (sb.unity.state !== 'blocked') continue;
    const b = sb.unity.blocked;
    items.push({
      key: `u:${sb.id}`,
      kind: 'unity',
      title: displayName(sb),
      detail: b?.reason === 'dialog' && b.title ? `Unity is stuck on “${b.title}”` : b?.reason === 'elevated' ? 'Unity is running as administrator' : 'Unity has gone quiet',
      at: b?.since ?? sb.createdAt,
      open: () => {
        navigate({ view: 'sandbox', sandboxId: sb.id });
        focusDetails(sb.id);
      },
    });
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

export function useAttention(app: AppState | null): AttentionItem[] {
  return useMemo(() => (app ? attentionItems(app) : []), [app]);
}
