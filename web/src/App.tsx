import { useEffect, useState, type ReactNode } from 'react';
import { dismissedUserKey, undismissed, unitEventKey } from '../../shared/dismissals';
import type { AppState, HostStatus } from '../../shared/types';
import { useAttention } from './attention';
import { Login } from './components/Login';
import { NewSandboxModal } from './components/Modals';
import { OrchestratorView } from './components/OrchestratorView';
import { DispatcherPanel } from './components/DispatcherPanel';
import { SessionView } from './components/SessionView';
import { Sidebar } from './components/Sidebar';
import { api } from './api';
import { Icon } from './components/ui';
import { StandingAgentModal } from './components/StandingModal';
import { StandingPanel } from './components/StandingPanel';
import { AddMachineModal, MachinePanel } from './components/MachinePanel';
import { ProviderPanel } from './components/ProviderPanel';
import { MaxPanel } from './components/MaxPanel';
import { MachineSandboxPanel } from './components/MachineSandboxPanel';
import { OverviewBoard } from './components/Fleet';
import { Toasts } from './components/Toasts';
import { Lightbox } from './components/Images';
import { SearchView } from './components/SearchView';
import { reloadNow, useNewVersion } from './freshness';
import { setDrawer, toast, toastError, useStore } from './store';
import { sessionRoute } from './attention';
import { displayName, fmtBytes, fmtClock, href, navigate, useMediaQuery, useRoute, type Route } from './util';

export function App() {
  const auth = useStore((s) => s.auth);
  const app = useStore((s) => s.app);

  if (auth === 'needed') return <Login />;
  if (auth === 'unknown' || !app) {
    return (
      <div className="splash">
        <span className="spinner" /> Connecting…
        <Toasts />
      </div>
    );
  }
  return <Shell app={app} />;
}

function Shell({ app }: { app: AppState }) {
  const route = useRoute();
  const wide = useMediaQuery('(min-width: 1280px)');
  const mobile = useMediaQuery('(max-width: 860px)');
  const drawer = useStore((s) => s.drawer);
  const [newSandbox, setNewSandbox] = useState(false);
  const [newStanding, setNewStanding] = useState(false);
  const [newMachine, setNewMachine] = useState(false);
  const waiting = useAttention(app).length;

  useEffect(() => {
    document.title = waiting ? `(${waiting}) FF Factory` : 'FF Factory';
  }, [waiting]);

  useEffect(() => {
    if (!mobile) setDrawer(false);
  }, [mobile]);

  // Any navigation closes the phone drawer, including one from a modal opened in it (a new standing agent opens its page).
  const at = href(route);
  useEffect(() => setDrawer(false), [at]);

  const orch = app.sessions.find((s) => s.id === app.orchestratorId);
  const content = renderRoute(route, app, wide);

  return (
    <div className={`shell${drawer ? ' drawer-open' : ''}`}>
      <div className="sidebar-wrap">
        <Sidebar app={app} route={route} onNewSandbox={() => setNewSandbox(true)} onNewStanding={() => setNewStanding(true)} onNewMachine={() => setNewMachine(true)} onNavigate={() => setDrawer(false)} />
      </div>
      <div className="scrim" onClick={() => setDrawer(false)} />

      <div className="main-col">
        {/* Global notices sit above the page in the layout flow: they push it down, never cover its header. */}
        <div className="gbars">
          <ConnectionBanner />
          <NewVersionBanner />
          <HostBanner host={app.host} app={app} />
        </div>
        <main className={`main main-${content.layout}`}>{content.node ?? <OrchestratorView session={orch} />}</main>
      </div>

      {newSandbox && <NewSandboxModal app={app} onClose={() => setNewSandbox(false)} />}
      {newStanding && <StandingAgentModal app={app} onClose={() => setNewStanding(false)} />}
      {newMachine && <AddMachineModal onClose={() => setNewMachine(false)} />}
      <Lightbox />
      <Toasts />
    </div>
  );
}

