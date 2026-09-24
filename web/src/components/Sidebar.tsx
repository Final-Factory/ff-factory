import { useState, type ReactNode } from 'react';
import type { AppState, HostHealth, PlanUsage, SessionInfo, SystemStats, UsageMeter } from '../../../shared/types';
import { useAttention, type AttentionItem } from '../attention';
import {
  displayName,
  fmtBytes,
  fmtClock,
  fmtCost,
  isUnused,
  lsGet,
  lsSet,
  machineGlance,
  navigate,
  sandboxGlance,
  sessionLabel,
  sessionTone,
  standingGlance,
  useNow,
  versionLabel,
  type Glance,
  type Route,
} from '../util';
import { Dot, Icon, type IconName } from './ui';
import { usePush } from '../notify';
import { SettingsModal } from './Settings';

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
  const push = usePush();
  const now = useNow(15_000);
  const [settings, setSettings] = useState(false);
  const attention = useAttention(app);
  const sessionsById = new Map(app.sessions.map((s) => [s.id, s]));
  const orch = sessionsById.get(app.orchestratorId);
  const of = (ids: string[]) => ids.map((id) => sessionsById.get(id)).filter((s): s is SessionInfo => !!s);
  const selectedSandbox = route.view === 'sandbox' ? route.sandboxId : route.view === 'session' ? sessionsById.get(route.sessionId)?.sandboxId : undefined;
  const selectedMachine = route.view === 'machine' ? route.machineId : route.view === 'session' ? sessionsById.get(route.sessionId)?.machineId : undefined;

  const go = (r: Route) => {
    navigate(r);
    onNavigate();
  };

  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="24" height="24">
            <rect width="32" height="32" rx="7" fill="var(--panel-2)" />
            <path d="M8 23V9h13M8 16h9" stroke="var(--accent)" strokeWidth="3.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="22" r="3" fill="var(--accent)" />
          </svg>
        </div>
        <div className="brand-text">
          <span className="brand-name">FF Factory</span>
          {app.system?.hostname && <span className="brand-host">{app.system.hostname}</span>}
        </div>
        <button className="btn btn-ghost btn-icon side-icon" title="Search every conversation" aria-label="Search" onClick={() => go({ view: 'search' })}>
          <Icon name="search" size={17} />
        </button>
        <button className="btn btn-ghost btn-icon side-icon" title={push.endpoint ? 'Settings: notifications are on' : 'Settings: notifications and voice'} aria-label="Settings" onClick={() => setSettings(true)}>
          <Icon name={push.endpoint ? 'bell' : 'bellOff'} size={17} />
        </button>
      </div>

      <div className="side-scroll">
        {orch && (
          <Row
            active={route.view === 'home'}
            icon="chat"
            tone={sessionTone(orch.status)}
            pulse={orch.status === 'running'}
            title="Orchestrator"
            sub={<span className={`tone-${sessionTone(orch.status)}`}>{sessionLabel[orch.status]}</span>}
            onClick={() => go({ view: 'home' })}
          />
        )}

        {attention.length > 0 && <AttentionList items={attention} onPick={onNavigate} />}

        <Section title="Sandboxes" count={app.sandboxes.length} add="New sandbox" onAdd={onNewSandbox}>
          {app.sandboxes.length === 0 && (
            <p className="side-empty">
              None yet. Ask the orchestrator for work, or{' '}
              <button className="link-btn" onClick={onNewSandbox}>
                create one
              </button>
              .
            </p>
          )}
          {app.sandboxes.map((sb) => (
            <PlaceRow
              key={sb.id}
              title={displayName(sb)}
              unused={isUnused(sb.purpose)}
              glance={sandboxGlance(sb, of(sb.sessionIds))}
              active={selectedSandbox === sb.id}
              hint={`Slot ${sb.id}${sb.git ? ` · ${sb.git.branch}` : ''}${sb.sessionIds.length ? `\nAgents: ${of(sb.sessionIds).map((s) => s.title).join(', ')}` : ''}`}
              onClick={() => go({ view: 'sandbox', sandboxId: sb.id })}
            />
          ))}
        </Section>

        <Section title="Machines" count={app.machines.length} add="Add a machine" onAdd={onNewMachine}>
          {app.machines.length === 0 && (
            <p className="side-empty">
              Macs where agents work in the main clone.{' '}
              <button className="link-btn" onClick={onNewMachine}>
                Add one
              </button>
              .
            </p>
          )}
          {app.machines.map((m) => (
            <PlaceRow
              key={m.id}
              title={displayName(m)}
              unused={isUnused(m.purpose)}
              prefix={m.id}
              glance={machineGlance(m, of(m.sessionIds).filter((s) => s.kind !== 'standing'), now)}
              active={selectedMachine === m.id}
              hint={`Machine ${m.id}${m.git ? ` · ${m.git.branch}` : ''}`}
              onClick={() => go({ view: 'machine', machineId: m.id })}
            />
          ))}
        </Section>

        <Section title="Standing agents" count={app.standingAgents.length} add="New standing agent" onAdd={onNewStanding}>
          {app.standingAgents.length === 0 && (
            <p className="side-empty">
              Long-lived agents with a job and a schedule.{' '}
              <button className="link-btn" onClick={onNewStanding}>
                Define one
              </button>
              .
            </p>
          )}
          {app.standingAgents.map((a) => (
            <PlaceRow
              key={a.id}
              title={a.name}
              glance={standingGlance(
                a,
                app.delegations.filter((d) => d.agentId === a.id && d.status === 'pending').length,
                now,
              )}
              active={route.view === 'agent' && route.agentId === a.id}
              hint={`${a.model} · today ${fmtCost(a.spend.usd)} of $${a.budget.perDayUsd.toFixed(0)}`}
              onClick={() => go({ view: 'agent', agentId: a.id })}
            />
          ))}
        </Section>
      </div>

      <SystemFooter app={app} />
      {app.app && (
        <div className="side-foot" data-testid="app-version" title="FF Factory version and git commit">
          {versionLabel(app.app)}
        </div>
      )}
      {settings && <SettingsModal app={app.app} onClose={() => setSettings(false)} />}
    </aside>
  );
}

