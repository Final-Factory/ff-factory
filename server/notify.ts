import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { nameWithSlot } from '../shared/labels.ts';
import { bus, emit, type Store } from './store.ts';
import type { SessionHandle, SessionManager } from './sessions.ts';
import type { DelegationRequest, NotifyKind, NotifyPrefs, Sandbox, ServerEvent, SessionInfo, StandingAgent, StandingRun, UnityBlocked } from '../shared/types.ts';

/** A browser's push subscription, as PushSubscription.toJSON() gives it, plus that device's choices. */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user: string;
  prefs: NotifyPrefs;
  createdAt: string;
  /** A label for the settings list ("iPhone", "Chrome on the desktop"), from the user agent. */
  device: string;
}

export const DEFAULT_PREFS: NotifyPrefs = { permission: true, turnEnd: true, error: true, standing: true, delegation: true, unity: true, host: true };

export interface Notice {
  kind: NotifyKind;
  title: string;
  body: string;
  /** Where a click goes, as an app hash route ("#/sandbox/sb1/abc"). */
  url: string;
  /** Same tag = replaces the previous one (per session). */
  tag: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const firstLine = (s: string) => s.split('\n').map((l) => l.replace(/^[\s#>*_`-]+/, '').trim()).find(Boolean) ?? '';

/** The app route for a session: where a notification click lands. */
export function sessionRoute(s: SessionInfo, orchestratorId?: string): string {
  if (s.id === orchestratorId || s.kind === 'orchestrator') return '#/';
  if (s.sandboxId) return `#/sandbox/${encodeURIComponent(s.sandboxId)}/${encodeURIComponent(s.id)}`;
  if (s.standingId) return `#/agent/${encodeURIComponent(s.standingId)}/conversation`;
  if (s.machineId) return `#/machine/${encodeURIComponent(s.machineId)}/${encodeURIComponent(s.id)}`;
  return `#/session/${encodeURIComponent(s.id)}`;
}

/**
 * Notifications (Web Push to every subscribed device, and a `notify` event on the WebSocket for open
 * pages that have no push subscription): a session waiting on a permission, a turn finished, a session
 * erroring, a standing-agent run failing or hitting its budget, a delegation request.
 */
export class Notifier {
  private readonly store: Store;
  private readonly file: string;
  private readonly vapid: { publicKey: string; privateKey: string };
  private subs: PushSub[];
  private readonly lastStatus = new Map<string, SessionInfo['status']>();
  orchestratorId?: () => string | undefined;

  constructor(dataDir: string, store: Store, sessions: SessionManager) {
    this.store = store;
    this.file = path.join(dataDir, 'push-subscriptions.json');
    const keyFile = path.join(dataDir, 'vapid.json');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, JSON.stringify(webpush.generateVAPIDKeys(), null, 2), { mode: 0o600 });
    this.vapid = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    try {
      // A kind added after a device subscribed starts at its default.
      this.subs = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as PushSub[]).map((s) => ({ ...s, prefs: { ...DEFAULT_PREFS, ...s.prefs } }));
    } catch {
      this.subs = [];
    }
    for (const s of store.sessions.values()) this.lastStatus.set(s.id, s.status);

    sessions.events.on('permission', (s: SessionHandle, p: { toolName: string; input: unknown }) =>
      this.fire({ kind: 'permission', title: `${this.name(s.info)} needs you`, body: `Wants to use ${p.toolName}`, url: this.route(s.info), tag: `perm-${s.info.id}` }),
    );
    sessions.events.on('turnEnd', (s: SessionHandle, text: string) => {
      if (s.info.kind === 'standing') return; // runs are reported below, and only when they go wrong
      if (s.info.status === 'error') return;
      this.fire({ kind: 'turnEnd', title: `${this.name(s.info)} finished`, body: clip(firstLine(text || s.info.lastResult || 'Turn finished.'), 180), url: this.route(s.info), tag: `turn-${s.info.id}` });
    });
    // Errors: a session record that turns to 'error'.
    bus.on('event', (e: ServerEvent) => {
      if (e.type !== 'session') return;
      const was = this.lastStatus.get(e.session.id);
      this.lastStatus.set(e.session.id, e.session.status);
      if (e.session.status === 'error' && was !== 'error') {
        this.fire({ kind: 'error', title: `${this.name(e.session)} hit an error`, body: clip(e.session.statusDetail ?? 'The session stopped with an error.', 180), url: this.route(e.session), tag: `err-${e.session.id}` });
      }
    });
  }

  get publicKey() {
    return this.vapid.publicKey;
  }

  /** A standing-agent run ended (StandingAgents emits this). Only failures and budget/time stops notify. */
  standingRun(a: StandingAgent, run: StandingRun) {
    if (!['error', 'budget', 'timeout'].includes(run.outcome)) return;
    const what = run.outcome === 'budget' ? 'hit its budget' : run.outcome === 'timeout' ? 'ran out of time' : 'failed';
    this.fire({ kind: 'standing', title: `${a.name} ${what}`, body: clip(firstLine(run.summary ?? ''), 180), url: `#/agent/${encodeURIComponent(a.id)}`, tag: `standing-${a.id}` });
  }

  /** The Unity watchdog found an editor stuck (SandboxManager 'blocked', docs/unity-dialogs.md). */
  unityBlocked(sb: Sandbox, b: UnityBlocked) {
    const what = b.reason === 'dialog' ? `"${b.title}"${b.text ? `: ${b.text.replace(/\s+/g, ' ')}` : ''}` : b.title ?? 'stuck';
    this.fire({ kind: 'unity', title: `Unity in ${nameWithSlot(sb)} is stuck`, body: clip(what, 180), url: `#/sandbox/${encodeURIComponent(sb.id)}`, tag: `unity-${sb.id}` });
  }

  /** A host-health step (disk guard, sandbox drive recovery): server/hostHealth.ts. */
  host(title: string, body: string) {
    this.fire({ kind: 'host', title, body: clip(body, 240), url: '#/', tag: `host-${title.slice(0, 40)}` });
  }

  delegation(d: DelegationRequest) {
    // Auto-approved requests say so when they start (delegationUpdate); only the user's to-do list pings here.
    if (d.auto) return;
    this.fire({ kind: 'delegation', title: `${d.agentName} asks for a worker`, body: clip(d.title, 180), url: `#/agent/${encodeURIComponent(d.agentId)}/delegations`, tag: `deleg-${d.id}` });
  }

  /** An auto-approved delegation started, finished its first turn, or expired unstarted. */
  delegationUpdate(d: DelegationRequest, what: 'started' | 'finished' | 'expired') {
    if (!d.autoApproved && what !== 'expired' && d.auto !== 'queued') return;
    const sb = d.sandboxId ? this.store.sandboxes.get(d.sandboxId) : undefined;
    const m = d.machineId ? this.store.machines.get(d.machineId) : undefined;
    const where = sb ? `slot ${sb.id}` : m ? `machine ${m.id}` : (d.sandboxId ?? d.machineId ?? '');
    const title = what === 'started' ? `Auto-approved worker started (${where})` : what === 'finished' ? `Auto-approved worker finished (${where})` : 'Auto-approved request expired';
    this.fire({ kind: 'delegation', title, body: clip(`${d.agentName}: ${d.title}`, 180), url: `#/agent/${encodeURIComponent(d.agentId)}/delegations`, tag: `deleg-${d.id}` });
  }

  private name(s: SessionInfo) {
    return s.kind === 'orchestrator' || s.id === this.orchestratorId?.() ? 'The orchestrator' : s.title;
  }

  private route(s: SessionInfo) {
    return sessionRoute(s, this.orchestratorId?.());
  }

  // ---------------------------------------------------------------- subscriptions

  list(user: string) {
    return this.subs.filter((s) => s.user === user).map(({ endpoint, prefs, device, createdAt }) => ({ endpoint, prefs, device, createdAt }));
  }

  subscribe(user: string, sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }, prefs: Partial<NotifyPrefs> | undefined, device: string) {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('not a push subscription');
    const prev = this.subs.find((s) => s.endpoint === sub.endpoint);
    const rec: PushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      user,
      prefs: { ...DEFAULT_PREFS, ...prev?.prefs, ...prefs },
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      device: device.slice(0, 80),
    };
    this.subs = [...this.subs.filter((s) => s.endpoint !== sub.endpoint), rec];
    this.save();
    return rec.prefs;
  }

