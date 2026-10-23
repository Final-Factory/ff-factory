// Every computer and what it is working on (shared/fleet.ts), drawn twice: as collapsible groups in the
// sidebar, and as one card per computer on the Overview board. A group is its header (name, online, load,
// sandbox and editor counts) and its sandboxes with their live agents (every worker runs in one, w536).
import { useState, type ReactNode } from 'react';
import type { AppState, HostHealth, Provider, SessionInfo, UserInfo } from '../../../shared/types';
import { cpuPct, disksHint, memPct, metricsLine, metricsStale, rootDisk } from '../../../shared/providerMetrics';
import { capacityLine, fleetOf, slotCall, type FleetComputer, type FleetSandbox, type PersonWait, type PlaceAgents, type SlotCall } from '../../../shared/fleet';
import { useAttention } from '../attention';
import { sessionIndex } from '../store';
import { agentView, fmtBytes, fmtRelative, lsGet, lsSet, machineSandboxGlance, navigate, pauseGlance, unityLabel, unityTone, useNow, type Glance, type Route, type Tone } from '../util';
import { AttentionButton, DrawerButton } from './ShellButtons';
import { describe, gpuPct, level, ramLvl, ramPct, type Lvl } from './SystemMeters';
import { Dot, Icon } from './ui';
import { useKeepScroll } from '../scrollKeep';
import { OVERVIEW_MODE_KEY, readMode, writeMode, type OverviewMode } from '../../../shared/workerCards';
import { WorkerBoard } from './WorkerCards';

type Variant = 'side' | 'board';

/** Where the user is, so the sidebar can mark it. */
export interface FleetSelection {
  sandbox?: string;
  sessionId?: string;
}

const osName = (p: string | undefined) => (!p ? '' : p.startsWith('win') ? 'Windows' : p.startsWith('darwin') ? 'Mac' : p.split(' ')[0]);

const ago = (iso: string, now: number) => fmtRelative(iso, now).replace(' ago', '').replace('just now', 'now');

/**
 * An agent in a few words: needs you (a permission), busy, starting, between turns (w475: working on a check-in or a task, or
 * queued or blocked, w643), waiting on a person (w1430; w1521: "asked you" when that is the viewer, "waits on Ben" otherwise,
 * in grey: it is answered in the orchestrator chat, not here), or idle.
 */
function agentState(s: SessionInfo, wait?: PersonWait, me?: Pick<UserInfo, 'displayName'>): { word: string; tone: Tone; detail?: string } {
  if (s.pendingPermissions.length || s.status === 'waiting_permission') return { word: 'needs you', tone: 'amber' };
  // No agent host started for it (w691): blocked on its machine, whatever its status says.
  if (s.hostFailure) return { word: 'blocked', tone: 'violet', detail: agentView(s).waitsOn };
  if (s.status === 'running') return { word: 'busy', tone: 'blue' };
  if (s.status === 'starting') return { word: 'starting', tone: 'blue' };
  if (wait) {
    const mine = !!me && wait.on.some((n) => n.toLowerCase() === me.displayName.toLowerCase());
    return { word: mine ? 'asked you' : `waits on ${wait.on.join(', ') || 'a person'}`, tone: 'grey', detail: s.waitingOn?.what };
  }
  const v = agentView(s);
  if (v.waitsOn) return { word: v.label.toLowerCase(), tone: v.tone, detail: v.waitsOn };
  // Stopped, but its check-in or a queued message will resume it (w509): listed as Stopped.
  if (s.status === 'stopped') return { word: 'stopped', tone: 'grey', detail: v.text.replace(/^Stopped \(|\)$/g, '') };
  return { word: 'idle', tone: 'grey' };
}

/** The tooltip's second line: the live agents by name. */
const agentsHint = (a: PlaceAgents) => (a.live.length ? `\nAgents: ${a.live.map((s) => s.title).join(', ')}` : '');

const sandboxRoute = (sb: FleetSandbox, sessionId?: string): Route => ({ view: 'msandbox', machineId: sb.machineId!, sandboxId: sb.id, sessionId });

// ---------------------------------------------------------------- collapsed groups (per viewer)

const COLLAPSED = 'ffsb.fleet.collapsed';

