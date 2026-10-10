import { useEffect, useState } from 'react';
import type { AppState, Machine, MachineSandbox } from '../../../shared/types';
import { api } from '../api';
import { attempt, sessionsByIds, toast, useStore } from '../store';
import { displayName, fmtRelative, machineSandboxGlance, navigate, unityLabel, unityTone, useNow } from '../util';
import { NewAgentModal } from './Modals';
import { GitFacts, SwitchBranchModal } from './Git';
import { UnityLogDrawer } from './UnityLogDrawer';
import { SessionDetails, SessionView } from './SessionView';
import { AgentPicker, AgentTabs, AttentionStrip, DetailsSection, DetailsSheet, PanelHeader, useDetailsOpen } from './PanelChrome';
import { Chip, CopyButton, Icon, StateText } from './ui';

/**
 * A sandbox on one of the user's machines (docs/machines.md, "Machine sandboxes"): a worktree of the machine's main
 * clone with its own branch and Unity editor. Its agents as tabs, like a host sandbox; the editor, its log and the
 * branch act through the machine's daemon.
 */
export function MachineSandboxPanel({ app, machine: m, sandbox: sb, sessionId, onClose }: { app: AppState; machine: Machine; sandbox: MachineSandbox; sessionId?: string; onClose?: () => void }) {
  const now = useNow();
  const sessions = sessionsByIds(app.sessions, sb.sessionIds);
  const selected = sessions.find((s) => s.id === sessionId) ?? sessions[sessions.length - 1];
  const [newAgent, setNewAgent] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [unityBusy, setUnityBusy] = useState(false);
  const [details, setDetails] = useDetailsOpen('msandbox');

  const ref = `${m.id}/${sb.id}`;
  const u = sb.unity.state;
  const unityOn = u === 'running' || u === 'starting';
  const ready = sb.status === 'ready';
  const reachable = ready && m.online;
  const glance = machineSandboxGlance(sb, sessions);
  const waiting = sessions.find((s) => s.pendingPermissions.length > 0);
  const pick = (id: string) => navigate({ view: 'msandbox', machineId: m.id, sandboxId: sb.id, sessionId: id }, true);

  const focusRequest = useStore((s) => s.focusRequestId);
  useEffect(() => {
    const owner = focusRequest ? sessions.find((s) => s.pendingPermissions.some((p) => p.requestId === focusRequest)) : undefined;
    if (owner && owner.id !== selected?.id) pick(owner.id);
  }, [focusRequest]);

  const toggleUnity = async () => {
    setUnityBusy(true);
    const r = await attempt(api.machineSandboxUnity(m.id, sb.id, unityOn ? 'stop' : 'start'));
    setUnityBusy(false);
    if (r?.note) toast(r.note);
  };

  return (
    <section className="sb-panel" data-testid="machine-sandbox-panel">
      <PanelHeader
        onBack={onClose}
        title={displayName(sb)}
        titleClass={glance.label === 'Free' ? 'is-unused' : ''}
        state={<StateText tone={glance.tone} label={glance.label} pulse={glance.tone === 'blue'} />}
        extra={
          <>
            <span className="ph-facts hide-phone">
              <span className="ph-sep">·</span>
              <span className="mono">{ref}</span>
              {ready && (
                <>
                  <span className="ph-sep">·</span>
                  {unityLabel[u]}
                </>
              )}
              <span className="ph-sep">·</span>
              <span className="mono">{sb.git?.branch ?? sb.branch}</span>
            </span>
            {ready && <AgentPicker place={displayName(sb)} sessions={sessions} selected={selected} onSelect={pick} onNew={() => setNewAgent(true)} newDisabled={!reachable} />}
          </>
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
      />
      <AttentionStrip session={waiting} />
      {(sb.status === 'creating' || sb.status === 'deleting' || sb.status === 'cleanup') && (
        <div className="sb-progress">
          <div className="indeterminate" />
          <span>{sb.statusDetail ?? (sb.status === 'creating' ? 'Creating…' : sb.status === 'cleanup' ? 'Cleaning up…' : 'Deleting…')}</span>
        </div>
      )}
      {sb.status === 'error' && (
        <div className="banner banner-error">
          <b>This sandbox could not be set up.</b> {sb.statusDetail}
        </div>
      )}
      {!m.online && <div className="banner banner-warn">{m.name ?? m.id} is offline{m.lastSeen ? ` (seen ${fmtRelative(m.lastSeen, now)})` : ''}: its editor and agents cannot be reached until it is back.</div>}
      <DetailsSheet open={details} onClose={() => setDetails(false)} title={displayName(sb)}>
        <DetailsSection title="Sandbox">
          <div className="details-row dim small">
            <span title="The machine and the sandbox's folder (its slot); its label is what it works on now">
              Slot <span className="mono">{ref}</span> on{' '}
              <button className="link-btn" onClick={() => navigate({ view: 'machine', machineId: m.id })}>
                {m.name ?? m.id}
              </button>
            </span>
            <span title={new Date(sb.createdAt).toLocaleString()}>created {fmtRelative(sb.createdAt, now)}</span>
          </div>
          <div className="sb-facts">
            <GitFacts git={sb.git} />
            <span className="fact mono">
              <Icon name="folder" size={13} /> <span className="ellipsis">{sb.path}</span>
              <CopyButton text={sb.path} label="Copy path" />
            </span>
          </div>
        </DetailsSection>
        <DetailsSection title="Unity">
          <div className="unity-bar">
            <Chip tone={unityTone(u)} title={sb.unity.detail}>
              {unityLabel[u]}
              {sb.unity.pid ? <span className="mono dim"> pid {sb.unity.pid}</span> : null}
            </Chip>
            {sb.unity.detail && u !== 'running' && <span className="dim small ellipsis">{sb.unity.detail}</span>}
            <div className="spacer" />
            <button className={`btn btn-sm ${unityOn ? 'btn-outline' : 'btn-primary'}`} disabled={!reachable || unityBusy} onClick={toggleUnity}>
              <Icon name={unityOn ? 'power' : 'play'} size={14} /> {unityOn ? 'Stop Unity' : 'Start Unity'}
            </button>
          </div>
          <div className="details-buttons">
            <button className="btn btn-ghost btn-sm" disabled={!m.online} onClick={() => setLogOpen(true)} title="The editor's log, read on the machine">
              <Icon name="log" size={14} /> Log
            </button>
            <button className="btn btn-ghost btn-sm" disabled={!reachable} onClick={() => setSwitchOpen(true)} title="Switch this sandbox to another branch">
              <Icon name="branch" size={14} /> Branch
            </button>
          </div>
        </DetailsSection>
        {selected && <SessionDetails session={selected} />}
      </DetailsSheet>

      <AgentTabs sessions={sessions} selected={selected} onSelect={pick} onNew={() => setNewAgent(true)} newDisabled={!reachable} />

      {selected ? (
        <SessionView key={selected.id} session={selected} embedded />
      ) : sb.status === 'error' ? null : (
        <div className="panel-empty">
          <Icon name="bot" size={28} />
          <p>{ready ? 'No agents here yet.' : 'Agents can start once the sandbox is ready.'}</p>
          {ready && (
            <button className="btn btn-primary" disabled={!reachable} onClick={() => setNewAgent(true)}>
              <Icon name="plus" size={14} /> New agent
            </button>
          )}
          {ready && <p className="dim small">Or ask the orchestrator to put it to work.</p>}
        </div>
      )}

      {newAgent && <NewAgentModal app={app} target={{ sandboxId: ref, name: displayName(sb) }} onClose={() => setNewAgent(false)} />}
      {logOpen && <UnityLogDrawer name={`${displayName(sb)} (${ref})`} logPath={sb.unity.logPath} load={(lines) => api.machineSandboxLog(m.id, sb.id, lines)} onClose={() => setLogOpen(false)} />}
      {switchOpen && <SwitchBranchModal target={{ machine: m.id, sandbox: sb.id }} name={ref} git={sb.git} onClose={() => setSwitchOpen(false)} />}
    </section>
  );
}