/**
 * One global notice: an opaque one-line bar in the layout flow above the page (it pushes the page down, never
 * covers it). The text is cut to one line; hover shows it all (title), a click or tap unfolds it. `onDismiss`
 * adds a close button.
 */
/** The GitHub token banner's "Re-check now" (w904): the probe runs at once; the banner clears by itself when it passes. */
async function recheckGithub() {
  try {
    const r = await api.githubRecheck();
    toast(r.ran ? 'GitHub tokens checked again: the banner clears if nothing is missing' : 'Checked less than 30 seconds ago; try again shortly');
  } catch (e) {
    toastError(e);
  }
}

function Bar({ kind, text, children, onDismiss, busy, action }: { kind: 'warn' | 'error'; text: string; children: ReactNode; onDismiss?: () => void; busy?: boolean; action?: { label: string; onClick: () => void } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`gbar gbar-${kind}${open ? ' open' : ''}`} role="status">
      {busy && <span className="spinner spinner-sm" />}
      <button type="button" className="gbar-text" title={text} aria-expanded={open} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {action && (
        <button type="button" className="btn btn-sm gbar-x" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-sm gbar-x" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

/** The live connection dropped: say so (after a moment, so a quick reconnect does not flash). */
function ConnectionBanner() {
  const ws = useStore((s) => s.ws);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (ws === 'open') {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), 2500);
    return () => clearTimeout(t);
  }, [ws]);
  if (!show) return null;
  return (
    <Bar kind="warn" busy text="Connection lost. Reconnecting…">
      <b>Connection lost.</b> Reconnecting…
    </Bar>
  );
}

/** The server serves a newer web UI than this page runs, and reloading by itself now would lose something (web/src/freshness.ts). */
function NewVersionBanner() {
  if (!useNewVersion()) return null;
  return (
    <Bar kind="warn" text="A new version of FF Factory is ready. Reload to use it: a typed message is kept, pictures and files not yet sent are not." action={{ label: 'Reload', onClick: reloadNow }}>
      <b>A new version of FF Factory is ready.</b> Reload to use it: a typed message is kept, pictures and files not yet sent are not.
    </Bar>
  );
}

/**
 * The server's own trouble: running elevated (no Unity), a restart waiting for agents, the host guard's alarms.
 * Each can be dismissed; it comes back when what it says changes. The VM watchdog's restarts are remembered per person on the
 * server (w751): a closed restart stays closed, a new one shows the bar again.
 */