// ---------------------------------------------------------------- rows

function Row({ active, icon, tone, pulse, title, sub, onClick }: { active: boolean; icon: IconName; tone: Glance['tone']; pulse?: boolean; title: string; sub: ReactNode; onClick: () => void }) {
  return (
    <button className={`row${active ? ' active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <span className="row-icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="row-main">
        <span className="row-title">{title}</span>
        <span className="row-sub">{sub}</span>
      </span>
      <Dot tone={tone} pulse={pulse} />
    </button>
  );
}

/** A sandbox, machine or standing agent: its name, then what it is doing in words (coloured) and for whom. */
function PlaceRow({ title, unused, prefix, glance: g, active, hint, onClick }: { title: string; unused?: boolean; prefix?: string; glance: Glance; active: boolean; hint: string; onClick: () => void }) {
  return (
    <button className={`row place${active ? ' active' : ''}${g.attention ? ' has-attn' : ''}`} onClick={onClick} title={`${title}\n${hint}`} aria-current={active ? 'page' : undefined}>
      <span className="row-icon">
        <Dot tone={g.tone} pulse={g.tone === 'blue'} />
      </span>
      <span className="row-main">
        <span className={`row-title${unused ? ' is-unused' : ''}`}>{title}</span>
        <span className="row-sub">
          {prefix && <span className="row-prefix">{prefix} · </span>}
          <span className={`tone-${g.tone}`}>{g.label}</span>
          {g.detail && <span className="row-detail"> · {g.detail}</span>}
        </span>
        {g.progress && <span className="indeterminate row-progress" />}
      </span>
      {g.attention > 0 && (
        <span className="badge badge-amber" title="Waiting on you">
          {g.attention}
        </span>
      )}
    </button>
  );
}

function Section({ title, count, add, onAdd, children }: { title: string; count: number; add: string; onAdd: () => void; children: ReactNode }) {
  return (
    <section className="side-section">
      <div className="section-head">
        <span>{title}</span>
        {count > 0 && <span className="count">{count}</span>}
        <button className="btn btn-ghost btn-icon section-add" onClick={onAdd} title={add} aria-label={add}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {children}
    </section>
  );
}

const ATTN_ICON: Record<AttentionItem['kind'], IconName> = { permission: 'bell', unity: 'alert', delegation: 'inbox' };

/** Everything waiting on the user, oldest first; each opens where it is answered. */
function AttentionList({ items, onPick }: { items: AttentionItem[]; onPick: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 4);
  return (
    <section className="attn" aria-label="Needs you">
      <div className="attn-head">
        <Icon name="bell" size={14} />
        <span>Needs you</span>
        <span className="count">{items.length}</span>
      </div>
      {shown.map((it) => (
        <button
          key={it.key}
          className="attn-item"
          onClick={() => {
            it.open();
            onPick();
          }}
        >
          <Icon name={ATTN_ICON[it.kind]} size={15} />
          <span className="attn-text">
            <span className="attn-title">{it.title}</span>
            <span className="attn-detail">{it.detail}</span>
          </span>
          <Icon name="chevron" size={12} />
        </button>
      ))}
      {items.length > shown.length && (
        <button className="link-btn attn-more" onClick={() => setAll(true)}>
          {items.length - shown.length} more
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the machine and the plan

const level = (pct: number, warn = 75, crit = 90) => (pct >= crit ? 'crit' : pct >= warn ? 'warn' : 'ok');

/** Two short lines of the host's load and the Claude plan; a tap opens the full meters. */
function SystemFooter({ app }: { app: AppState }) {
  const [open, setOpen] = useState(() => lsGet('ffsb.meters') === '1');
  const sys = app.system;
  if (!sys) return null;
  const toggle = () => {
    setOpen(!open);
    lsSet('ffsb.meters', open ? null : '1');
  };
  const ram = ((sys.memTotalBytes - sys.memFreeBytes) / sys.memTotalBytes) * 100;
  const vram = sys.gpu ? (sys.gpu.memUsedMiB / sys.gpu.memTotalMiB) * 100 : undefined;
  const unityOn = app.sandboxes.filter((s) => s.unity.state !== 'stopped' && s.unity.state !== 'crashed').length;
  // Workers and running standing agents on this host share limits.maxSessions; agents on a machine count toward its own limit.
  const agentsOn = app.sessions.filter((s) => s.kind !== 'orchestrator' && !s.machineId && s.status !== 'stopped' && s.status !== 'error').length;
  const u = app.usage;
  const others = u?.available ? [u.session, ...u.models].filter((m): m is UsageMeter => !!m && m.percent >= 75) : [];
  const hot = others.sort((a, b) => b.percent - a.percent)[0];
  const short = (label: string) => label.replace(/^Weekly\s+/i, '').replace(/^5-hour session$/i, '5h');
  const Val = ({ pct, children, warn, crit }: { pct: number; children: ReactNode; warn?: number; crit?: number }) => <b className={`lvl-${level(pct, warn, crit)}`}>{children}</b>;
  return (
    <div className={`sys-foot${open ? ' open' : ''}`}>
      {open && (
        <div className="sys-detail">
          <Meters sys={sys} unityOn={unityOn} agentsOn={agentsOn} health={app.host?.health} />
          {u && <PlanMeters usage={u} />}
        </div>
      )}
      <button className="sys-toggle" onClick={toggle} aria-expanded={open} title={`${sys.cpuModel} · ${sys.cpuCount} threads. Tap for the meters.`}>
        <span className="sys-cells">
          <span>
            CPU <Val pct={sys.loadPct}>{Math.round(sys.loadPct)}%</Val>
          </span>
          <span>
            RAM <Val pct={ram}>{Math.round(ram)}%</Val>
          </span>
          {vram !== undefined && (
            <span>
              VRAM <Val pct={vram}>{Math.round(vram)}%</Val>
            </span>
          )}
          <span>
            Unity <Val pct={(unityOn / sys.limits.maxUnity) * 100} warn={100} crit={101}>{`${unityOn}/${sys.limits.maxUnity}`}</Val>
          </span>
          <span>
            Agents <Val pct={(agentsOn / sys.limits.maxSessions) * 100} warn={100} crit={101}>{`${agentsOn}/${sys.limits.maxSessions}`}</Val>
          </span>
          {u &&
            (u.available && u.weekly ? (
              <span>
                Plan <Val pct={u.weekly.percent}>{Math.round(u.weekly.percent)}%</Val>
                {hot && (
                  <>
                    {' · '}
                    {short(hot.label)} <Val pct={hot.percent}>{Math.round(hot.percent)}%</Val>
                  </>
                )}
              </span>
            ) : (
              <span>
                Plan <b className="lvl-warn">?</b>
              </span>
            ))}
        </span>
        <Icon name="chevron" size={12} />
      </button>
    </div>
  );
}

function Meter({ label, pct, value, warn = 75, crit = 90, lvl }: { label: string; pct: number; value: string; warn?: number; crit?: number; lvl?: 'ok' | 'warn' | 'crit' }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={`meter meter-${lvl ?? level(p, warn, crit)}`}>
      <div className="meter-row">
        <span className="meter-label">{label}</span>
        <span className="meter-value">{value}</span>
      </div>
      <div className="meter-bar">
        <i style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

function Meters({ sys, unityOn, agentsOn, health }: { sys: SystemStats; unityOn: number; agentsOn: number; health?: HostHealth }) {
  const memUsed = sys.memTotalBytes - sys.memFreeBytes;
  return (
    <div className="meters">
      <Meter label="CPU" pct={sys.loadPct} value={`${Math.round(sys.loadPct)}%`} />
      <Meter label="RAM" pct={(memUsed / sys.memTotalBytes) * 100} value={`${fmtBytes(memUsed)} of ${fmtBytes(sys.memTotalBytes)}`} />
      {sys.gpu && (
        <Meter
          label="VRAM"
          pct={(sys.gpu.memUsedMiB / sys.gpu.memTotalMiB) * 100}
          value={`${(sys.gpu.memUsedMiB / 1024).toFixed(1)} of ${(sys.gpu.memTotalMiB / 1024).toFixed(0)} GB · GPU ${Math.round(sys.gpu.utilPct)}%`}
        />
      )}
      {health?.disks.length
        ? // The host guard's volumes, coloured by its own levels (hostGuard.warnFreeGB / criticalFreeGB).
          health.disks.map((d) =>
            d.totalBytes !== undefined && d.freeBytes !== undefined ? (
              <Meter
                key={d.path}
                label={`Disk ${d.path.replace(/[\\/]+$/, '')}`}
                pct={((d.totalBytes - d.freeBytes) / d.totalBytes) * 100}
                value={`${fmtBytes(d.freeBytes)} free`}
                lvl={d.level === 'critical' ? 'crit' : d.level}
              />
            ) : (
              <Meter key={d.path} label={`Disk ${d.path.replace(/[\\/]+$/, '')}`} pct={0} value="offline" lvl="crit" />
            ),
          )
        : sys.diskTotalBytes !== undefined &&
          sys.diskFreeBytes !== undefined && <Meter label="Disk" pct={((sys.diskTotalBytes - sys.diskFreeBytes) / sys.diskTotalBytes) * 100} value={`${fmtBytes(sys.diskFreeBytes)} free`} warn={85} crit={95} />}
      <div className="limits">
        <span className={unityOn >= sys.limits.maxUnity ? 'at-limit' : ''}>
          Unity editors <b>{unityOn}/{sys.limits.maxUnity}</b>
        </span>
        <span className={agentsOn >= sys.limits.maxSessions ? 'at-limit' : ''}>
          Agents <b>{agentsOn}/{sys.limits.maxSessions}</b>
        </span>
      </div>
    </div>
  );
}

/** The user's Claude plan limits (server/usage.ts): weekly first, then the 5-hour session and per-model weekly windows. */
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
        {u.why && <div className="plan-asof">{u.why}</div>}
        {u.spendWeekUsd !== undefined && (
          <div className="meter-row" title="What FF Factory's own agents cost over the last 7 days, from their reported cost. This is spend, not the plan's usage limit.">
            <span className="meter-label">Portal spend, 7 days</span>
            <span className="meter-value">{fmtCost(u.spendWeekUsd)}</span>
          </div>
        )}
        <div className="plan-asof">{asOf}</div>
      </div>
    );
  }
  const rows = [u.weekly, u.session, ...u.models].filter((m): m is UsageMeter => !!m);
  return (
    <div className="meters plan-meters" title={`Claude ${u.plan ?? ''} plan usage limits, from the claude.ai usage endpoint`}>
      {rows.map((m) => (
        <Meter key={m.label} label={m.label} pct={m.percent} value={`${Math.round(m.percent)}%${m.resetsAt ? ` · ${resetLabel(m.resetsAt, now)}` : ''}`} />
      ))}
      <div className="plan-asof">
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

