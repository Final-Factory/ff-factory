import { useEffect, useState, type ReactNode } from 'react';
import type { AppState, HostStatus } from '../../shared/types';
import { useAttention } from './attention';
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
import { setDrawer, useStore } from './store';
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

      <main className={`main main-${content.layout}`}>{content.node ?? <OrchestratorView session={orch} />}</main>
      <HostBanner host={app.host} app={app} />
      <ConnectionBanner />

      {newSandbox && <NewSandboxModal app={app} onClose={() => setNewSandbox(false)} />}
      {newStanding && <StandingAgentModal app={app} onClose={() => setNewStanding(false)} />}
      {newMachine && <AddMachineModal onClose={() => setNewMachine(false)} />}
      <Lightbox />
      <Toasts />
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
    <div className="conn-banner" role="status">
      <span className="spinner" /> Connection lost. Reconnecting…
    </div>
  );
}

/** The server's own trouble: running elevated (no Unity), a restart waiting for agents, the host guard's alarms. */
function HostBanner({ host, app }: { host?: HostStatus; app: AppState }) {
  const h = host?.health;
  const drive = h && h.sandboxRoot !== 'ok';
  const disk = h && h.level !== 'ok';
  if (!host?.elevated && !host?.drain && !drive && !disk) return null;
  const low = h?.disks.filter((d) => d.level !== 'ok').map((d) => `${d.path} ${d.freeBytes === undefined ? '?' : fmtBytes(d.freeBytes)} free`).join(', ');
  const title = (id: string) => app.sessions.find((s) => s.id === id)?.title ?? id;
  return (
    <div className="host-banner" role="status">
      {host.elevated && (
        <div className="banner banner-error">
          <b>FF Factory is running with administrator rights.</b> It will not start Unity editors (they would stop on Unity's administrator dialog), and every agent
          shell has admin rights. Run <code>scripts\restart.cmd</code> to bring it back non-elevated.{host.elevatedWhy ? ` (${host.elevatedWhy})` : ''}
        </div>
      )}
      {drive && (
        <div className="banner banner-error">
          <b>The sandbox drive is offline</b> ({h.sandboxRoot}{h.detail ? `: ${h.detail}` : ''}). FF Factory is reattaching it by itself; the editors and agents
          that were working there come back afterwards.
        </div>
      )}
      {disk && !drive && (
        <div className={`banner ${h.level === 'critical' ? 'banner-error' : 'banner-warn'}`}>
          <b>Disk space {h.level === 'critical' ? 'critical' : 'low'}</b> ({low}). New editors and agents wait until space is freed
          {h.level === 'critical' ? '; busy agents were asked to checkpoint, idle editors stopped, and known-safe junk is cleaned up' : ''}.
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
