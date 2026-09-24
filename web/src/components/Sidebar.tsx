import type { AppState, Machine, PlanUsage, Sandbox, SessionInfo, StandingAgent, SystemStats, UsageMeter } from '../../../shared/types';
import { logout, useStore } from '../store';
import {
  fmtBytes,
  fmtClock,
  fmtCost,
  fmtUntil,
  headline,
  lastRun,
  machineLabel,
  machineTone,
  navigate,
  sandboxTone,
  sessionLabel,
  sessionTone,
  spentToday,
  standingLabel,
  standingTone,
  unityLabel,
  unityTone,
  useMediaQuery,
  useNow,
  displayName,
  isUnused,
  type Route,
} from '../util';
import { Chip, Dot, Icon } from './ui';
import { useState } from 'react';
import { usePush } from '../notify';
import { SettingsModal } from './Settings';
import { gitSummary } from './Git';

export function Sidebar({
  app,
  route,
  onNewSandbox,
  onNewStanding,
  onNewMachine,
  onNavigate,
}: {
  app: AppState;
  route: Route;
  onNewSandbox: () => void;
  onNewStanding: () => void;
  onNewMachine: () => void;
  onNavigate: () => void;
}) {
  const ws = useStore((s) => s.ws);
  const push = usePush();
  const [settings, setSettings] = useState(false);
  // On a phone the meters would push the sandbox list off the screen: fold them to one line.
  const narrow = useMediaQuery('(max-width: 860px)');
  const [metersOpen, setMetersOpen] = useState(false);
  const sessionsById = new Map(app.sessions.map((s) => [s.id, s]));
  const orch = sessionsById.get(app.orchestratorId);
  const selectedSandbox = route.view === 'sandbox' ? route.sandboxId : route.view === 'session' ? sessionsById.get(route.sessionId)?.sandboxId : undefined;
  const selectedMachine = route.view === 'machine' ? route.machineId : route.view === 'session' ? sessionsById.get(route.sessionId)?.machineId : undefined;

  const go = (r: Route) => {
    navigate(r);
    onNavigate();
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="26" height="26">
            <rect width="32" height="32" rx="7" fill="var(--panel-2)" />
            <path d="M8 23V9h13M8 16h9" stroke="var(--accent)" strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="22" r="3" fill="var(--accent)" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">FF Factory</div>
          <div className="brand-host mono">{app.system?.hostname ?? ''}</div>
        </div>
        <span className={`ws-ind ws-${ws}`} title={ws === 'open' ? 'Live' : ws === 'connecting' ? 'Connecting…' : 'Disconnected, retrying'} />
        <button className="btn btn-ghost btn-icon" title="Settings: notifications and voice input" aria-label="Settings" onClick={() => setSettings(true)}>
          <Icon name={push.endpoint ? 'bell' : 'bellOff'} size={15} />
        </button>
        <button className="btn btn-ghost btn-icon" title="Sign out" aria-label="Sign out" onClick={() => void logout()}>
          <Icon name="logout" size={15} />
        </button>
      </div>

      <button className={`nav-item${route.view === 'home' ? ' active' : ''}`} onClick={() => go({ view: 'home' })}>
        <Icon name="chat" />
        <span>Orchestrator</span>
        {orch && <Dot tone={sessionTone(orch.status)} pulse={orch.status === 'running'} title={sessionLabel[orch.status]} />}
      </button>

      <button className={`nav-item${route.view === 'search' ? ' active' : ''}`} onClick={() => go({ view: 'search' })}>
        <Icon name="search" />
        <span>Search transcripts</span>
      </button>

      {narrow && app.system && (
        <button className="meters-fold" onClick={() => setMetersOpen(!metersOpen)} aria-expanded={metersOpen}>
          <span className="mono small">
            CPU {Math.round(app.system.loadPct)}% · RAM {fmtBytes(app.system.memTotalBytes - app.system.memFreeBytes)} · Agents{' '}
            {app.sessions.filter((s) => s.kind !== 'orchestrator' && !s.machineId && s.status !== 'stopped' && s.status !== 'error').length}/{app.system.limits.maxSessions}
            {app.usage ? ' · plan' : ''}
          </span>
          <Icon name="chevron" size={12} />
        </button>
      )}
      {(!narrow || metersOpen) && app.system && <Meters sys={app.system} app={app} />}
      {(!narrow || metersOpen) && app.usage && <PlanMeters usage={app.usage} />}

      <div className="side-scroll">
        <div className="section-head">
          <span>Sandboxes</span>
          <span className="count">{app.sandboxes.length}</span>
          <button className="btn btn-ghost btn-xs" onClick={onNewSandbox}>
            <Icon name="plus" size={13} /> New
          </button>
        </div>

        <div className="sandbox-list">
          {app.sandboxes.length === 0 && (
            <div className="sandbox-empty">
              No sandboxes yet. Ask the orchestrator, or{' '}
              <button className="link-btn" onClick={onNewSandbox}>
                create one
              </button>
              .
            </div>
          )}
          {app.sandboxes.map((sb) => (
            <SandboxCard
              key={sb.id}
              sandbox={sb}
              sessions={sb.sessionIds.map((id) => sessionsById.get(id)).filter((s): s is SessionInfo => !!s)}
              active={selectedSandbox === sb.id}
              onClick={() => go({ view: 'sandbox', sandboxId: sb.id })}
            />
          ))}
        </div>

        <div className="section-head">
          <span>Machines</span>
          <span className="count">{app.machines.length}</span>
          <button className="btn btn-ghost btn-xs" onClick={onNewMachine}>
            <Icon name="plus" size={13} /> Add
          </button>
        </div>
        <div className="sandbox-list">
          {app.machines.length === 0 && (
            <div className="sandbox-empty">
              The user's Macs, where agents work in their main clone.{' '}
              <button className="link-btn" onClick={onNewMachine}>
                Add one
              </button>
              .
            </div>
          )}
          {app.machines.map((m) => (
            <MachineCard
              key={m.id}
              machine={m}
              sessions={m.sessionIds.map((id) => sessionsById.get(id)).filter((s): s is SessionInfo => !!s && s.kind !== 'standing')}
              active={selectedMachine === m.id}
              onClick={() => go({ view: 'machine', machineId: m.id })}
            />
          ))}
        </div>

        <div className="section-head">
          <span>Standing agents</span>
          <span className="count">{app.standingAgents.length}</span>
          <button className="btn btn-ghost btn-xs" onClick={onNewStanding}>
            <Icon name="plus" size={13} /> New
          </button>
        </div>
        <div className="sandbox-list">
          {app.standingAgents.length === 0 && (
            <div className="sandbox-empty">
              None yet. Long-lived agents with a job and a schedule, apart from the sandboxes.{' '}
              <button className="link-btn" onClick={onNewStanding}>
                Define one
              </button>
              .
            </div>
          )}
          {app.standingAgents.map((a) => (
            <StandingCard
              key={a.id}
              agent={a}
              pendingDelegations={app.delegations.filter((d) => d.agentId === a.id && d.status === 'pending').length}
              active={route.view === 'agent' && route.agentId === a.id}
              onClick={() => go({ view: 'agent', agentId: a.id })}
            />
          ))}
        </div>
      </div>

      <button className="btn btn-outline new-sb" onClick={onNewSandbox}>
        <Icon name="plus" size={14} /> New sandbox
      </button>
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </aside>
  );
}

