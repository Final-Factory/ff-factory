import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState, HostStatus } from '../../shared/types';
import { Login } from './components/Login';
import { NewSandboxModal } from './components/Modals';
import { OrchestratorView } from './components/OrchestratorView';
import { SandboxPanel } from './components/SandboxPanel';
import { SessionView } from './components/SessionView';
import { Sidebar } from './components/Sidebar';
import { StandingAgentModal } from './components/StandingModal';
import { StandingPanel } from './components/StandingPanel';
import { AddMachineModal, MachinePanel } from './components/MachinePanel';
import { Toasts } from './components/Toasts';
import { Lightbox } from './components/Images';
import { SearchView } from './components/SearchView';
import { Icon } from './components/ui';
import { focusPermission, useStore } from './store';
import { displayName, fmtClock, href, navigate, useMediaQuery, useRoute, type Route } from './util';

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

function usePending(app: AppState) {
  return useMemo(() => {
    const all = app.sessions.flatMap((s) => s.pendingPermissions.map((p) => ({ session: s, p })));
    all.sort((a, b) => a.p.createdAt.localeCompare(b.p.createdAt));
    return all;
  }, [app.sessions]);
}

function Shell({ app }: { app: AppState }) {
  const route = useRoute();
  const wide = useMediaQuery('(min-width: 1280px)');
  const mobile = useMediaQuery('(max-width: 860px)');
  const [drawer, setDrawer] = useState(false);
  const [newSandbox, setNewSandbox] = useState(false);
  const [newStanding, setNewStanding] = useState(false);
  const [newMachine, setNewMachine] = useState(false);
  const pending = usePending(app);
  const delegations = app.delegations.filter((d) => d.status === 'pending');
  const waiting = pending.length + delegations.length;

  useEffect(() => {
    document.title = waiting ? `(${waiting}) FF Factory` : 'FF Factory';
  }, [waiting]);

  useEffect(() => {
    if (!mobile) setDrawer(false);
  }, [mobile]);

  // Any navigation closes the phone drawer, including one from a modal opened in it (a new standing agent opens its page).
  const at = href(route);
  useEffect(() => setDrawer(false), [at]);

  const jumpToPending = () => {
    const first = pending[0];
    if (!first) {
      if (delegations[0]) navigate({ view: 'agent', agentId: delegations[0].agentId, tab: 'delegations' });
      setDrawer(false);
      return;
    }
    const s = first.session;
    if (s.id === app.orchestratorId) navigate({ view: 'home' });
    else if (s.sandboxId) navigate({ view: 'sandbox', sandboxId: s.sandboxId, sessionId: s.id });
    else if (s.standingId) navigate({ view: 'agent', agentId: s.standingId, tab: 'conversation' });
    else if (s.machineId) navigate({ view: 'machine', machineId: s.machineId, sessionId: s.id });
    else navigate({ view: 'session', sessionId: s.id });
    focusPermission(first.p.requestId);
    setDrawer(false);
  };

  const orch = app.sessions.find((s) => s.id === app.orchestratorId);
  const content = renderRoute(route, app, wide);

  // A conversation page (sandbox, machine, a session of its own) has its own one-row header with a
  // back button; on a phone the app's top bar would only repeat the title above it.
  const focus = (route.view === 'sandbox' || route.view === 'machine' || route.view === 'session') && !!content.node;

  return (
    <div className={`shell${drawer ? ' drawer-open' : ''}${focus ? ' shell-focus' : ''}`}>
      <header className="topbar">
        <button className="btn btn-ghost btn-icon" onClick={() => setDrawer(true)} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <span className="topbar-title ellipsis">{content.title}</span>
        {waiting > 0 && (
          <button className="needs-you" onClick={jumpToPending}>
            <Icon name="bell" size={14} /> {waiting}
          </button>
        )}
      </header>

      <div className="sidebar-wrap">
        <Sidebar app={app} route={route} onNewSandbox={() => setNewSandbox(true)} onNewStanding={() => setNewStanding(true)} onNewMachine={() => setNewMachine(true)} onNavigate={() => setDrawer(false)} />
        {waiting > 0 && !mobile && (
          <button className="needs-you needs-you-side" onClick={jumpToPending}>
            <Icon name="bell" size={14} />
            <span>
              {waiting} waiting on you
              <small className="ellipsis">
                {pending[0]
                  ? `${pending[0].session.id === app.orchestratorId ? 'Orchestrator' : pending[0].session.title} · ${pending[0].p.toolName}`
                  : `${delegations[0].agentName} · delegation request`}
              </small>
            </span>
          </button>
        )}
      </div>
      <div className="scrim" onClick={() => setDrawer(false)} />

      <main className={`main main-${content.layout}`}>{content.node ?? <OrchestratorView session={orch} />}</main>
      <HostBanner host={app.host} app={app} />

      {newSandbox && <NewSandboxModal app={app} onClose={() => setNewSandbox(false)} />}
      {newStanding && <StandingAgentModal app={app} onClose={() => setNewStanding(false)} />}
      {newMachine && <AddMachineModal onClose={() => setNewMachine(false)} />}
      <Lightbox />
      <Toasts />
    </div>
  );
}