function HostBanner({ host, app }: { host?: HostStatus; app: AppState }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const h = host?.health;
  const drive = h && h.sandboxRoot !== 'ok';
  const disk = h && h.level !== 'ok';
  const path = host?.pathHealth;
  const pathShown = !!path?.problems.length || path?.silentMinutes !== undefined;
  const wd = host?.unitWatchdog;
  const gaveUp = wd?.units.filter((u) => u.state === 'gave-up') ?? [];
  // The restarts this person has not closed (w751): the server keeps their closed ones, so a reload, another device and a portal
  // restart do not bring the banner back for the same event; a new restart (another time or unit) does.
  const closed = app.me ? app.settings.dismissedEvents?.[dismissedUserKey(app.me.userId)] : undefined;
  const restarts = undismissed((wd?.events ?? []).filter((e) => e.action !== 'gave-up' && Date.now() - Date.parse(e.at) <= 24 * 3_600_000), closed);
  const wdShown = gaveUp.length > 0 || wd?.silentMinutes !== undefined || restarts.length > 0;
  const tokenWarnings = host?.tokenWarnings ?? [];
  if (!host || (!host.elevated && !host.drain && !drive && !disk && !host.dryRun && !pathShown && !wdShown && !tokenWarnings.length)) return null;
  const low = h?.disks.filter((d) => d.level !== 'ok').map((d) => `${d.path} ${d.freeBytes === undefined ? '?' : fmtBytes(d.freeBytes)} free`).join(', ');
  const title = (id: string) => app.sessions.find((s) => s.id === id)?.title ?? id;
  // `events`: the event keys closing the bar remembers for this person (on the server); other bars are forgotten on reload.
  const bars: { key: string; kind: 'warn' | 'error'; lead: string; rest: string; fixed?: boolean; events?: string[]; action?: { label: string; onClick: () => void } }[] = [];
  // Not dismissible: a dry run (FFSB_DRY_RUN=1) must never pass for the real portal.
  if (host.dryRun) bars.push({ key: 'dryrun', kind: 'error', lead: 'DRY RUN: this is a copy, not the real portal.', rest: host.dryRun, fixed: true });
  if (host.elevated) {
    bars.push({
      key: 'elevated',
      kind: 'error',
      lead: 'FF Factory is running with administrator rights.',
      rest: `Every orchestrator shell has admin rights. Run scripts\\restart.cmd to bring it back non-elevated.${host.elevatedWhy ? ` (${host.elevatedWhy})` : ''}`,
    });
  }
  if (drive) {
    bars.push({ key: 'drive', kind: 'error', lead: 'The sandbox drive is offline', rest: `(${h.sandboxRoot}${h.detail ? `: ${h.detail}` : ''}). FF Factory is reattaching it by itself; the editors and agents that were working there come back afterwards.` });
  }
  if (disk && !drive) {
    bars.push({
      key: 'disk',
      kind: h.level === 'critical' ? 'error' : 'warn',
      lead: `Disk space ${h.level === 'critical' ? 'critical' : 'low'}`,
      rest: `(${low}). New editors and agents wait until space is freed${h.level === 'critical' ? '; busy agents were asked to checkpoint, idle editors stopped, and known-safe junk is cleaned up' : ''}.`,
    });
  }
  // The FFBox host's watchdog (fff-vm watch): what is broken on the path from the internet to this portal, which it could not
  // repair, and who must act. Not dismissible: it stays until the check passes. It shows here even while Funnel is down.
  for (const p of path?.problems ?? []) {
    bars.push({
      key: `path-${p.id}`,
      kind: 'error',
      lead: `Portal path problem: ${p.name} (layer ${p.id})${p.since ? ` since ${fmtSince(p.since)}` : ''}.`,
      rest: `${p.line}${p.repair ? ` Last repair: ${p.repair}.` : ''} Who must act: ${p.who || 'see sudo fff-vm watch status on the FFBox host'}.`,
      fixed: true,
    });
  }
  if (path?.silentMinutes !== undefined) {
    bars.push({
      key: 'path-silent',
      kind: 'warn',
      lead: `The portal's path watchdog has been silent for ${path.silentMinutes} minutes.`,
      rest: `Nobody is checking the path from the internet to this portal (fff-vm watch on ${path.host || 'the FFBox host'}; sudo fff-vm watch status).`,
      fixed: true,
    });
  }
  // The VM's unit watchdog (fff-health): a critical systemd unit it gave up restarting needs a person; a silent watchdog restarts
  // nothing; its restarts of the last 24 hours are one bar a person can dismiss (it returns when a new restart happens).
  for (const g of gaveUp) {
    const last = wd?.events.filter((e) => e.unit === g.unit).at(-1);
    bars.push({
      key: `unit-gaveup-${g.unit}`,
      kind: 'error',
      lead: `The VM watchdog gave up restarting ${g.unit}.`,
      rest: `It restarted it ${g.attempts} time${g.attempts === 1 ? '' : 's'} and it did not stay up${last?.why ? ` (${last.why})` : ''}. A person must act: run sudo fffctl status on the VM.`,
      fixed: true,
    });
  }
  if (wd?.silentMinutes !== undefined) {
    bars.push({
      key: 'unit-silent',
      kind: 'warn',
      lead: `The VM's unit watchdog has been silent for ${wd.silentMinutes} minutes.`,
      rest: `Nobody is restarting a critical unit that fails (fff-health${wd.host ? ` on ${wd.host}` : ''}; sudo fffctl status).`,
      fixed: true,
    });
  }
  if (restarts.length) {
    const list = restarts.slice(-3).reverse().map((e) => `${e.unit} at ${fmtSince(e.at)}${e.why ? ` (${e.why})` : ''}`).join('; ');
    bars.push({
      key: 'unit-restarts',
      kind: 'warn',
      lead: `The VM watchdog restarted a critical unit ${restarts.length === 1 ? 'once' : `${restarts.length} times`} in the last 24 hours.`,
      rest: `${list}${restarts.length > 3 ? `; ${restarts.length - 3} more` : ''}.`,
      events: restarts.map(unitEventKey),
    });
  }
  // The Claude token pools (w739): a person's tokens used up or over their caps, and runs inside the dispatcher's reserve.
  // The text names no token but its last four characters; a banner returns when its text changes.
  for (const w of tokenWarnings) {
    // A GitHub token that lacks a requirement (w904): its fix is on github.com; Re-check now reads it again at once.
    if (w.kind === 'github-token') {
      bars.push({ key: `token-${w.id}`, kind: 'warn', lead: 'A GitHub token needs updating.', rest: w.text, action: { label: 'Re-check now', onClick: () => void recheckGithub() } });
      continue;
    }
    bars.push({ key: `token-${w.id}`, kind: w.kind === 'exhausted' ? 'error' : 'warn', lead: w.kind === 'ci-read' ? 'FF Factory cannot read CI on pull requests.' : w.kind === 'reserve' ? 'The dispatcher\'s Claude token buffer is in use.' : w.kind === 'exhausted' ? 'All your Claude tokens are used up.' : 'All your Claude tokens are at a limit.', rest: w.text });
  }
  if (host.drain) {
    const d = host.drain;
    bars.push({
      key: 'drain',
      kind: 'warn',
      lead: 'Restart pending',
      rest: `(${d.reason}): waiting for ${d.waitingFor.length ? d.waitingFor.map(title).join(', ') : 'nothing'} to finish, at the latest ${fmtClock(d.deadline)}. Interrupted agents are resumed afterwards.`,
    });
  }
  const shown = bars.filter((b) => !dismissed.has(`${b.key}:${b.lead} ${b.rest}`));
  const dismiss = (b: { key: string; lead: string; rest: string; events?: string[] }) => {
    setDismissed((s) => new Set(s).add(`${b.key}:${b.lead} ${b.rest}`));
    if (b.events?.length) api.dismissEvents(b.events).catch(() => undefined); // on failure the bar returns at the next reload, as before
  };
  if (!shown.length) return null;
  return (
    <>
      {shown.map((b) => (
        <Bar key={b.key} kind={b.kind} text={`${b.lead} ${b.rest}`} onDismiss={b.fixed ? undefined : () => dismiss(b)} action={b.action}>
          <b>{b.lead}</b> {b.rest}
        </Bar>
      ))}
    </>
  );
}

