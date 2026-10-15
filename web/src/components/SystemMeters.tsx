import { useState, type ReactNode } from 'react';
import type { AccountUsage, AppState, CleanupSummary, HostHealth, HostStats, PlanUsage, Provider, ProviderMetrics, SessionInfo, SystemStats, UnitySlotsReport, UsageMeter } from '../../../shared/types';
import { unitySlotsLine } from '../../../shared/fleet';
import { cpuPct, disksHint, memPct, metricsLine, metricsStale, rootDisk } from '../../../shared/providerMetrics';
import { memUsed as memUsedOf } from '../../../shared/stats';
import { fmtBytes, fmtClock, fmtCost, fmtRelative, lsGet, lsSet, useNow } from '../util';
import { Icon } from './ui';
import { api } from '../api';
import { attempt, sessionIndex } from '../store';

// The sidebar's footer: the load of every computer and the plan usage of every Claude account, in two
// quiet lines; a tap opens the meters. With machines connected each computer is a name and three mini
// bars (CPU, RAM, GPU), so the footer stays the size it was with the host alone.

export type Lvl = 'ok' | 'warn' | 'crit';
export const level = (pct: number, warn = 75, crit = 90): Lvl => (pct >= crit ? 'crit' : pct >= warn ? 'warn' : 'ok');
const worse = (a: Lvl, b: Lvl): Lvl => (a === 'crit' || b === 'crit' ? 'crit' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');

/** One computer in the footer: the host (always first) or a machine, with its numbers when it has any. */
export interface Computer {
  name: string;
  stats?: HostStats & { unity?: UnitySlotsReport };
  online: boolean;
  host?: boolean;
  /** Its last clean-up pass (server/cleanup.ts). */
  cleanup?: CleanupSummary;
}

export function computersOf(app: AppState): Computer[] {
  const host: Computer[] = app.system ? [{ name: shortHost(app.system.hostname), stats: app.system, online: true, host: true, cleanup: app.host?.health?.lastCleanup }] : [];
  // The host's own daemon (docs/beast-machine.md) is this same computer: the host's line stands for it.
  return [...host, ...app.machines.filter((m) => !m.local).map((m) => ({ name: m.id, stats: app.machineStats?.[m.id], online: m.online, cleanup: m.lastCleanup }))];
}

const shortHost = (h: string) => h.replace(/\.(local|lan|home)$/i, '');

/**
 * A provider (FFBox) among the computers: what its connector last pushed (shared/providerMetrics.ts), and a marker
 * once that is stale (two minutes without an update) or the connector is gone. Its last numbers stay, dimmed.
 */
export interface ProviderLoad {
  p: Provider;
  m?: ProviderMetrics;
  /** load1 over the logical cores: above 100% when more is runnable than it has cores. */
  cpu?: number;
  ram?: number;
  marker?: string;
  title: string;
}

export function providerLoad(p: Provider, now: number): ProviderLoad {
  const m = p.metrics;
  const marker = !m ? undefined : !p.online ? `offline · seen ${fmtRelative(p.lastSeen ?? m.receivedAt, now)}` : metricsStale(m, now) ? `stale · updated ${fmtRelative(m.receivedAt, now)}` : undefined;
  return { p, m, cpu: m && cpuPct(m), ram: m && memPct(m), marker, title: `${p.name} (provider, CPU-only)\n${metricsLine(m, now)}${marker ? `\n${marker}` : ''}` };
}

export const ramPct = (s: HostStats) => (memUsedOf(s) / s.memTotalBytes) * 100;
/** RAM's level: its share, raised by the Mac's own memory pressure (the better signal where RAM is also the GPU's). */
export const ramLvl = (s: HostStats) => worse(level(ramPct(s), 85, 95), s.memPressure === 'critical' ? 'crit' : s.memPressure === 'warn' ? 'warn' : 'ok');
/** A discrete GPU: its VRAM in use. Apple Silicon shares RAM, so how busy it is says more. */
export const gpuPct = (s: HostStats) => (!s.gpu ? undefined : s.gpu.unified ? s.gpu.utilPct : (s.gpu.memUsedMiB / s.gpu.memTotalMiB) * 100);

export function describe(c: Computer): string {
  const s = c.stats;
  if (!s) return c.online ? `${c.name}: online, no numbers yet` : `${c.name}: offline`;
  const gpu = !s.gpu
    ? 'GPU n/a'
    : s.gpu.unified
      ? `GPU ${Math.round(s.gpu.utilPct)}% busy (${(s.gpu.memUsedMiB / 1024).toFixed(1)} GB of the shared RAM)`
      : `VRAM ${Math.round(gpuPct(s)!)}% (${(s.gpu.memUsedMiB / 1024).toFixed(1)} of ${(s.gpu.memTotalMiB / 1024).toFixed(0)} GB), GPU ${Math.round(s.gpu.utilPct)}%`;
  return [
    `${c.name} · ${s.cpuModel} x${s.cpuCount}`,
    `CPU ${Math.round(s.loadPct)}%`,
    `RAM ${Math.round(ramPct(s))}% (${fmtBytes(memUsedOf(s))} of ${fmtBytes(s.memTotalBytes)})${s.memPressure ? `, pressure ${s.memPressure}` : ''}`,
    gpu,
    s.diskFreeBytes !== undefined ? `Disk ${fmtBytes(s.diskFreeBytes)} free` : '',
    // Its Unity editors and game players, each player with its owner and age; an orphan says so (w1196).
    s.unity ? `Unity ${unitySlotsLine(s.unity)}` : '',
    c.cleanup ? `Last clean-up ${fmtClock(c.cleanup.at)}: ${fmtBytes(c.cleanup.freedBytes ?? 0)} freed (${c.cleanup.removed} item(s))${c.cleanup.listed?.length ? `, ${c.cleanup.listed.length} stale-looking item(s) kept for a person` : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------- accounts

/** The account a session runs on, where the server knows it and there is more than one to tell apart. */
export const accountOf = (app: AppState, sessionId: string) => (app.accounts && app.accounts.length > 1 ? app.accounts.find((a) => a.sessionIds.includes(sessionId)) : undefined);

/** A few characters that tell accounts apart: "…9AAA", or a login's name before the @. */
export function accountTag(a: AccountUsage): string {
  if (a.kind === 'token') return a.label.slice(a.label.indexOf('…'));
  return (a.email ?? a.label).split('@')[0].slice(0, 10);
}

/**
 * Where an account stands now: spent until a reset (its weekly or 5-hour window is full and not yet reset), and whether
 * agents run on it this minute. A window whose reset time passed is not spent.
 */
export function accountState(a: AccountUsage, now: number, live = 0): { spentUntil?: string; inUse: boolean } {
  const u = a.usage?.available ? a.usage : undefined;
  const full = [u?.weekly, u?.session].filter((m): m is UsageMeter => !!m && m.percent >= 99.5 && !(m.resetsAt && Date.parse(m.resetsAt) <= now));
  const until = full.map((m) => m.resetsAt).filter((t): t is string => !!t).sort((x, y) => Date.parse(y) - Date.parse(x))[0];
  return { spentUntil: full.length ? (until ?? '') : undefined, inUse: live > 0 };
}

const isLive = (s: SessionInfo | undefined) => !!s && s.status !== 'stopped' && s.status !== 'error';

/** The plan cell: the account closest to its weekly limit, with its hottest other window, and how many more there are. */
function planGlance(app: AppState): { weekly?: UsageMeter; hot?: UsageMeter; tag?: string; more: number; title: string } {
  const accounts = app.accounts;
  if (!accounts) {
    const u = app.usage;
    return { weekly: u?.available ? u.weekly : undefined, hot: hottest(u), more: 0, title: 'Claude plan usage' };
  }
  const known = accounts.filter((a) => a.usage?.available && a.usage.weekly);
  const top = known.sort((a, b) => b.usage!.weekly!.percent - a.usage!.weekly!.percent)[0];
  const title = accounts.map((a) => `${a.label}: ${a.usage?.available && a.usage.weekly ? `weekly ${Math.round(a.usage.weekly.percent)}%` : 'unknown'}`).join('\n');
  return { weekly: top?.usage?.weekly, hot: hottest(top?.usage), tag: accounts.length > 1 && top ? accountTag(top) : undefined, more: Math.max(0, accounts.length - 1), title };
}

function hottest(u: PlanUsage | undefined): UsageMeter | undefined {
  if (!u?.available) return undefined;
  return [u.session, ...u.models].filter((m): m is UsageMeter => !!m && m.percent >= 75).sort((a, b) => b.percent - a.percent)[0];
}

// ---------------------------------------------------------------- the footer

export function SystemFooter({ app }: { app: AppState }) {
  const [open, setOpen] = useState(() => lsGet('ffsb.meters') === '1');
  const now = useNow(15_000);
  const sys = app.system;
  if (!sys) return null;
  const toggle = () => {
    setOpen(!open);
    lsSet('ffsb.meters', open ? null : '1');
  };
  const computers = computersOf(app);
  const providers = (app.providers ?? []).map((p) => providerLoad(p, now));
  const many = computers.length + providers.length > 1;
  const plan = planGlance(app);
  const sessionsById = sessionIndex(app.sessions);
  const short = (label: string) => label.replace(/^Weekly\s+/i, '').replace(/^Session \(5 h\)$/i, '5h');
  const Val = ({ pct, children, warn, crit, lvl }: { pct: number; children: ReactNode; warn?: number; crit?: number; lvl?: Lvl }) => <b className={`lvl-${lvl ?? level(pct, warn, crit)}`}>{children}</b>;
  const vram = gpuPct(sys);
  const hasPlan = !!app.usage || !!app.accounts?.length;
  return (
    <div className={`sys-foot${open ? ' open' : ''}${many ? ' many' : ''}`}>
      {open && (
        <div className="sys-sheet-head" data-testid="sys-sheet-head">
          <span className="sys-sheet-title">Computers &amp; Claude usage</span>
          <button className="sys-close" onClick={toggle} aria-label="Close the meters" title="Close the meters">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {open && (
        <div className="sys-detail">
          {many ? (
            <MachineTable computers={computers} providers={providers} health={app.host?.health} />
          ) : (
            <Meters sys={sys} health={app.host?.health} belowSoft={computers[0]?.cleanup?.belowSoft} />
          )}
          {hasPlan && <UsageRefresh />}
          {app.accounts ? <AccountsMeters app={app} /> : app.usage && <PlanMeters usage={app.usage} />}
        </div>
      )}
      <button className="sys-toggle" onClick={toggle} aria-expanded={open} title={many ? 'Every computer and Claude account. Tap for the meters.' : `${sys.cpuModel} · ${sys.cpuCount} threads. Tap for the meters.`}>
        <span className="sys-cells">
            {many && computers.map((c) => <MiniBars key={c.name} c={c} />)}
            {many && providers.map((l) => <ProviderMiniBars key={l.p.id} l={l} />)}
            {!many && (
              <>
                <span>
                  CPU <Val pct={sys.loadPct}>{Math.round(sys.loadPct)}%</Val>
                </span>
                <span>
                  RAM <Val pct={ramPct(sys)} lvl={ramLvl(sys)}>{Math.round(ramPct(sys))}%</Val>
                </span>
                {vram !== undefined && (
                  <span>
                    {sys.gpu?.unified ? 'GPU' : 'VRAM'} <Val pct={vram}>{Math.round(vram)}%</Val>
                  </span>
                )}
              </>
            )}
            {hasPlan && app.accounts && app.accounts.length > 1 && (
              <span className="plan-chips" data-testid="plan-glance" title={plan.title}>
                Plan
                {app.accounts.map((a) => (
                  <PlanChip key={a.id} a={a} now={now} live={a.sessionIds.filter((id) => isLive(sessionsById.get(id))).length} />
                ))}
              </span>
            )}
            {hasPlan && !(app.accounts && app.accounts.length > 1) && (
              <span title={plan.title} data-testid="plan-glance">
                Plan{' '}
                {plan.weekly ? (
                  <>
                    <Val pct={plan.weekly.percent}>{Math.round(plan.weekly.percent)}%</Val>
                    {plan.tag && <span className="plan-tag"> {plan.tag}</span>}
                    {plan.hot && (
                      <>
                        {' · '}
                        {short(plan.hot.label)} <Val pct={plan.hot.percent}>{Math.round(plan.hot.percent)}%</Val>
                      </>
                    )}
                    {plan.more > 0 && <span className="plan-more"> +{plan.more}</span>}
                  </>
                ) : (
                  <b className="lvl-warn">?</b>
                )}
              </span>
            )}
        </span>
        <Icon name="chevron" size={12} />
      </button>
    </div>
  );
}

/**
 * A Claude account in the collapsed footer, drawn like a computer's cell: its tag, two bars (5-hour session, weekly) and
 * the weekly share, or, once spent, when it is back. A dot marks the ones agents run on now; a spent one is dimmed.
 */
function PlanChip({ a, now, live }: { a: AccountUsage; now: number; live: number }) {
  const u = a.usage?.available ? a.usage : undefined;
  const st = accountState(a, now, live);
  const bars: [string, UsageMeter | undefined][] = [
    ['5-hour session', u?.session],
    ['weekly', u?.weekly],
  ];
  const w = u?.weekly;
  const spent = st.spentUntil !== undefined;
  const title = [
    a.label,
    ...bars.map(([name, m]) => `${name}: ${m ? `${Math.round(m.percent)}%${m.resetsAt ? `, resets ${localTime(m.resetsAt, now)}` : ''}` : 'unknown'}`),
    ...u?.models.map((m) => `${m.label}: ${Math.round(m.percent)}%`) ?? [],
    spent ? `Spent${st.spentUntil ? ` until ${localTime(st.spentUntil, now)}` : ''}` : st.inUse ? `In use now (${live} agent${live === 1 ? '' : 's'})` : 'Free',
  ].join('\n');
  return (
    <span className={`plan-chip${spent ? ' plan-spent' : ''}${st.inUse ? ' plan-live' : ''}`} title={title} aria-label={title.replace(/\n/g, ', ')} data-testid={`plan-${accountTag(a)}`}>
      <span className="mname">{st.inUse && <span className="plan-dot">● </span>}{accountTag(a)}</span>
      <span className="mbars" aria-hidden>
        {bars.map(([name, m]) => (
          <span key={name} className={`mbar lvl-bg-${m ? level(m.percent) : 'none'}`}>
            <i style={{ height: `${m ? Math.max(8, Math.min(100, m.percent)) : 0}%` }} />
          </span>
        ))}
      </span>
      {spent ? (
        <b className="lvl-crit">{st.spentUntil ? `back ${localTime(st.spentUntil, now)}` : 'spent'}</b>
      ) : w ? (
        <b className={`lvl-${level(w.percent)}`}>{Math.round(w.percent)}%</b>
      ) : (
        <b className="lvl-warn">?</b>
      )}
    </span>
  );
}

/** A computer in the collapsed footer: its name and three bars (CPU, RAM, GPU); hover for the numbers. */
function MiniBars({ c }: { c: Computer }) {
  const s = c.stats;
  const bars: [string, number | undefined, Lvl | undefined][] = s
    ? [
        ['CPU', s.loadPct, undefined],
        ['RAM', ramPct(s), ramLvl(s)],
        [s.gpu?.unified ? 'GPU' : 'VRAM', gpuPct(s), undefined],
      ]
    : [];
  const text = describe(c);
  return (
    <span className={`mcell${s ? '' : ' mcell-off'}`} title={text} aria-label={text.replace(/\n/g, ', ')} data-testid={`mcell-${c.name}`}>
      <span className="mname">{c.name}</span>
      {s ? (
        <span className="mbars" aria-hidden>
          {bars.map(([label, pct, lvl]) => (
            <span key={label} className={`mbar lvl-bg-${pct === undefined ? 'none' : (lvl ?? level(pct))}`}>
              <i style={{ height: `${Math.max(pct === undefined ? 0 : 8, Math.min(100, pct ?? 0))}%` }} />
            </span>
          ))}
        </span>
      ) : (
        <span className="moff">{c.online ? '…' : 'off'}</span>
      )}
    </span>
  );
}

/**
 * A provider in the collapsed footer, drawn like a computer: CPU (the bar full at 100%; the hover says the real
 * share), RAM, and an empty GPU bar (FFBox is CPU-only). Dimmed once stale or offline.
 */
function ProviderMiniBars({ l }: { l: ProviderLoad }) {
  const { p, m, cpu, ram } = l;
  const bars: [string, number | undefined, Lvl][] = [
    ['CPU', cpu, level(cpu ?? 0)],
    ['RAM', ram, level(ram ?? 0, 85, 95)],
    ['GPU', undefined, 'ok'],
  ];
  return (
    <span className={`mcell${m ? '' : ' mcell-off'}${l.marker ? ' mcell-stale' : ''}`} title={l.title} aria-label={l.title.replace(/\n/g, ', ')} data-testid={`mcell-${p.name}`}>
      <span className="mname">{p.name}</span>
      {m ? (
        <span className="mbars" aria-hidden>
          {bars.map(([label, pct, lvl]) => (
            <span key={label} className={`mbar lvl-bg-${pct === undefined ? 'none' : lvl}`}>
              <i style={{ height: `${Math.max(pct === undefined ? 0 : 8, Math.min(100, pct ?? 0))}%` }} />
            </span>
          ))}
        </span>
      ) : (
        <span className="moff">{p.online ? '…' : 'off'}</span>
      )}
    </span>
  );
}

function Meter({ label, pct, value, note, warn = 75, crit = 90, lvl }: { label: string; pct: number; value: string; note?: string; warn?: number; crit?: number; lvl?: Lvl }) {
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
      {note && <div className="meter-note">{note}</div>}
    </div>
  );
}

/** The host alone (no machines): its meters, as before. */
function Meters({ sys, health, belowSoft }: { sys: SystemStats; health?: HostHealth; belowSoft?: boolean }) {
  const memUsed = memUsedOf(sys);
  return (
    <div className="meters">
      <Meter label="CPU" pct={sys.loadPct} value={`${Math.round(sys.loadPct)}%`} />
      <Meter label="RAM" pct={(memUsed / sys.memTotalBytes) * 100} value={`${fmtBytes(memUsed)} of ${fmtBytes(sys.memTotalBytes)}`} lvl={ramLvl(sys)} />
      {sys.gpu && (
        <Meter
          label={sys.gpu.unified ? 'GPU' : 'VRAM'}
          pct={gpuPct(sys)!}
          value={
            sys.gpu.unified
              ? `${Math.round(sys.gpu.utilPct)}% busy · ${(sys.gpu.memUsedMiB / 1024).toFixed(1)} GB shared`
              : `${(sys.gpu.memUsedMiB / 1024).toFixed(1)} of ${(sys.gpu.memTotalMiB / 1024).toFixed(0)} GB · GPU ${Math.round(sys.gpu.utilPct)}%`
          }
        />
      )}
      <HostDisks sys={sys} health={health} belowSoft={belowSoft} />
    </div>
  );
}

/** A disk still under the clean-up's soft free-space threshold after its last pass is at least a warning (it was the orange clean-up line). */
const lowLvl = (belowSoft?: boolean): Lvl => (belowSoft ? 'warn' : 'ok');

function HostDisks({ sys, health, belowSoft }: { sys: HostStats; health?: HostHealth; belowSoft?: boolean }) {
  if (health?.disks.length) {
    // The host guard's volumes, coloured by its own levels (hostGuard.warnFreeGB / criticalFreeGB).
    return (
      <>
        {health.disks.map((d) =>
          d.totalBytes !== undefined && d.freeBytes !== undefined ? (
            <Meter
              key={d.path}
              label={`Disk ${d.path.replace(/[\\/]+$/, '')}`}
              pct={((d.totalBytes - d.freeBytes) / d.totalBytes) * 100}
              value={`${fmtBytes(d.freeBytes)} free`}
              lvl={worse(d.level === 'critical' ? 'crit' : d.level, lowLvl(belowSoft))}
            />
          ) : (
            <Meter key={d.path} label={`Disk ${d.path.replace(/[\\/]+$/, '')}`} pct={0} value="offline" lvl="crit" />
          ),
        )}
      </>
    );
  }
  if (sys.diskTotalBytes === undefined || sys.diskFreeBytes === undefined) return null;
  const used = ((sys.diskTotalBytes - sys.diskFreeBytes) / sys.diskTotalBytes) * 100;
  return <Meter label="Disk" pct={used} value={`${fmtBytes(sys.diskFreeBytes)} free`} lvl={worse(level(used, 85, 95), lowLvl(belowSoft))} />;
}

/** Every computer, one compact row each: a bar and a number per resource. */
function MachineTable({ computers, providers = [], health }: { computers: Computer[]; providers?: ProviderLoad[]; health?: HostHealth }) {
  const Cell = ({ pct, text, lvl, title }: { pct?: number; text: string; lvl?: Lvl; title?: string }) => (
    <span className={`mt-cell meter-${pct === undefined ? 'ok' : (lvl ?? level(pct))}`} title={title}>
      <span className="mt-num">{text}</span>
      <span className="meter-bar">
        <i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
      </span>
    </span>
  );
  return (
    <div className="meters mtable" role="table" aria-label="Load of every computer">
      <div className="mt-row mt-head" role="row">
        <span />
        <span>CPU</span>
        <span>RAM</span>
        <span>GPU</span>
        <span>Disk</span>
      </div>
      {computers.map((c) => {
        const s = c.stats;
        if (!s)
          return (
            <div key={c.name} className="mt-row mt-off" role="row">
              <span className="mt-name">{c.name}</span>
              <span className="mt-note">{c.online ? 'online, no numbers yet' : 'offline'}</span>
            </div>
          );
        const g = gpuPct(s);
        // The host's disks are the guard's volumes where it has them: the fullest one stands for them all.
        const low = lowLvl(c.cleanup?.belowSoft);
        const disks = c.host && health?.disks.length ? health.disks.filter((d) => d.totalBytes && d.freeBytes !== undefined) : [];
        const disk = disks.length
          ? disks.map((d) => ({ used: ((d.totalBytes! - d.freeBytes!) / d.totalBytes!) * 100, free: d.freeBytes!, lvl: (d.level === 'critical' ? 'crit' : d.level) as Lvl })).sort((a, b) => b.used - a.used)[0]
          : s.diskTotalBytes && s.diskFreeBytes !== undefined
            ? { used: ((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, free: s.diskFreeBytes, lvl: level(((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, 85, 95) }
            : undefined;
        return (
          <div key={c.name} className="mt-row" role="row" data-testid={`mrow-${c.name}`} title={describe(c)}>
            <span className="mt-name">{c.name}</span>
            <Cell pct={s.loadPct} text={`${Math.round(s.loadPct)}%`} />
            <Cell pct={ramPct(s)} lvl={ramLvl(s)} text={`${Math.round(ramPct(s))}%`} title={`${fmtBytes(memUsedOf(s))} of ${fmtBytes(s.memTotalBytes)}${s.memPressure ? `, pressure ${s.memPressure}` : ''}`} />
            {g === undefined ? <span className="mt-note">n/a</span> : <Cell pct={g} text={`${Math.round(g)}%`} title={s.gpu?.unified ? 'GPU busy (Apple Silicon shares the RAM)' : 'VRAM in use'} />}
            {disk ? <Cell pct={disk.used} lvl={worse(disk.lvl, low)} text={fmtBytes(disk.free)} title={`${fmtBytes(disk.free)} free${c.cleanup?.belowSoft ? `, below the clean-up's soft threshold of ${c.cleanup.softFreeGB} GB after its last pass` : ''}`} /> : <span className="mt-note">n/a</span>}
          </div>
        );
      })}
      {providers.map((l) => {
        const { p, m, cpu, ram } = l;
        if (!m)
          return (
            <div key={p.id} className="mt-row mt-off" role="row" data-testid={`mrow-${p.name}`} title={l.title}>
              <span className="mt-name">{p.name}</span>
              <span className="mt-note">{p.online ? 'no metrics from its connector' : 'offline'}</span>
            </div>
          );
        // One disk, the root filesystem; the others are in its hover.
        const disk = rootDisk(m);
        const used = disk && ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100;
        return (
          <div key={p.id} className={`mt-provider${l.marker ? ' mt-stale' : ''}`} data-testid={`mrows-${p.name}`}>
            <div className="mt-row" role="row" data-testid={`mrow-${p.name}`} title={l.title}>
              <span className="mt-name">{p.name}</span>
              {cpu !== undefined ? <Cell pct={cpu} text={`${Math.round(cpu)}%`} title={m.cpu ? `load ${m.cpu.load1} on ${m.cpu.cores} cores` : undefined} /> : <span className="mt-note">n/a</span>}
              {ram !== undefined && m.mem ? <Cell pct={ram} lvl={level(ram, 85, 95)} text={`${Math.round(ram)}%`} title={`${fmtBytes(m.mem.usedBytes)} of ${fmtBytes(m.mem.totalBytes)}`} /> : <span className="mt-note">n/a</span>}
              <span className="mt-note" title="CPU-only">
                none
              </span>
              {disk ? <Cell pct={used} lvl={level(used!, 85, 95)} text={fmtBytes(disk.freeBytes)} title={`${fmtBytes(disk.freeBytes)} free of ${fmtBytes(disk.totalBytes)}
${disksHint(m)}`} /> : <span className="mt-note">n/a</span>}
            </div>
            {l.marker && (
              <div className="mt-row mt-sub" role="row" data-testid="provider-load-stale">
                <span />
                <span className="mt-note mt-marker">{l.marker}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Poll every Claude account's usage now (they are polled every config usagePollMinutes, default 15): here and on each
 * connected machine. The numbers arrive by themselves; each account's "as of" says when.
 */
function UsageRefresh() {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    await attempt(api.refreshUsage());
    // A poll takes a few seconds (a minute at most); the button stays quiet meanwhile.
    setTimeout(() => setBusy(false), 5_000);
  };
  return (
    <div className="plan-refresh">
      <span className="plan-refresh-title">Plan usage</span>
      <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy} title="Ask every Claude account for its usage now, here and on each machine" data-testid="usage-refresh">
        <Icon name="refresh" size={12} /> {busy ? 'Refreshing…' : 'Refresh usage'}
      </button>
    </div>
  );
}

/** Every Claude account in use: who it is, where it is used, which agents run on it, its limits. */
function AccountsMeters({ app }: { app: AppState }) {
  const sessions = sessionIndex(app.sessions);
  const now = useNow(60_000);
  return (
    <>
      {app.accounts!.map((a) => {
        const live = a.sessionIds.map((id) => sessions.get(id)).filter(isLive);
        const st = accountState(a, now, live.length);
        return (
          <PlanMeters
            key={a.id}
            usage={a.usage}
            head={
              <div className="acct-head" data-testid={`account-${accountTag(a)}`}>
                <span className="acct-label">{a.label}</span>
                <span className="acct-agents">{live.length === 1 ? '1 agent' : `${live.length} agents`}</span>
                {st.spentUntil !== undefined ? (
                  <span className="acct-state lvl-crit" data-testid="account-state">{st.spentUntil ? `spent until ${localTime(st.spentUntil, now)}` : 'spent'}</span>
                ) : (
                  st.inUse && <span className="acct-state" data-testid="account-state">in use now</span>
                )}
                {a.where.length > 0 && <div className="acct-where">{a.where.join(' · ')}</div>}
                {a.pool && (
                  <div className="acct-where" title={`${a.pool.person}'s Claude token pool: priority marks the token a new job gets now`} data-testid="account-pool">
                    {a.pool.text}
                  </div>
                )}
              </div>
            }
          />
        );
      })}
    </>
  );
}