/** The server's own trouble: running elevated (no Unity), or a restart waiting for agents. */
function HostBanner({ host, app }: { host?: HostStatus; app: AppState }) {
  if (!host?.elevated && !host?.drain) return null;
  const title = (id: string) => app.sessions.find((s) => s.id === id)?.title ?? id;
  return (
    <div className="host-banner" role="status">
      {host.elevated && (
        <div className="banner banner-error">
          <b>FF Factory is running with administrator rights.</b> It will not start Unity editors (they would stop on Unity's administrator dialog), and every agent
          shell has admin rights. Run <code>scripts\restart.cmd</code> to bring it back non-elevated.{host.elevatedWhy ? ` (${host.elevatedWhy})` : ''}
        </div>
      )}
      {host.drain && (
        <div className="banner banner-warn">
          <b>Restart pending</b> ({host.drain.reason}): waiting for {host.drain.waitingFor.length ? host.drain.waitingFor.map(title).join(', ') : 'nothing'} to finish,
          at the latest {fmtClock(host.drain.deadline)}. Interrupted agents are resumed afterwards.
        </div>
      )}
    </div>
  );
}

function renderRoute(route: Route, app: AppState, wide: boolean): { node: ReactNode; layout: string; title: string } {
  const orch = app.sessions.find((s) => s.id === app.orchestratorId);
  if (route.view === 'sandbox') {
    const sb = app.sandboxes.find((s) => s.id === route.sandboxId);
    if (!sb) return { node: <Missing what="sandbox" />, layout: 'single', title: 'Not found' };
    if (wide) {
      return {
        layout: 'split',
        title: displayName(sb),
        node: (
          <>
            <OrchestratorView session={orch} compact />
            <SandboxPanel app={app} sandbox={sb} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />
          </>
        ),
      };
    }
    return {
      layout: 'single',
      title: displayName(sb),
      node: <SandboxPanel app={app} sandbox={sb} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />,
    };
  }
  if (route.view === 'search') {
    return { layout: 'single', title: 'Search', node: <SearchView key={route.q ?? ''} app={app} initial={route.q} /> };
  }
  if (route.view === 'machine') {
    const m = app.machines.find((x) => x.id === route.machineId);
    if (!m) return { node: <Missing what="machine" />, layout: 'single', title: 'Not found' };
    const panel = <MachinePanel app={app} machine={m} sessionId={route.sessionId} onClose={() => navigate({ view: 'home' })} />;
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
    return {
      layout: 'single',
      title: s.title,
      node: (
        <SessionView
          session={s}
          fullWidth
          onBack={() =>
            navigate(
              s.sandboxId
                ? { view: 'sandbox', sandboxId: s.sandboxId, sessionId: s.id }
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
