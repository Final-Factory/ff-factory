import { useState } from 'react';
import type { AppState, Machine, SessionInfo } from '../../../shared/types';
import { api } from '../api';
import { attempt, toast, upsertMachine } from '../store';
import { displayName, fmtRelative, isUnused, machineLabel, machineTone, navigate, useNow } from '../util';
import { NewAgentModal } from './Modals';
import { ScreenshotsDrawer } from './Images';
import { GitFacts, SwitchBranchModal } from './Git';
import { SessionDetails, SessionView } from './SessionView';
import { AgentSwitcher, AgentTabs, CriticalBadges, DetailsSection, DetailsSheet, PanelHeader, useDetailsOpen } from './PanelChrome';
import { Chip, Confirm, CopyButton, Dot, Icon, Modal } from './ui';

/** One of the user's Macs (docs/machines.md): its daemon's state, its clone, and its agents. */
export function MachinePanel({ app, machine: m, sessionId, onClose }: { app: AppState; machine: Machine; sessionId?: string; onClose?: () => void }) {
  const now = useNow();
  // Standing agents assigned here have their own page; the tabs are the machine's workers.
  const sessions = m.sessionIds.map((id) => app.sessions.find((s) => s.id === id)).filter((s): s is SessionInfo => !!s && s.kind !== 'standing');
  const selected = sessions.find((s) => s.id === sessionId) ?? sessions[sessions.length - 1];
  const [newAgent, setNewAgent] = useState(false);
  const [label, setLabel] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);
  const [shotsOpen, setShotsOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const live = sessions.filter((s) => s.status === 'running' || s.status === 'starting' || s.status === 'waiting_permission').length;
  const g = m.git;

  const redeploy = async () => {
    const r = await attempt(api.redeployMachine(m.id, live > 0));
    if (r) upsertMachine(r);
  };

  const [details, setDetails] = useDetailsOpen('machine');
  const pick = (id: string) => navigate({ view: 'machine', machineId: m.id, sessionId: id }, true);
  const canAdd = m.status === 'ready' && m.online;

  return (
    <section className="sb-panel">
      <PanelHeader
        onBack={onClose}
        dot={<Dot tone={machineTone(m)} pulse={m.status === 'deploying'} />}
        title={displayName(m)}
        titleClass={isUnused(m.purpose) ? 'is-unused' : ''}
        subtitle={<span className="mono">machine {m.id}</span>}
        switcher={<AgentSwitcher sessions={sessions} selected={selected} onSelect={pick} onNew={() => setNewAgent(true)} newDisabled={!canAdd} />}
        badges={<CriticalBadges session={selected} />}
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
      />
      {m.status === 'deploying' && (
        <div className="sb-progress">
          <div className="indeterminate" />
          <span>{m.statusDetail ?? 'Setting up…'}</span>
        </div>
      )}
      {m.status === 'error' && <div className="banner banner-error">{m.statusDetail ?? 'Error'}</div>}
      <DetailsSheet open={details} onClose={() => setDetails(false)} title={displayName(m)}>
        <DetailsSection
          title="Machine"
          actions={
            <span className="details-actions">
              <button className="btn btn-ghost btn-sm" title="Change label" onClick={() => setLabel(true)}>
                <Icon name="edit" size={14} /> Label
              </button>
              <button className="btn btn-ghost btn-sm" title="Redeploy the daemon" disabled={m.status === 'deploying'} onClick={() => (live ? setConfirmRedeploy(true) : void redeploy())}>
                <Icon name="refresh" size={14} /> Redeploy
              </button>
              <button className="btn btn-ghost btn-sm danger-hover" title="Remove machine" onClick={() => setConfirmRemove(true)}>
                <Icon name="trash" size={14} /> Remove
              </button>
            </span>
          }
        >
          <div className="details-row">
            <span className={`details-name${isUnused(m.purpose) ? ' is-unused' : ''}`}>{displayName(m)}</span>
            <span className="sb-slot mono">machine: {m.id}</span>
            <span className="dim small">{m.info?.hostname ?? `ssh ${m.host}`}</span>
          </div>
          <div className="sb-facts">
            <span className="fact mono">
              <Icon name="folder" size={13} /> <span className="ellipsis">{m.repoPath || 'repo not found yet'}</span>
              {m.repoPath && <CopyButton text={m.repoPath} label="Copy path" />}
            </span>
            <GitFacts git={g} />
            {m.info && (
              <span className="fact">
                <Icon name="bot" size={13} />
                <span className="ellipsis dim">
                  {m.info.os} · node {m.info.node} · claude {m.info.claude ?? '?'} · daemon {m.info.daemon}
                </span>
              </span>
            )}
          </div>
          <div className="unity-bar">
            <Chip tone={machineTone(m)}>{machineLabel(m)}</Chip>
            <span className="dim small ellipsis">
              {m.online ? `${live}/${m.maxSessions} agents running` : m.lastSeen ? `last seen ${fmtRelative(m.lastSeen, now)}` : 'never connected'}
              {m.statusDetail && m.status === 'ready' ? ` · ${m.statusDetail}` : ''}
            </span>
          </div>
          <div className="details-buttons">
            <button className="btn btn-ghost btn-sm" disabled={!m.online} onClick={() => setShotsOpen(true)} title="Screenshots and other images agents left in the clone">
              <Icon name="image" size={14} /> Screenshots
            </button>
            <button className="btn btn-ghost btn-sm" disabled={!m.online} onClick={() => setSwitchOpen(true)} title="Switch the clone to another branch">
              <Icon name="branch" size={14} /> Branch
            </button>
            <button className="btn btn-sm btn-primary" disabled={!canAdd} onClick={() => setNewAgent(true)}>
              <Icon name="plus" size={13} /> New agent
            </button>
          </div>
        </DetailsSection>
        {selected && <SessionDetails session={selected} />}
      </DetailsSheet>

      <AgentTabs sessions={sessions} selected={selected} onSelect={pick} />

      {selected ? (
        <SessionView key={selected.id} session={selected} embedded />
      ) : (
        <div className="panel-empty">
          <Icon name="bot" size={28} />
          <p>No agents on this machine yet.</p>
          <p className="dim small">They work in the user's main clone here, next to their own uncommitted work.</p>
          <button className="btn btn-primary" disabled={!canAdd} onClick={() => setNewAgent(true)}>
            <Icon name="plus" size={14} /> New agent
          </button>
        </div>
      )}

      {newAgent && <NewAgentModal app={app} target={{ machineId: m.id, name: m.id }} onClose={() => setNewAgent(false)} />}
      {label && <LabelModal machine={m} onClose={() => setLabel(false)} />}
      {shotsOpen && <ScreenshotsDrawer place={{ machine: m.id }} title={m.id} onClose={() => setShotsOpen(false)} />}
      {switchOpen && <SwitchBranchModal target={{ machine: m.id }} name={m.id} git={m.git} onClose={() => setSwitchOpen(false)} />}
      {confirmRedeploy && (
        <Confirm
          title={`Redeploy ${m.id}?`}
          danger
          confirmLabel="Redeploy"
          body={<p>{live} agent(s) are running there. Redeploying restarts the daemon, which stops them; they resume when messaged.</p>}
          onConfirm={redeploy}
          onClose={() => setConfirmRedeploy(false)}
        />
      )}
      {confirmRemove && (
        <Confirm
          title={`Remove ${m.id}?`}
          danger
          confirmLabel="Remove machine"
          body={
            <>
              <p>Unloads its daemon over ssh and removes it and its agents from here.</p>
              <p className="dim">Nothing in its Final Factory clone is touched; the daemon's files stay in ~/.ff-factory.</p>
            </>
          }
          onConfirm={async () => {
            const r = await attempt(api.removeMachine(m.id));
            if (r) {
              toast(r.note);
              navigate({ view: 'home' });
            }
          }}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </section>
  );
}

function LabelModal({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const [purpose, setPurpose] = useState(machine.purpose);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!purpose.trim() || busy) return;
    setBusy(true);
    const r = await attempt(api.labelMachine(machine.id, purpose.trim()));
    setBusy(false);
    if (r) {
      upsertMachine(r);
      onClose();
    }
  };
  return (
    <Modal
      title={
        <>
          Label <span className="mono accent">{machine.id}</span>
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!purpose.trim() || busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>What it is being used for</span>
          <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="unused" autoFocus />
        </label>
      </form>
    </Modal>
  );
}

/** Set up a Mac over ssh from the portal host. */
export function AddMachineModal({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState('');
  const [host, setHost] = useState('');
  const [portalUrl, setPortalUrl] = useState(location.origin);
  const [repoPath, setRepoPath] = useState('');
  const [max, setMax] = useState('3');
  const [busy, setBusy] = useState(false);
  const slug = id.trim().toLowerCase();
  const valid = /^[a-z0-9][a-z0-9-]{0,23}$/.test(slug) && /^https?:\/\/[^/\s]+$/.test(portalUrl.trim().replace(/\/+$/, ''));
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const m = await attempt(
      api.addMachine({ id: slug, host: host.trim() || undefined, portalUrl: portalUrl.trim().replace(/\/+$/, ''), repoPath: repoPath.trim() || undefined, maxSessions: Number(max) || 3 }),
    );
    setBusy(false);
    if (m) {
      upsertMachine(m);
      navigate({ view: 'machine', machineId: m.id });
      onClose();
    }
  };
  return (
    <Modal
      title="Add a machine"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Starting…' : 'Set it up'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="dim small">
          Installs the FF Factory daemon on the Mac over ssh from this host (a LaunchAgent that runs agents there and connects back). Needs ssh key access and Node 22.6+ on
          the Mac.
        </p>
        <div className="field-row">
          <label className="field">
            <span>Id</span>
            <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="m5" autoFocus />
          </label>
          <label className="field">
            <span>ssh host</span>
            <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder={slug || 'same as the id'} />
          </label>
        </div>
        <label className="field">
          <span>Portal URL the Mac connects to</span>
          <input className="input mono" value={portalUrl} onChange={(e) => setPortalUrl(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Final Factory clone</span>
            <input className="input mono" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="found automatically" />
          </label>
          <label className="field">
            <span>Max agents at once</span>
            <input className="input mono" type="number" min={1} max={8} value={max} onChange={(e) => setMax(e.target.value)} />
          </label>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