function Meter({ label, pct, value, warn = 75, crit = 90 }: { label: string; pct: number; value: string; warn?: number; crit?: number }) {
  const p = Math.max(0, Math.min(100, pct));
  const level = p >= crit ? 'crit' : p >= warn ? 'warn' : 'ok';
  return (
    <div className={`meter meter-${level}`}>
      <div className="meter-row">
        <span className="meter-label">{label}</span>
        <span className="meter-value mono">{value}</span>
      </div>
      <div className="meter-bar">
        <i style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function Meters({ sys, app }: { sys: SystemStats; app: AppState }) {
  const memUsed = sys.memTotalBytes - sys.memFreeBytes;
  const unityOn = app.sandboxes.filter((s) => s.unity.state !== 'stopped' && s.unity.state !== 'crashed').length;
  // Workers and running standing agents on this host share limits.maxSessions; a sleeping standing agent is
  // 'stopped', and agents on a machine count toward that machine's own limit.
  const agentsOn = app.sessions.filter((s) => s.kind !== 'orchestrator' && !s.machineId && s.status !== 'stopped' && s.status !== 'error').length;
  return (
    <div className="meters" title={`${sys.cpuModel} · ${sys.cpuCount} threads`}>
      <Meter label="CPU" pct={sys.loadPct} value={`${Math.round(sys.loadPct)}%`} />
      <Meter label="RAM" pct={(memUsed / sys.memTotalBytes) * 100} value={`${fmtBytes(memUsed)} / ${fmtBytes(sys.memTotalBytes)}`} />
      {sys.gpu && (
        <Meter
          label="VRAM"
          pct={(sys.gpu.memUsedMiB / sys.gpu.memTotalMiB) * 100}
          value={`${(sys.gpu.memUsedMiB / 1024).toFixed(1)} / ${(sys.gpu.memTotalMiB / 1024).toFixed(0)} GB · ${Math.round(sys.gpu.utilPct)}%`}
        />
      )}
      {sys.diskTotalBytes !== undefined && sys.diskFreeBytes !== undefined && (
        <Meter
          label="Disk"
          pct={((sys.diskTotalBytes - sys.diskFreeBytes) / sys.diskTotalBytes) * 100}
          value={`${fmtBytes(sys.diskFreeBytes)} free`}
          warn={85}
          crit={95}
        />
      )}
      <div className="limits">
        <span className={unityOn >= sys.limits.maxUnity ? 'at-limit' : ''}>
          Unity <b className="mono">{unityOn}/{sys.limits.maxUnity}</b>
        </span>
        <span className={agentsOn >= sys.limits.maxSessions ? 'at-limit' : ''}>
          Agents <b className="mono">{agentsOn}/{sys.limits.maxSessions}</b>
        </span>
      </div>
    </div>
  );
}

/** the user's Claude plan limits (server/usage.ts): weekly first, then the 5-hour session and per-model weekly windows. */
function PlanMeters({ usage: u }: { usage: PlanUsage }) {
  const now = useNow(60_000);
  const asOf = `as of ${fmtClock(u.asOf)}${u.error ? ' (refresh failed)' : ''}`;
  if (!u.available) {
    return (
      <div className="meters plan-meters" title={u.why}>
        <div className="meter-row">
          <span className="meter-label">Claude plan</span>
          <span className="meter-value">unavailable</span>
        </div>
        {u.why && <div className="plan-asof dim">{u.why}</div>}
        {u.spendWeekUsd !== undefined && (
          <div className="meter-row" title="What FF Factory's own agents cost over the last 7 days, from their reported cost. This is spend, not the plan's usage limit.">
            <span className="meter-label">Portal spend 7 d</span>
            <span className="meter-value mono">{fmtCost(u.spendWeekUsd)}</span>
          </div>
        )}
        <div className="plan-asof dim">{asOf}</div>
      </div>
    );
  }
  const rows = [u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m);
  return (
    <div className="meters plan-meters" title={`Claude ${u.plan ?? ''} plan usage limits, from the claude.ai usage endpoint`}>
      {rows.map((m) => (
        <Meter key={m.label} label={m.label} pct={m.percent} value={`${Math.round(m.percent)}%${m.resetsAt ? ` · ${resetLabel(m.resetsAt, now)}` : ''}`} />
      ))}
      <div className="plan-asof dim">
        Claude {u.plan ?? 'plan'} · {asOf}
      </div>
    </div>
  );
}

function resetLabel(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const h = (t - now) / 3_600_000;
  if (h <= 0) return 'resetting';
  if (h < 1) return `resets in ${Math.max(1, Math.round(h * 60))}m`;
  if (h < 24) return `resets in ${Math.round(h)}h`;
  const d = new Date(t);
  return `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** A sandbox's or machine's agents by name (the id is secondary), newest first, a few at most. */
function AgentRows({ sessions }: { sessions: SessionInfo[] }) {
  if (!sessions.length) return null;
  const shown = [...sessions].reverse().slice(0, 4);
  return (
    <div className="agent-rows">
      {shown.map((s) => (
        <div key={s.id} className="agent-row" title={`${s.title} (${s.id}): ${sessionLabel[s.status]}`}>
          <Dot tone={sessionTone(s.status)} pulse={s.status === 'running'} />
          <span className="agent-row-title ellipsis">{s.title}</span>
          {s.pendingPermissions.length > 0 && <span className="badge badge-amber">{s.pendingPermissions.length}</span>}
          <span className="agent-row-id mono">{s.id}</span>
        </div>
      ))}
      {sessions.length > shown.length && <div className="agent-row dim">+{sessions.length - shown.length} more</div>}
    </div>
  );
}

function MachineCard({ machine: m, sessions, active, onClick }: { machine: Machine; sessions: SessionInfo[]; active: boolean; onClick: () => void }) {
  const needs = sessions.reduce((n, s) => n + s.pendingPermissions.length, 0);
  return (
    <button className={`sb-card${active ? ' active' : ''}`} onClick={onClick}>
      <div className="sb-top">
        <Dot tone={machineTone(m)} pulse={m.status === 'deploying'} title={machineLabel(m)} />
        <span className={`sb-name sb-title${isUnused(m.purpose) ? ' is-unused' : ''}`}>{displayName(m)}</span>
        {needs > 0 && (
          <span className="badge badge-amber" title="Waiting on you">
            {needs}
          </span>
        )}
      </div>
      <div className="sb-slot mono">machine: {m.id}</div>
      <div className="sb-branch mono ellipsis" title={m.repoPath}>
        <Icon name="branch" size={12} /> {m.git ? m.git.branch : m.repoPath || '—'}
        {m.git && (m.git.dirty || m.git.untracked || m.git.ahead || m.git.behind) ? <span className="sb-git"> · {gitSummary(m.git)}</span> : null}
        {m.git?.pr && <span className="sb-git"> · PR #{m.git.pr.number}</span>}
      </div>
      {m.status === 'deploying' && (
        <div className="sb-progress">
          <div className="indeterminate" />
          <span className="ellipsis">{m.statusDetail ?? 'Setting up…'}</span>
        </div>
      )}
      {m.status === 'error' && <div className="sb-error">{m.statusDetail ?? 'Error'}</div>}
      {m.status === 'ready' && (
        <div className="sb-bottom">
          <Chip tone={machineTone(m)}>{machineLabel(m)}</Chip>
        </div>
      )}
      {m.status === 'ready' && <AgentRows sessions={sessions} />}
    </button>
  );
}

function StandingCard({ agent: a, pendingDelegations, active, onClick }: { agent: StandingAgent; pendingDelegations: number; active: boolean; onClick: () => void }) {
  const now = useNow(15000);
  const last = lastRun(a);
  const when =
    a.state === 'running'
      ? 'running now'
      : a.state === 'waiting'
        ? 'waiting for a slot'
        : a.nextRunAt
          ? `next ${fmtUntil(a.nextRunAt, now)}`
          : a.enabled
            ? 'manual'
            : 'paused';
  return (
    <button className={`sb-card sa-card${active ? ' active' : ''}`} onClick={onClick}>
      <div className="sb-top">
        <Dot tone={standingTone(a)} pulse={a.state === 'running' || a.state === 'waiting'} title={standingLabel[a.state]} />
        <span className="sb-name ellipsis">{a.name}</span>
        {pendingDelegations > 0 && (
          <span className="badge badge-amber" title="Delegation requests waiting on you">
            {pendingDelegations}
          </span>
        )}
      </div>
      {last?.summary && <div className="sb-purpose">{headline(last.summary)}</div>}
      <div className="sb-bottom">
        <span className="sb-branch">
          <Icon name="clock" size={12} /> {when}
        </span>
        <span className="sb-branch mono" title="Spent today / daily budget">
          {fmtCost(spentToday(a))} / ${a.budget.perDayUsd.toFixed(0)}
        </span>
      </div>
    </button>
  );
}

function SandboxCard({
  sandbox: sb,
  sessions,
  active,
  onClick,
}: {
  sandbox: Sandbox;
  sessions: SessionInfo[];
  active: boolean;
  onClick: () => void;
}) {
  const needs = sessions.reduce((n, s) => n + s.pendingPermissions.length, 0);
  const busyStatus = sb.status === 'creating' || sb.status === 'deleting';
  return (
    <button className={`sb-card${active ? ' active' : ''} sb-${sb.status}`} onClick={onClick}>
      <div className="sb-top">
        <Dot tone={sandboxTone(sb.status)} pulse={busyStatus} title={sb.status} />
        <span className={`sb-name sb-title${isUnused(sb.purpose) ? ' is-unused' : ''}`}>{displayName(sb)}</span>
        {needs > 0 && <span className="badge badge-amber" title="Waiting on you">{needs}</span>}
      </div>
      <div className="sb-slot mono">slot: {sb.id}</div>
      <div className="sb-branch mono ellipsis" title={sb.git ? `${sb.git.branch}: ${gitSummary(sb.git)}` : 'git status not read yet'}>
        <Icon name="branch" size={12} /> {sb.git?.branch ?? '…'}
        {sb.git && (sb.git.dirty || sb.git.untracked || sb.git.ahead) ? <span className="sb-git"> · {gitSummary(sb.git)}</span> : null}
        {sb.git?.pr && <span className="sb-git"> · PR #{sb.git.pr.number}</span>}
      </div>
      {busyStatus && (
        <div className="sb-progress">
          <div className="indeterminate" />
          <span className="ellipsis">{sb.statusDetail ?? (sb.status === 'creating' ? 'Creating…' : 'Deleting…')}</span>
        </div>
      )}
      {sb.status === 'error' && <div className="sb-error">{sb.statusDetail ?? 'Error'}</div>}
      {sb.status === 'ready' && (
        <div className="sb-bottom">
          <Chip tone={unityTone(sb.unity.state)}>{unityLabel[sb.unity.state]}</Chip>
        </div>
      )}
      {sb.status === 'ready' && <AgentRows sessions={sessions} />}
    </button>
  );
}