  setPrefs(endpoint: string, prefs: Partial<NotifyPrefs>) {
    const s = this.subs.find((x) => x.endpoint === endpoint);
    if (!s) throw new Error('no such subscription');
    s.prefs = { ...s.prefs, ...prefs };
    this.save();
    return s.prefs;
  }

  unsubscribe(endpoint: string) {
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    this.save();
  }

  /** A test notification to one device (or all of this user's). Resolves to how many were delivered. */
  async test(user: string, endpoint?: string) {
    const targets = this.subs.filter((s) => s.user === user && (!endpoint || s.endpoint === endpoint));
    const results = await Promise.all(targets.map((s) => this.push(s, { kind: 'turnEnd', title: 'FF Factory', body: 'Test notification: this device will hear from the factory.', url: '#/', tag: 'test' })));
    return results.filter(Boolean).length;
  }

  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.subs, null, 2), { mode: 0o600 });
  }

  // ---------------------------------------------------------------- delivery

  private fire(n: Notice) {
    // Open pages without push show it themselves (in-page Notification) if their own settings say so.
    emit({ type: 'notify', notice: n });
    for (const s of this.subs) if (s.prefs[n.kind]) void this.push(s, n);
  }

  private async push(s: PushSub, n: Notice): Promise<boolean> {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(n), {
        TTL: 6 * 3600,
        urgency: n.kind === 'permission' || n.kind === 'error' ? 'high' : 'normal',
        vapidDetails: { subject: 'https://github.com/Final-Factory/ff-factory', publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
      });
      return true;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) this.unsubscribe(s.endpoint); // the browser dropped it
      else console.warn(`push to ${s.device}: ${code ?? ''} ${(e as Error).message}`);
      return false;
    }
  }
}