/** One account's plan limits (server/usage.ts): weekly first, then the 5-hour session and per-model weekly windows. */
function PlanMeters({ usage: u, head }: { usage?: PlanUsage; head?: ReactNode }) {
  const now = useNow(60_000);
  if (!u) {
    return (
      <div className="meters plan-meters">
        {head}
        <div className="plan-asof">not fetched yet</div>
      </div>
    );
  }
  const asOf = `as of ${fmtClock(u.asOf)}${u.reading ? ` (${u.reading.kind} reading: ${u.reading.why})` : u.error ? ' (refresh failed)' : ''}`;
  if (!u.available) {
    return (
      <div className="meters plan-meters" title={u.why}>
        {head}
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
  // Session first, then weekly, then each model's weekly window, two to a row (a phone's width holds two).
  const rows = [u.session, u.weekly, ...u.models].filter((m): m is UsageMeter => !!m);
  return (
    <div className="meters plan-meters" title={`Claude ${u.plan ?? ''} plan usage limits, from ${u.source ? `the API's ${u.source}` : 'the claude.ai usage endpoint'}`}>
      {head}
      <div className="plan-grid">
        {rows.map((m) => (
          <Meter key={m.label} label={m.label.replace(/^Session \(5 h\)$/i, 'Session 5h')} pct={m.percent} value={`${Math.round(m.percent)}%`} note={m.resetsAt ? (Date.parse(m.resetsAt) <= now ? 'resetting' : `resets ${localTime(m.resetsAt, now)}`) : undefined} />
        ))}
      </div>
      <div className="plan-asof">
        Claude {u.plan ?? 'plan'} · {asOf}
        {u.source ? ` · from ${u.source}` : ''}
      </div>
    </div>
  );
}

/** A time in the viewer's own zone: "3:40 PM" today, "Thu 9:00 AM" on another day. */
export function localTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const d = new Date(t);
  const time = fmtClock(iso);
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