function useCollapsed(): [Set<string>, (key: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(lsGet(COLLAPSED) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSet(next);
    lsSet(COLLAPSED, next.size ? JSON.stringify([...next]) : null);
  };
  return [set, toggle];
}

// ---------------------------------------------------------------- the pieces

/** CPU, RAM, GPU and disk in one line: a small bar and a number each; hover for the full numbers. */
function Meters({ c, health, now }: { c: FleetComputer; health?: HostHealth; now: number }) {
  const s = c.stats;
  if (!s) {
    const m = c.machine;
    const text = !c.online ? `offline${m?.lastSeen ? ` · seen ${fmtRelative(m.lastSeen, now)}` : ''}` : 'no numbers yet';
    return <span className="fl-meters fl-meters-off">{text}</span>;
  }
  // The host's disks are its guard's volumes where it has them: the fullest one stands for them all.
  const guarded = c.host && health?.disks.length ? health.disks.filter((d) => d.totalBytes && d.freeBytes !== undefined) : [];
  const disk = guarded.length
    ? guarded.map((d) => ({ used: ((d.totalBytes! - d.freeBytes!) / d.totalBytes!) * 100, free: d.freeBytes!, lvl: (d.level === 'critical' ? 'crit' : d.level) as Lvl })).sort((a, b) => b.used - a.used)[0]
    : s.diskTotalBytes && s.diskFreeBytes !== undefined
      ? { used: ((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, free: s.diskFreeBytes, lvl: level(((s.diskTotalBytes - s.diskFreeBytes) / s.diskTotalBytes) * 100, 85, 95) }
      : undefined;
  const g = gpuPct(s);
  const orphans = s.unity?.playerList?.filter((p) => p.owner === 'orphan' || p.owner === 'stopped').length ?? 0;
  const cells: { label: string; pct?: number; text: string; lvl: Lvl }[] = [
    { label: 'CPU', pct: s.loadPct, text: `${Math.round(s.loadPct)}%`, lvl: level(s.loadPct) },
    { label: 'RAM', pct: ramPct(s), text: `${Math.round(ramPct(s))}%`, lvl: ramLvl(s) },
    // "GPU" either way (VRAM in use on a discrete card, how busy it is on Apple Silicon); the hover says which.
    ...(g !== undefined ? [{ label: 'GPU', pct: g, text: `${Math.round(g)}%`, lvl: level(g) }] : []),
    // "1.1T" free: the unit's letter only, so the four fit the sidebar on any font.
    ...(disk ? [{ label: 'Disk', pct: disk.used, text: fmtBytes(disk.free).replace(/ ([KMGT])B$/, '$1'), lvl: disk.lvl }] : []),
  ];
  return (
    <span className="fl-meters" title={describe({ name: c.name, stats: s, online: c.online, host: c.host })}>
      {cells.map((m) => (
        <span key={m.label} className="fl-meter" data-testid={`meter-${m.label}`}>
          <span className={`mbar lvl-bg-${m.lvl}`} aria-hidden>
            <i style={{ height: `${Math.max(8, Math.min(100, m.pct ?? 0))}%` }} />
          </span>
          {m.label} <b className={`lvl-${m.lvl}`}>{m.text}</b>
        </span>
      ))}
      {/* Game players nobody owns (w1196): the daemon ends them; until it has, they show here. The hover lists each. */}
      {orphans > 0 && (
        <span className="fl-meter lvl-warn" data-testid="orphan-players">
          {orphans} leftover player{orphans === 1 ? '' : 's'}
        </span>
      )}
    </span>
  );
}

/** A computer's name, state, load and counts. */
function Head({ c, health, now, fold }: { c: FleetComputer; health?: HostHealth; now: number; fold?: boolean }) {
  // The host with its own daemon (docs/beast-machine.md): its dot says whether that daemon, which runs its sandboxes, is up.
  const d = c.daemon;
  const tone: Tone = c.machine
    ? c.machine.status === 'deploying'
      ? 'blue'
      : c.machine.status === 'error'
        ? 'red'
        : c.online
          ? c.machine.pause?.paused
            ? 'amber'
            : 'green'
          : 'grey'
    : d && (!d.online || d.status === 'error')
      ? 'red'
      : d?.status === 'deploying'
        ? 'blue'
        : 'green';
  const state = c.machine?.status === 'deploying' ? 'setting up' : c.machine?.status === 'error' ? 'error' : c.online ? 'online' : 'offline';
  const daemonState = d ? (d.status === 'deploying' ? 'daemon setting up' : !d.online ? 'daemon offline' : d.status === 'error' ? 'daemon error' : '') : '';
  return (
    <>
      <span className="fl-title">
        <Dot tone={tone} pulse={tone === 'blue'} title={c.host ? daemonState || (d ? 'host and its daemon online' : 'host') : state} />
        <span className="fl-name">{c.name}</span>
        <span className="fl-os" data-testid="fl-os" title={c.machine?.pause?.paused ? c.machine.pause.detail : undefined}>
          {[osName(c.platform), c.host ? 'host' : state === 'online' ? '' : state, daemonState, c.online ? pauseGlance(c.machine) : ''].filter(Boolean).join(' · ')}
        </span>
        {c.live > 0 && (
          <span className="fl-agents-sum" data-testid="fl-agents-sum">
            {c.live} {c.live === 1 ? 'agent' : 'agents'}
            {c.busy ? `, ${c.busy} busy` : ''}
          </span>
        )}
        {c.attention > 0 && (
          <span className="badge badge-amber" title="Waiting on you">
            {c.attention}
          </span>
        )}
        {fold && <Icon name="chevron" size={12} />}
      </span>
      <Meters c={c} health={health} now={now} />
      <span className="fl-cap" data-testid="fl-capacity">
        {capacityLine(c)}
      </span>
    </>
  );
}

function AgentLine({ s, wait, me, now, active, variant, onOpen }: { s: SessionInfo; wait?: PersonWait; me?: UserInfo; now: number; active: boolean; variant: Variant; onOpen: () => void }) {
  const st = agentState(s, wait, me);
  return (
    <button
      className={`fl-agent${active ? ' active' : ''}`}
      onClick={onOpen}
      title={`${s.title}: ${st.word}${st.detail ? ` (${st.detail})` : ''}, last active ${fmtRelative(s.lastActivityAt, now)}${s.requestedBy ? ` · for ${s.requestedBy.displayName}` : ''}${s.model ? ` · ${s.model}` : ''}`}
      data-testid="fl-agent"
    >
      <Dot tone={st.tone} pulse={s.status === 'running'} />
      <span className="fl-agent-title">{s.title}</span>
      {variant === 'board' && s.requestedBy && <span className="fl-agent-for">{s.requestedBy.displayName}</span>}
      <span className={`fl-agent-state tone-${st.tone}`}>{st.word}</span>
      {variant === 'board' && st.detail && (
        <span className="fl-agent-why" data-testid="fl-agent-why">
          {st.detail}
        </span>
      )}
      <span className="fl-agent-age">{ago(s.lastActivityAt, now)}</span>
    </button>
  );
}

/**
 * A place's chats (w1430): those that matter now (shared/fleet.ts chatMatters), then "+N older" for the rest (finished, or on a
 * closed request), which opens them in place. The open chat is always listed.
 */
function Agents({ agents, me, now, sel, variant, open }: { agents: PlaceAgents; me?: UserInfo; now: number; sel: FleetSelection; variant: Variant; open: (s: SessionInfo) => void }) {
  const [unfolded, setUnfolded] = useState(false);
  if (!agents.shown.length && !agents.older.length) return null;
  const picked = agents.older.find((s) => s.id === sel.sessionId);
  const list = unfolded ? [...agents.shown, ...agents.older] : picked ? [...agents.shown, picked] : agents.shown;
  const folded = agents.older.length - (picked ? 1 : 0);
  const waitOf = (s: SessionInfo) => agents.waits.find((x) => x.session.id === s.id);
  return (
    <div className="fl-agents">
      {list.map((s) => (
        <AgentLine key={s.id} s={s} wait={waitOf(s)} me={me} now={now} active={sel.sessionId === s.id} variant={variant} onOpen={() => open(s)} />
      ))}
      {(unfolded ? agents.older.length > 0 : folded > 0) && (
        <button
          type="button"
          className="fl-stopped fl-older"
          onClick={() => setUnfolded(!unfolded)}
          aria-expanded={unfolded}
          title={unfolded ? 'Fold the older chats again' : 'Finished chats, and chats on closed requests: nothing is deleted'}
          data-testid="fl-older"
        >
          {unfolded ? `Hide ${agents.older.length} older` : `+${folded} older`}
        </button>
      )}
    </div>
  );
}

/**
 * The slot's call to the viewer (w1430): "Live view: go" opens the waiting worker's Live view. It is the first line under the
 * slot's row, on the row's text edge, so the row keeps its name, branch and Unity mark where they were. A question has no
 * button (w1521): it is answered in the orchestrator chat.
 */
function CallButton({ call, onGo }: { call: SlotCall; onGo: () => void }) {
  const what = call.session.waitingOn?.what;
  // w1599: a view up that waits on nobody here is the outlined chip of the board's free-slot line, not the amber pill.
  const quiet = call.kind === 'watch';
  return (
    <button
      type="button"
      className={quiet ? 'fl-chip fl-call fl-call-quiet' : 'needs-you fl-call'}
      onClick={onGo}
      title={
        quiet
          ? `${call.session.title}: its Live view is up, and you may watch it`
          : `${call.request ? `${call.request}: ` : ''}${call.session.title} waits on you${what ? `: ${what}` : ': its Live view is up for you to move the knobs'}`
      }
      data-testid="fl-call"
    >
      <span className="lv-rec" aria-hidden />
      {call.label}
    </button>
  );
}

/** A place row: the state dot, the label (with a FREE badge or the Unity mark), and a line under it. */
function PlaceHead({ glance: g, title, unused, free, unity, sub, active, hint, onClick, testId }: { glance: Glance; title: string; unused: boolean; free?: boolean; unity?: { tone: Tone; label: string }; sub: ReactNode; active: boolean; hint: string; onClick: () => void; testId: string }) {
  return (
    <button className={`row place fl-place${active ? ' active' : ''}${g.attention ? ' has-attn' : ''}`} onClick={onClick} title={`${title}\n${hint}`} aria-current={active ? 'page' : undefined} data-testid={testId}>
      <span className="row-icon">
        <Dot tone={g.tone} pulse={g.tone === 'blue'} />
      </span>
      <span className="row-main">
        <span className="fl-place-title">
          <span className={`row-title${unused ? ' is-unused' : ''}`}>{title}</span>
          {free && <span className="fl-free">FREE</span>}
          {unity && !free && (
            <span className={`fl-unity tone-${unity.tone}`} title={unity.label}>
              Unity
            </span>
          )}
        </span>
        <span className="row-sub">{sub}</span>
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

function SandboxItem({ sb, me, call, now, sel, variant, go }: { sb: FleetSandbox; me?: UserInfo; call?: SlotCall; now: number; sel: FleetSelection; variant: Variant; go: (r: Route) => void }) {
  const placeGlance = machineSandboxGlance(sb.machineSandbox!, sb.agents.live);
  // A worker here waits on you (w1430): the slot says "Asked you", quietly, with no badge (w1521: "Needs you" and its badge are a
  // permission's, which placeGlance already says), unless something more urgent (a permission, a blocked editor, a failure)
  // already speaks for it; what it is doing is that worker's title.
  const calls = call && call.kind !== 'watch'; // w1599: a view you may watch calls nobody
  const g: Glance = calls && placeGlance.tone !== 'red' && placeGlance.tone !== 'amber' ? { ...placeGlance, tone: 'grey', label: 'Asked you', progress: false } : placeGlance;
  const unityAbout = /^Unity/.test(g.label);
  const free = sb.free && !calls;
  // The label is the sandbox's name (w575); what it is doing is its live agents' titles, Working first.
  const title = sb.id;
  const titles = calls && !sb.doing.includes(call.session.title) ? [call.session.title, ...sb.doing] : sb.doing;
  const doing = titles.length ? `${titles[0]}${titles.length > 1 ? ` (+${titles.length - 1})` : ''}` : '';
  const head = (
    <PlaceHead
      glance={g}
      title={title}
      unused={free}
      free={free}
      unity={sb.status === 'ready' ? { tone: unityTone(sb.unity), label: unityLabel[sb.unity] } : undefined}
      sub={
        <>
          {!free && (
            <>
              <span className={`tone-${g.tone}`}>{g.label}</span>
              {doing && (
                <>
                  {' · '}
                  <span className="fl-doing" data-testid="fl-doing" title={titles.join('\n')}>
                    {doing}
                  </span>
                </>
              )}
              {' · '}
            </>
          )}
          <span className="mono fl-branch">{sb.branch}</span>
          {variant === 'board' && sb.status === 'ready' && !unityAbout && <span className={`tone-${unityTone(sb.unity)}`}> · {unityLabel[sb.unity]}</span>}
        </>
      }
      active={sel.sandbox === sb.key && !sel.sessionId}
      hint={`Slot ${sb.key} · ${sb.branch}${sb.status === 'ready' ? ` · ${unityLabel[sb.unity]}` : ''}${agentsHint(sb.agents)}${call?.kind === 'asked' ? `\nAsked you${call.session.waitingOn?.what ? `: ${call.session.waitingOn.what}` : ''} (answer it in your orchestrator chat)` : ''}${calls && sb.free ? '\nIts worker is stopped while it waits on you: placement may give the sandbox other work meanwhile' : ''}`}
      onClick={() => go(sandboxRoute(sb))}
      testId="fl-sandbox-row"
    />
  );
  return (
    <div className="fl-sb" data-testid={`fl-sandbox-${sb.key}`}>
      {head}
      {call && call.kind !== 'asked' && (
        <div className="fl-call-line">
          <CallButton call={call} onGo={() => go({ view: 'live', sessionId: call.session.id })} />
        </div>
      )}
      <Agents agents={sb.agents} me={me} now={now} sel={sel} variant={variant} open={(s) => go(sandboxRoute(sb, s.id))} />
    </div>
  );
}

/** Who is looking and the live views they may watch: what a slot's call (slotCall) is worked out from. */
interface Viewer {
  me?: UserInfo;
  views?: AppState['live'];
}

const viewerOf = (app: AppState): Viewer => ({ me: app.me, views: app.config.live?.enabled ? app.live : undefined });

/** A computer's places: its sandboxes (free ones last). On the board, free sandboxes are one line of chips. */
function Places({ c, viewer, now, sel, variant, go, onNewSandbox }: { c: FleetComputer; viewer: Viewer; now: number; sel: FleetSelection; variant: Variant; go: (r: Route) => void; onNewSandbox?: () => void }) {
  // A free slot where a worker waits on the viewer stays a row, so its call shows (w1430).
  const callOf = (sb: FleetSandbox) => slotCall(sb.agents, viewer.views, viewer.me);
  const free = variant === 'board' ? c.sandboxes.filter((s) => s.free && !callOf(s)) : [];
  const shown = variant === 'board' ? c.sandboxes.filter((s) => !free.includes(s)) : c.sandboxes;
  return (
    <div className="fl-places">
      {shown.map((sb) => (
        <SandboxItem key={sb.key} sb={sb} me={viewer.me} call={callOf(sb)} now={now} sel={sel} variant={variant} go={go} />
      ))}
      {free.length > 0 && (
        <div className="fl-free-line" data-testid="fl-free-line">
          <span className="fl-free">FREE</span>
          {free.map((sb) => (
            <button key={sb.key} className="fl-chip mono" onClick={() => go(sandboxRoute(sb))} title={`${sb.key} · ${sb.branch} · ${unityLabel[sb.unity]}`}>
              {sb.id}
            </button>
          ))}
        </div>
      )}
      {c.host && !c.daemon && (
        <p className="side-empty">The portal runs the orchestrators and the dispatcher; sandboxes and workers are on the machines.</p>
      )}
      {c.host && c.daemon && c.sandboxes.length === 0 && (
        <p className="side-empty">
          No sandboxes yet. Ask the orchestrator for work
          {onNewSandbox && (
            <>
              , or{' '}
              <button className="link-btn" onClick={onNewSandbox}>
                create one
              </button>
            </>
          )}
          .
        </p>
      )}
    </div>
  );
}

/** The inputs and result of the last fleetFor: the sidebar, its groups and the Overview share one per state change. */
let lastFleet: { key: unknown[]; fleet: FleetComputer[] } | undefined;

/** fleetOf, computed once per change of what it reads (the page re-renders on every server event). */
export function fleetFor(app: AppState): FleetComputer[] {
  const key = [app.sessions, app.machines, app.system, app.machineStats, app.work];
  if (!lastFleet || key.some((k, i) => k !== lastFleet!.key[i])) lastFleet = { key, fleet: fleetOf(app, sessionIndex(app.sessions)) };
  return lastFleet.fleet;
}

// ---------------------------------------------------------------- the sidebar's groups

export function FleetGroups({ app, sel, go, onNewSandbox }: { app: AppState; sel: FleetSelection; go: (r: Route) => void; onNewSandbox: () => void }) {
  const now = useNow(15_000);
  const [collapsed, toggle] = useCollapsed();
  const viewer = viewerOf(app);
  return (
    <>
      {/* Providers first: a short group with no sandboxes, so it stays in view above the machines' lists. */}
      {(app.providers ?? []).map((p) => (
        <ProviderGroup key={p.id} p={p} now={now} go={go} />
      ))}
      {fleetFor(app).map((c) => {
        const closed = collapsed.has(c.key);
        return (
          <div key={c.key} className={`fl-group${closed ? ' collapsed' : ''}`} data-testid={`fl-group-${c.key}`}>
            <button className="fl-head" onClick={() => toggle(c.key)} aria-expanded={!closed} title={closed ? `Show ${c.name}'s sandboxes and agents` : `Hide ${c.name}'s sandboxes and agents`}>
              <Head c={c} health={c.host ? app.host?.health : undefined} now={now} fold />
            </button>
            {!closed && <Places c={c} viewer={viewer} now={now} sel={sel} variant="side" go={go} onNewSandbox={c.host ? onNewSandbox : undefined} />}
          </div>
        );
      })}
    </>
  );
}

/** "425G": a byte count in the unit's letter only, so the cells fit the sidebar. */
const short = (n: number) => fmtBytes(n).replace(/ ([KMGT])B$/, '$1');

/**
 * A provider among the computers (FFBox), from the metrics its connector pushes (shared/providerMetrics.ts): CPU as the
 * 1-minute load over the logical cores (above 100% when more is runnable than it has cores), RAM used of total, GPU
 * "none" (its classes are CPU-only), and free of total for its root filesystem (the others in the hover). After two minutes without an
 * update, or with the connector gone, the last numbers stay, dimmed, under a "stale" or "offline" marker. It opens the
 * provider's page.
 */
function ProviderGroup({ p, now, go }: { p: Provider; now: number; go: (r: Route) => void }) {
  const m = p.metrics;
  const stale = !!m && metricsStale(m, now);
  const tone: Tone = !p.online ? 'grey' : stale || !m ? 'amber' : 'green';
  const marker = !m ? undefined : !p.online ? `offline · seen ${fmtRelative(p.lastSeen ?? m.receivedAt, now)}` : stale ? `stale · updated ${fmtRelative(m.receivedAt, now)}` : undefined;
  const cpu = m && cpuPct(m);
  const ram = m && memPct(m);
  const hasGpu = p.capacity?.classes.some((k) => k.gpu);
  // One disk, the root filesystem: the others are in the hover (Lothsahn, 2026-10-03: they took too much room).
  const disk = m && rootDisk(m);
  const diskUsed = disk && ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100;
  const cells: { label: string; pct?: number; text: string; lvl: Lvl; hint?: string }[] = m
    ? [
        ...(cpu !== undefined && m.cpu ? [{ label: 'CPU', pct: cpu, text: `${Math.round(cpu)}%`, lvl: level(cpu), hint: `load ${m.cpu.load1} on ${m.cpu.cores} cores` }] : []),
        ...(ram !== undefined && m.mem ? [{ label: 'RAM', pct: ram, text: `${short(m.mem.usedBytes)}/${short(m.mem.totalBytes)}`, lvl: level(ram, 85, 95) }] : []),
        { label: 'GPU', text: hasGpu ? 'n/a' : 'none', lvl: 'ok' as Lvl, hint: hasGpu ? 'not reported' : 'CPU-only' },
        ...(disk ? [{ label: 'Disk', pct: diskUsed, text: `${short(disk.freeBytes)}/${short(disk.totalBytes)}`, lvl: level(diskUsed!, 85, 95), hint: `free of total
${disksHint(m)}` }] : []),
      ]
    : [];
  return (
    <div className="fl-group" data-testid={`fl-group-provider-${p.id}`}>
      <button className="fl-head" onClick={() => go({ view: 'provider', providerId: p.id })} title={`${p.name}: ${metricsLine(m, now)}`}>
        <span className="fl-title">
          <Dot tone={tone} title={p.online ? (stale ? 'connected, metrics stale' : 'connected') : 'offline'} />
          <span className="fl-name">{p.name}</span>
          <span className="fl-os" data-testid="fl-os">
            Linux · provider{m?.cpu ? ` · ${m.cpu.cores} cores` : ''}
          </span>
          {marker && (
            <span className={`fl-stale-tag tone-${tone}`} data-testid="provider-metrics-stale">
              {marker}
            </span>
          )}
        </span>
        {!m ? (
          <span className="fl-meters fl-meters-off" data-testid="provider-metrics-off">
            no metrics
          </span>
        ) : (
          <span className={`fl-pv-meters${marker ? ' fl-stale' : ''}`} data-testid="provider-meters">
            <span className="fl-meters">
              {cells.map((c) => (
                <span key={c.label} className="fl-meter" data-testid={`meter-${c.label}`} title={c.hint}>
                  {c.pct !== undefined && (
                    <span className={`mbar lvl-bg-${c.lvl}`} aria-hidden>
                      <i style={{ height: `${Math.max(8, Math.min(100, c.pct))}%` }} />
                    </span>
                  )}
                  {c.label} <b className={`lvl-${c.lvl}`}>{c.text}</b>
                </span>
              ))}
            </span>
          </span>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the Overview board

export function OverviewBoard({ app }: { app: AppState }) {
  const keep = useKeepScroll('overview');
  const keepCards = useKeepScroll('overview:workers');
  const now = useNow(15_000);
  const fleet = fleetFor(app);
  const live = fleet.reduce((n, c) => n + c.live, 0);
  const busy = fleet.reduce((n, c) => n + c.busy, 0);
  const waiting = useAttention(app).length;
  // The machine view, or one card per worker (w1837); remembered in this browser.
  const [mode, setModeState] = useState<OverviewMode>(() => readMode(lsGet(OVERVIEW_MODE_KEY)));
  const setMode = (m: OverviewMode) => {
    setModeState(m);
    lsSet(OVERVIEW_MODE_KEY, writeMode(m));
  };
  const go = (r: Route) => navigate(r);
  return (
    <section className="overview" data-testid="overview" data-mode={mode}>
      <header className="page-head">
        <DrawerButton />
        <span className="page-title">Overview</span>
        <span className="overview-sum dim small">
          {live} {live === 1 ? 'agent' : 'agents'} live · {busy} busy{waiting ? ` · ${waiting} waiting on you` : ''}
        </span>
        <span className="spacer" />
        <span className="ov-mode" role="group" aria-label="Show the Overview by" data-testid="overview-mode">
          {(['machines', 'workers'] as const).map((m) => (
            <button key={m} type="button" className={`ov-mode-btn${mode === m ? ' on' : ''}`} aria-pressed={mode === m} onClick={() => setMode(m)} title={m === 'machines' ? 'One column per machine, with its sandboxes' : 'One card per worker: what it is doing and where'} data-testid={`overview-mode-${m}`}>
              {m === 'machines' ? 'Machines' : 'Workers'}
            </button>
          ))}
        </span>
        <AttentionButton />
      </header>
      {mode === 'workers' ? (
        <WorkerBoard app={app} fleet={fleet} now={now} scrollRef={keepCards} />
      ) : (
        <div className="board" ref={keep}>
          {fleet.map((c) => (
            <article key={c.key} className="board-card" data-testid={`board-${c.key}`}>
              <header className="board-head">
                {c.machine ? (
                  <button className="board-head-link" onClick={() => go({ view: 'machine', machineId: c.machine!.id })} title={`Open ${c.name}`}>
                    <Head c={c} now={now} />
                  </button>
                ) : c.daemon ? (
                  <button className="board-head-link" onClick={() => go({ view: 'machine', machineId: c.daemon!.id })} title={`Open ${c.name}'s daemon (${c.daemon.id})`}>
                    <Head c={c} health={app.host?.health} now={now} />
                  </button>
                ) : (
                  <div className="board-head-link">
                    <Head c={c} health={app.host?.health} now={now} />
                  </div>
                )}
              </header>
              <Places c={c} viewer={viewerOf(app)} now={now} sel={{}} variant="board" go={go} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