/** "14:05" for today, "Oct 7 14:05" for another day. */
function fmtSince(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const time = fmtClock(iso);
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function renderRoute(route: Route, app: AppState, wide: boolean): { node: ReactNode; layout: string; title: string } {
  // An old #/sandbox/<id> link (the portal's own sandboxes, gone in w510): the same name on this host's own daemon.
  if (route.view === 'sandbox') route = { view: 'msandbox', machineId: app.machines.find((m) => m.local)?.id ?? '', sandboxId: route.sandboxId, sessionId: route.sessionId };
  const orch = app.sessions.find((s) => s.id === app.orchestratorId);
  if (route.view === 'chat') {
    // Someone else's own orchestrator, read only; your own is the home page.
    const s = app.sessions.find((x) => x.kind === 'orchestrator' && x.orchestratorRole === 'personal' && x.requestedBy?.userId.toLowerCase() === route.userId.toLowerCase());
    if (!s) return { node: <Missing what="conversation" />, layout: 'single', title: 'Not found' };
    if (s.id === app.orchestratorId) return { node: null, layout: 'single', title: 'Orchestrator' };
    return { layout: 'single', title: s.title, node: <OrchestratorView key={s.id} session={s} readOnly /> };
  }
  if (route.view === 'dispatcher') {
    const panel = <DispatcherPanel app={app} tab={route.tab} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: 'Dispatcher',
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: 'Dispatcher', node: panel };
  }
  if (route.view === 'search') {
    return { layout: 'single', title: 'Search', node: <SearchView key={route.q ?? ''} app={app} initial={route.q} /> };
  }
  if (route.view === 'machine') {
    const m = app.machines.find((x) => x.id === route.machineId);
    if (!m) return { node: <Missing what="machine" />, layout: 'single', title: 'Not found' };
    const panel = <MachinePanel app={app} machine={m} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: displayName(m),
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: displayName(m), node: panel };
  }
  if (route.view === 'msandbox') {
    const m = app.machines.find((x) => x.id === route.machineId);
    const sb = m?.sandboxes?.find((x) => x.id === route.sandboxId);
    if (!m || !sb) return { node: <Missing what="sandbox" />, layout: 'single', title: 'Not found' };
    const panel = <MachineSandboxPanel app={app} machine={m} sandbox={sb} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: displayName(sb),
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: displayName(sb), node: panel };
  }
  if (route.view === 'overview') {
    return { layout: 'single', title: 'Overview', node: <OverviewBoard app={app} /> };
  }
  if (route.view === 'max') {
    if (!app.max) return { node: <Missing what="page" />, layout: 'single', title: 'Not found' };
    const panel = <MaxPanel app={app} max={app.max} tab={route.tab} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: 'Max',
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: 'Max', node: panel };
  }
  if (route.view === 'provider') {
    // FFBox is listed only while switched on or set up; its page (with what it needs) opens either way.
    const p = app.providers?.find((x) => x.id === route.providerId) ?? (app.ffbox?.id === route.providerId ? app.ffbox : undefined);
    if (!p) return { node: <Missing what="provider" />, layout: 'single', title: 'Not found' };
    const panel = <ProviderPanel provider={p} tab={route.tab} item={route.item} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: p.name,
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: p.name, node: panel };
  }
  if (route.view === 'agent') {
    const a = app.standingAgents.find((x) => x.id === route.agentId);
    if (!a) return { node: <Missing what="standing agent" />, layout: 'single', title: 'Not found' };
    const panel = <StandingPanel app={app} agent={a} tab={route.tab} onClose={() => navigate({ view: 'home' })} />;
    if (wide) {
      return {
        layout: 'split',
        title: a.name,
        node: (
          <>
            <OrchestratorView session={orch} compact />
            {panel}
          </>
        ),
      };
    }
    return { layout: 'single', title: a.name, node: panel };
  }
  if (route.view === 'session') {
    const s = app.sessions.find((x) => x.id === route.sessionId);
    if (!s) return { node: <Missing what="session" />, layout: 'single', title: 'Not found' };
    if (s.id === app.orchestratorId) return { node: null, layout: 'single', title: 'Orchestrator' };
    if (s.kind === 'orchestrator') return renderRoute(sessionRoute(s, app), app, wide);
    return {
      layout: 'single',
      title: s.title,
      node: (
        <SessionView
          session={s}
          fullWidth
          readOnly={s.kind === 'ops' ? "Only Lothsahn's and Ben's own orchestrators give the orchestration worker jobs (their ops_worker tool); nobody writes to it here. Every command it runs is in this transcript, with secrets redacted." : undefined}
          onBack={() =>
            navigate(
              s.machineId && s.machineSandbox
                  ? { view: 'msandbox', machineId: s.machineId, sandboxId: s.machineSandbox, sessionId: s.id }
                  : s.machineId && !s.standingId
                  ? { view: 'machine', machineId: s.machineId, sessionId: s.id }
                  : s.standingId
                  ? { view: 'agent', agentId: s.standingId, tab: 'conversation' }
                  : { view: 'home' },
            )
          }
        />
      ),
    };
  }
  return { node: null, layout: 'single', title: 'Orchestrator' };
}

function Missing({ what }: { what: string }) {
  return (
    <div className="panel-empty">
      <p>That {what} no longer exists.</p>
      <button className="btn btn-outline" onClick={() => navigate({ view: 'home' })}>
        Back to the orchestrator
      </button>
    </div>
  );
}
