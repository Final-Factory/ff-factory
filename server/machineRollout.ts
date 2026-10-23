import fs from 'node:fs';
import path from 'node:path';
import type { BenchState, Requester } from '../shared/types.ts';
import { readJsonDurable, writeJsonDurable } from './durable.ts';
import { daemonBehind } from './machines.ts';
import { SAFE_ROOT, SAFE_TARGET, workerToolsRemote, workerUpdateRemote } from './opsWorker.ts';
import { AGENT_PLUGINS, EXIT, LINE, parseVersions, type Versions } from './agentTools.ts';
import type { LinkUpdateReport } from './machineProtocol.ts';

/**
 * The machine rollout (w887, lothsahn 2026-10-10: "Update FFFactory so that after updating the portal and validating, it
 * automatically updated all the machines."). When a portal deploy has VERIFIED, the new release answered /api/health
 * (deploy/vm/guest/fff-update, `verify`, which then writes data/update.verified.json; a rollback writes nothing), this
 * runs the worker installer's update on every worker root machine, over the portal's own ssh, one machine at a time:
 *
 * - The person's deploy approval covers it. No request, no ops job, no Claude session: the command is the one
 *   ops_worker machine_update writes (workerUpdateRemote), with no setting named, so every limit stays.
 * - An update stops only the daemon; agents in agent hosts are adopted by the new one (docs/worker-install.md, "An update
 *   does not stop running work", w605). So nothing is drained or waited for. Each machine's agents are counted before
 *   and compared with what its daemon says it took back (its hello), and any that ended are named in the report.
 * - A machine that is offline stays pending and is updated when it next says hello. One that fails does not stop the
 *   rest. The installer touches nothing when a prerequisite is missing, and succeeds only on a daemon the portal sees
 *   online; when a failed run leaves the machine offline, this reruns the installer at the commit it ran before.
 * - One report per deploy, to the orchestrator of whoever asked for it (the dispatcher for a deploy by hand), once
 *   every machine is settled or only the offline ones are left; a machine that finishes later gets a short follow-up.
 * - Then the agent tools (w1476, lothsahn 2026-10-18: "Please create a new work item that deploying the latest tools is part
 *   of every deploy operation"): on every worker root machine online after its daemon step, updated or already current, the
 *   installer's tools form (workerToolsRemote, server/agentTools.ts) brings the final-factory-agents plugins to master. The
 *   report gives each plugin's version before and after. A failure there is reported, changes nothing about the daemon and
 *   rolls nothing back; the next machine carries on.
 * - Neither runs beside a timed run (w1861: m5's update and tools job ran inside a timed A/B leg of w1780 on 2026-10-23,
 *   13:19 to 13:22 UTC). While a timed run holds the machine's bench queue exclusively, or held it under benchQuietMs ago
 *   (a timed script lets go between its legs for seconds), its update and its tools publish wait, for benchWaitMs at the
 *   most; the report names the run they wait for.
 */

/** The marker fff-update writes when a deploy verified, and where the rollout keeps its state (both in the data folder). */
export const VERIFIED_FILE = 'update.verified.json';
export const ROLLOUT_FILE = 'machine-rollout.json';

export const ROLLOUT_LIMITS = {
  /** One installer run over ssh (npm ci on a slow machine included). */
  installMs: 15 * 60_000,
  /** One agent tools run over ssh (the installer's clone, then registerAgents.sh: a marketplace pull and three plugin installs). */
  toolsMs: 15 * 60_000,
  /** After a failed run, how long the machine gets to be seen online before it counts as left without a daemon. */
  settleMs: 90_000,
  /** The main report waits this long after the verification for machines that are only reconnecting to the new portal. */
  graceMs: 10 * 60_000,
  /** A verified marker older than this is retired without a rollout (stale, e.g. restored data). */
  staleMarkerMs: 24 * 3_600_000,
  tickMs: 30_000,
  /** w1861: a machine's bench must be free this long before its update or tools publish (probe_ab.sh lets go for seconds between legs). */
  benchQuietMs: 90_000,
  /** w1861: a timed run holds a machine's update and tools back this long at the most (an exclusive turn is 30 minutes while
   * anyone waits behind it, and goes on past them while nobody does). */
  benchWaitMs: 45 * 60_000,
};

export interface RolloutMachine {
  id: string;
  /** The worker root folder; absent: not a worker root install. */
  root?: string;
  platform?: string;
  /** user@host the portal's ssh reaches it by. */
  target: string;
  /** The portal's own host. */
  local?: boolean;
}

export interface RolloutHost {
  machines(): RolloutMachine[];
  online(id: string): boolean;
  /** Whether its connected daemon has said hello on this connection: until then its commit is not known, not unknown (w970). */
  hello(id: string): boolean;
  /** The commit its connected daemon says it runs, or undefined. */
  daemon(id: string): string | undefined;
  /** Why its connected daemon is outdated (a protocol out of range), or undefined. */
  outdated(id: string): string | undefined;
  /** The agent processes alive on it now. */
  agents(id: string): { id: string; title: string }[];
  /** What its daemon reported alive in a hello at or after `since` (epoch ms), or undefined when it has said none since. */
  liveAtHello(id: string, since: number): ReadonlySet<string> | undefined;
  /** Run a command on it over the portal's ssh. */
  ssh(target: string, remote: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Whether its connected daemon updates over its own link (w1596): then ssh is not used for it. */
  link?(id: string): boolean;
  /** The installer's form over the daemon's link, to the deployed commit: its update job's report (server/machines.ts linkUpdate). */
  linkUpdate?(id: string, form: 'update' | 'tools', commit: string): Promise<LinkUpdateReport>;
  /** Send the report to a person's orchestrator, or (no person) the dispatcher. */
  tell(person: Requester | undefined, text: string): void;
  /** Who asked for the deploy that verified at this time (epoch ms), if anyone did through the ops worker. */
  requesterOf(verifiedAt: number): Requester | undefined;
  /** w1861: the timed run that holds its bench queue exclusively now, for people ("a timed run on m5/slot2 (w1780)"), from
   * its daemon's last stats; undefined when none does (or its daemon does not say). */
  timedRun?(id: string): string | undefined;
}

/** The agent tools publish on one machine (w1476). */
export interface ToolsOutcome {
  status: 'publishing' | 'ok' | 'failed' | 'not-published' | 'skipped';
  /** Each plugin's version (absent: not installed) before and after the run, and what final-factory-agents master publishes. */
  before?: Versions;
  after?: Versions;
  latest?: Versions;
  /** The final-factory-agents commit the run installed from. */
  latestSha?: string;
  note?: string;
  summary?: string[];
  /** A run that published but said WARNING (w1742: a firewall rule missing on a computer the run could not fix). */
  warnings?: string[];
  at?: string;
}

export interface MachineOutcome {
  status: 'pending' | 'updating' | 'ok' | 'current' | 'failed' | 'skipped';
  /** Why it is pending, skipped or failed. */
  note?: string;
  before?: string;
  after?: string;
  /** The installer's own lines that matter (what ran before and after, settings changed, what the portal sees, a failure). */
  summary?: string[];
  /** Agents that were alive before the update, and the ones its new daemon did not take back. */
  agentsBefore?: number;
  adopted?: number;
  ended?: { id: string; title: string }[];
  /** The adoption could not be checked (the daemon said no hello after the update). */
  adoptionUnknown?: boolean;
  /** Settings the installer changed although none was asked for (a `~ key: before -> after` line). */
  settingsChanged?: string[];
  /** A failed update left the machine offline and the installer was run again at the commit it ran before. */
  rollback?: 'ok' | 'failed';
  at?: string;
  /** The main report named it as it was; a later change is then reported as a follow-up. */
  told?: boolean;
  /** The agent tools publish after the daemon step (w1476). */
  tools?: ToolsOutcome;
  /** w1861: its update or tools publish waits for a timed run on it (`note` says which); not settled meanwhile. */
  held?: boolean;
}

export interface RolloutState {
  sha?: string;
  previous?: string;
  verifiedAt?: string;
  by?: Requester;
  /** This rollout also publishes the agent tools (w1476): set when it starts, so a rollout from before never does. */
  tools?: boolean;
  /** The main report went out. */
  reported?: boolean;
  machines: Record<string, MachineOutcome>;
}

export interface RolloutDeps {
  host: RolloutHost;
  /** The portal's data folder: the verified marker is read here, and the state is kept here. */
  dataDir: string;
  /** Off in a dry run and with machines.autoUpdateAfterDeploy false. */
  enabled: () => boolean;
  /** The agent tools publish (w1476); off with machines.publishAgentToolsAfterDeploy false. Default on. */
  tools?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<typeof ROLLOUT_LIMITS>;
}

/** Stats older than this say nothing about a machine's bench now (its daemon reports them every 15 s, machine/daemon.ts STATS_MS). */
const BENCH_STATS_FRESH_MS = 3 * 60_000;

/**
 * w1861: the timed run holding a machine's bench queue exclusively, for people ("a timed run on m5/slot2 (w1780)"), from
 * its daemon's last stats (`bench`, machine/benchState.ts, received at `at`), or undefined when none does, the stats are
 * stale or its daemon is older than w1835. Exported for tests.
 */
export function timedRunText(bench: BenchState | undefined, at: number, now = Date.now()): string | undefined {
  if (!bench || bench.mode !== 'exclusive' || !Number.isFinite(at) || now - at > BENCH_STATS_FRESH_MS) return undefined;
  if (bench.legacy) return `an old-style timed run (${clip(bench.legacy.owner, 100)})`;
  const t = bench.running.find((r) => r.mode === 'exclusive');
  if (!t) return 'a timed run';
  const where = [t.host, t.sandbox].filter(Boolean).join('/') || (t.session ? `worker ${t.session}` : '');
  return `a timed run${where ? ` on ${where}` : ''}${t.requests?.length ? ` (${t.requests.join(', ')})` : ''}`;
}

const SHA = /^[0-9a-f]{7,40}$/i;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The lines of an installer run worth reporting (scripts/worker/worker.ts `update`): what ran before and after, the settings
 * changed, what the portal sees, the problems that stopped it. Falls back to the last lines. Exported for tests.
 */
export function installerSummary(out: string): string[] {
  const lines = out.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const keep = lines.filter((l) => /^(Before:|After:|Settings|The portal sees|FAILED|Not updating|The portal does not|Credential:|Its log:)/.test(l) || /^\s+~ /.test(l) || /^- /.test(l));
  return (keep.length ? keep : lines.slice(-6)).slice(-14).map((l) => clip(l.trim(), 240));
}

/** The `~ key: before -> after` lines of an installer run: settings it changed. A rollout names none, so any is a surprise. */
export function changedSettings(out: string): string[] {
  return out
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^~ \S+: .* -> /.test(l))
    .map((l) => clip(l, 200));
}

export class MachineRollout {
  private readonly d: RolloutDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly lim: typeof ROLLOUT_LIMITS;
  private readonly file: string;
  private readonly marker: string;
  state: RolloutState = { machines: {} };
  private busy = false;
  private timer?: NodeJS.Timeout;
  /** w1861: per machine, since when a timed run holds its update back, when one was last seen, and what. */
  private readonly benchSeen = new Map<string, { since: number; last: number; what: string; over?: boolean }>();

  constructor(d: RolloutDeps) {
    this.d = d;
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lim = { ...ROLLOUT_LIMITS, ...d.limits };
    this.file = path.join(d.dataDir, ROLLOUT_FILE);
    this.marker = path.join(d.dataDir, VERIFIED_FILE);
    const saved = readJsonDurable<RolloutState>(this.file, { generations: 0 });
    if (saved && typeof saved === 'object' && saved.machines) this.state = saved;
    // A run the last portal was in the middle of is lost with it: the machine is looked at again (its daemon says where it is).
    for (const o of Object.values(this.state.machines)) {
      if (o.status === 'updating') Object.assign(o, { status: 'pending', note: 'the portal restarted during its update; looked at again' });
      if (o.tools?.status === 'publishing') delete o.tools;
    }
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.lim.tickMs);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 5_000).unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  private save() {
    try {
      writeJsonDurable(this.file, this.state, { indent: 2, generations: 0 });
    } catch (e) {
      console.warn('machine rollout: could not save its state:', (e as Error).message);
    }
  }

  /** A verified deploy's marker, taken once: a new rollout for its commit. */
  private takeVerified() {
    if (!fs.existsSync(this.marker)) return;
    let v: { sha?: string; previous?: string; at?: string } | undefined;
    try {
      v = JSON.parse(fs.readFileSync(this.marker, 'utf8').replace(/^﻿/, ''));
    } catch {
      return; // being written; next tick
    }
    const at = Date.parse(v?.at ?? '');
    const sha = v?.sha?.trim().toLowerCase();
    if (sha && SHA.test(sha) && sha !== this.state.sha && Number.isFinite(at) && this.now() - at <= this.lim.staleMarkerMs) {
      const by = this.d.host.requesterOf(at);
      const tools = this.d.tools?.() !== false;
      this.benchSeen.clear();
      this.state = { sha, previous: v?.previous || undefined, verifiedAt: new Date(at).toISOString(), ...(by ? { by } : {}), ...(tools ? { tools } : {}), machines: {} };
      this.save();
      console.log(`machine rollout: portal ${sha.slice(0, 9)} verified${by ? ` (deploy asked for by ${by.userId})` : ''}; updating the machines' daemons${tools ? ' and agent tools' : ''}`);
    }
    // Retired only after the state is saved: a crash in between takes the marker again.
    try {
      fs.renameSync(this.marker, path.join(this.d.dataDir, 'update.verified.done.json'));
    } catch {
      fs.rmSync(this.marker, { force: true });
    }
  }

  /** One pass: take a verification, update every machine that is online and not done, send what is due. */
  async tick(): Promise<void> {
    if (this.busy || !this.d.enabled()) return;
    this.busy = true;
    try {
      this.takeVerified();
      const sha = this.state.sha;
      if (!sha) return;
      // A machine removed since is not waited for.
      const known = new Set(this.d.host.machines().map((m) => m.id));
      for (const id of Object.keys(this.state.machines)) if (!known.has(id)) delete this.state.machines[id];
      for (const m of this.d.host.machines()) {
        const o = (this.state.machines[m.id] ??= { status: 'pending' });
        if (o.status !== 'pending') {
          if (this.toolsDue(m, o)) await this.publishTools(m, o);
          this.save();
          continue;
        }
        if (m.local) {
          Object.assign(o, { status: 'skipped', note: "the portal's own host: the portal runs its daemon itself" });
        } else if (!m.root) {
          Object.assign(o, { status: 'skipped', note: 'not a worker root install: updated another way (the portal redeploys it itself once idle)' });
        } else if (!this.viaLink(m.id) && (!SAFE_TARGET.test(m.target) || !SAFE_ROOT.test(m.root) || /\s/.test(m.root))) {
          Object.assign(o, { status: 'skipped', note: 'its ssh target or root folder has characters this will not pass to a shell' });
        } else if (!this.d.host.online(m.id)) {
          o.note = 'offline';
          continue;
        } else if (!this.d.host.hello(m.id)) {
          // Connected, but its hello (which carries its commit) has not come yet: w970, beast was read as "unknown" and skipped.
          o.note = 'connected, but its daemon has not said hello yet';
          continue;
        } else if (!this.needsUpdate(m.id, sha)) {
          Object.assign(o, { status: 'current', before: this.d.host.daemon(m.id), after: this.d.host.daemon(m.id), at: new Date(this.now()).toISOString() });
        } else {
          const held = this.heldBack(m.id);
          if (held) {
            Object.assign(o, { note: held, held: true });
            continue;
          }
          delete o.held;
          await this.updateOne(m, o, sha);
        }
        this.save();
        if (this.toolsDue(m, o)) await this.publishTools(m, o);
        this.save();
      }
      this.save();
      this.report();
    } catch (e) {
      console.warn('machine rollout:', (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** A commit that is not known counts as outdated (w970), unlike the nag in machines.ts that leaves it alone: the update fixes it. */
  private needsUpdate(id: string, sha: string): boolean {
    const daemon = this.d.host.daemon(id);
    return !!this.d.host.outdated(id) || !daemon || !!daemonBehind({ daemon }, sha);
  }

  /** The installer's update over the portal's ssh (a daemon before w1596, or one not connected when the rollout ran). */
  private async updateOverSsh(m: RolloutMachine, o: MachineOutcome, sha: string, before: string | undefined): Promise<void> {
    const host = this.d.host;
    try {
      const r = await host.ssh(m.target, this.installCommand(m), this.lim.installMs);
      const out = `${r.stdout}\n${r.stderr}`;
      o.summary = installerSummary(out);
      const changed = changedSettings(out);
      if (changed.length) o.settingsChanged = changed;
      if (r.code === 0) {
        Object.assign(o, { status: 'ok', after: host.daemon(m.id) ?? sha.slice(0, 12) });
      } else {
        await this.afterFailure(m, o, before, `the installer exited ${r.code}`);
      }
    } catch (e) {
      await this.afterFailure(m, o, before, (e as Error).message);
    }
  }

  /** Its daemon updates over its own link (w1596): the rollout uses that, and ssh only for a daemon that does not. */
  private viaLink(id: string): boolean {
    return !!this.d.host.linkUpdate && !!this.d.host.link?.(id);
  }

  /**
   * The update over the daemon's link (w1596): its job runs the same installer update and, when the new daemon does not come
   * back, puts the code that ran before back itself, so nothing here reruns anything. A job that never reports (the machine
   * gone quiet) is handled as an ssh run that failed: waited for, and put back over ssh where the portal can reach it.
   */
  private async updateOverLink(m: RolloutMachine, o: MachineOutcome, sha: string, before: string | undefined): Promise<void> {
    const host = this.d.host;
    let r: LinkUpdateReport;
    try {
      r = await host.linkUpdate!(m.id, 'update', sha);
    } catch (e) {
      const why = `over its daemon's link: ${(e as Error).message}`;
      if (/refused it:/.test(why)) Object.assign(o, { status: 'failed', note: `${why}; nothing was changed, and the daemon keeps working` });
      else await this.afterFailure(m, o, before, why);
      return;
    }
    o.summary = installerSummary(r.log);
    const changed = changedSettings(r.log);
    if (changed.length) o.settingsChanged = changed;
    if (r.ok) {
      Object.assign(o, { status: 'ok', after: host.daemon(m.id) ?? r.after ?? sha.slice(0, 12) });
      return;
    }
    if (r.rollback) o.rollback = r.rollback;
    Object.assign(o, { status: 'failed', after: r.after, note: `its update job (over the daemon's link) ${r.note ?? `exited ${r.exit}`}${r.rollback === 'failed' ? ' (OFFLINE or broken: it needs a person)' : ''}` });
  }

  private installCommand(m: RolloutMachine, daemonRef?: string): string {
    // No setting is named, so the installer carries every limit as it is. A rollback names the commit it goes back to.
    const flag = daemonRef ? (m.platform === 'win32' ? `-DaemonRef ${daemonRef}` : `--daemon-ref ${daemonRef}`) : '';
    return workerUpdateRemote({ root: m.root!, platform: m.platform }, flag);
  }

  /** Update one machine, never throwing: its outcome is recorded whatever happens. */
  private async updateOne(m: RolloutMachine, o: MachineOutcome, sha: string): Promise<void> {
    const host = this.d.host;
    const startedAt = this.now();
    const before = host.daemon(m.id);
    const agentsBefore = host.agents(m.id);
    Object.assign(o, { status: 'updating', note: undefined, before, agentsBefore: agentsBefore.length });
    this.save();
    console.log(`machine rollout: updating ${m.id} (${before ?? 'unknown'} -> ${sha.slice(0, 9)}; ${agentsBefore.length} agent(s) alive${this.viaLink(m.id) ? "; over its daemon's link" : ''})`);
    if (this.viaLink(m.id)) await this.updateOverLink(m, o, sha, before);
    else await this.updateOverSsh(m, o, sha, before);
    o.at = new Date(this.now()).toISOString();
    // Were the agents taken back by the new daemon? Its hello after the update says what it runs.
    if (agentsBefore.length) await this.checkAdoption(m.id, o, agentsBefore, startedAt);
    console.log(`machine rollout: ${m.id}: ${o.status}${o.note ? ` (${o.note})` : ''}`);
  }

  /**
   * An update that did not succeed. The installer changes nothing when a prerequisite is missing and leaves the old
   * daemon running, so a machine seen online is simply kept as it was. One that stays offline or outdated is put back on
   * the commit it ran before, with the same installer.
   */
  private async afterFailure(m: RolloutMachine, o: MachineOutcome, before: string | undefined, why: string) {
    const host = this.d.host;
    const waited = await this.waitOnline(m.id);
    if (waited) {
      Object.assign(o, { status: 'failed', note: `${why}; the daemon is online (${host.daemon(m.id) ?? 'commit unknown'}) and keeps working` });
      return;
    }
    if (before && SHA.test(before)) {
      try {
        const r = await host.ssh(m.target, this.installCommand(m, before), this.lim.installMs);
        o.summary = [...(o.summary ?? []), ...installerSummary(`${r.stdout}\n${r.stderr}`).map((l) => `rollback: ${l}`)].slice(-18);
        const back = r.code === 0 || (await this.waitOnline(m.id));
        o.rollback = back ? 'ok' : 'failed';
      } catch {
        o.rollback = 'failed';
      }
    } else o.rollback = 'failed';
    Object.assign(o, {
      status: 'failed',
      note: o.rollback === 'ok' ? `${why}; the daemon was offline, so the installer put it back on ${before?.slice(0, 9)}` : `${why}; the daemon is OFFLINE and could not be put back: it needs a person (the machine's daemon log)`,
    });
  }

  /** A worker root machine whose daemon step is done and that is online now, not yet published to in this rollout. */
  private toolsDue(m: RolloutMachine, o: MachineOutcome): boolean {
    if (!this.state.tools || o.tools || !m.root || m.local) return false;
    if (o.status !== 'ok' && o.status !== 'current' && o.status !== 'failed') return false;
    if (!this.d.host.online(m.id)) {
      // Its daemon failed and is offline: nothing to run the tools on, and the report already says it needs a person.
      if (o.status === 'failed') o.tools = { status: 'skipped', note: 'the machine is offline after its failed daemon update' };
      return false;
    }
    // w1861: the tools run (a marketplace pull, plugin installs) waits for a timed run on the machine, as its update does.
    const held = this.heldBack(m.id);
    if (held) {
      Object.assign(o, { note: held, held: true });
      return false;
    }
    if (o.held) {
      delete o.held;
      if (o.status !== 'failed') delete o.note;
    }
    return true;
  }

  /**
   * w1861: why a machine's update and tools publish wait now, or undefined. A timed run holds its bench queue exclusively
   * (its daemon's stats), or held it under benchQuietMs ago: a timed script lets go between its legs for seconds
   * (probe_ab.sh), and an update in that gap runs inside the next leg. At most benchWaitMs from the first sight, then the
   * update goes ahead (logged), so a run that never lets go does not keep a machine on old code.
   */
  private heldBack(id: string): string | undefined {
    const now = this.now();
    const what = this.d.host.timedRun?.(id);
    let h = this.benchSeen.get(id);
    if (h?.over) return undefined;
    if (what) this.benchSeen.set(id, (h = { since: h?.since ?? now, last: now, what }));
    if (!h) return undefined;
    if (now - h.since >= this.lim.benchWaitMs) {
      h.over = true;
      console.log(`machine rollout: ${id}: ${h.what} has held its bench for ${Math.round((now - h.since) / 60_000)} min; its update goes ahead`);
      return undefined;
    }
    if (!what && now - h.last >= this.lim.benchQuietMs) {
      this.benchSeen.delete(id);
      return undefined;
    }
    const latest = new Date(h.since + this.lim.benchWaitMs).toISOString().slice(11, 16);
    return `held back for ${h.what}${what ? '' : ', which let go moments ago (its next leg may follow)'}: an update beside a timed run spoils its numbers (w1861); it runs once the bench has been free for ${Math.round(this.lim.benchQuietMs / 1000)} s, by ${latest}Z at the latest`;
  }

  /** Publish the latest agent tools on one machine (w1476), never throwing: its outcome is recorded whatever happens. */
  private async publishTools(m: RolloutMachine, o: MachineOutcome): Promise<void> {
    const t: ToolsOutcome = (o.tools = { status: 'publishing' });
    this.save();
    console.log(`machine rollout: publishing the agent tools on ${m.id}`);
    try {
      if (this.viaLink(m.id)) {
        // Over the daemon's link (w1596): the installer's tools form, run by a job from the deployed commit's checkout.
        const r = await this.d.host.linkUpdate!(m.id, 'tools', this.state.sha!);
        Object.assign(t, toolsResult(r.exit, r.log));
        // The link's job runs as the daemon, never elevated, so it can only say a firewall rule is missing (w1742: the agent
        // node's rule never reached lothdesktop or BEAST). The portal's ssh to an administrator's Windows account is
        // elevated (administrators_authorized_keys, w568), and the same tools run there makes the rules.
        const warned = t.warnings ?? [];
        if (m.platform === 'win32' && SAFE_TARGET.test(m.target) && t.status === 'ok' && warned.some((w) => w.includes('Windows Firewall'))) {
          console.log(`machine rollout: ${m.id}: a firewall rule is missing; the tools run again over ssh, elevated`);
          try {
            const s = await this.d.host.ssh(m.target, workerToolsRemote({ root: m.root!, platform: m.platform }), this.lim.toolsMs);
            const again = toolsResult(s.code, `${s.stdout}\n${s.stderr}`);
            t.warnings = again.status === 'ok' ? again.warnings : [...warned, `WARNING: the tools run over ssh, for the firewall rules, ${again.status}: ${again.note ?? ''}`];
            if (!t.warnings?.length) delete t.warnings;
          } catch (e) {
            t.warnings = [...warned, `WARNING: the tools run over ssh, for the firewall rules, failed: ${(e as Error).message}`];
          }
        }
      } else {
        const r = await this.d.host.ssh(m.target, workerToolsRemote({ root: m.root!, platform: m.platform }), this.lim.toolsMs);
        Object.assign(t, toolsResult(r.code, `${r.stdout}\n${r.stderr}`));
      }
    } catch (e) {
      Object.assign(t, { status: 'failed', note: (e as Error).message });
    }
    t.at = new Date(this.now()).toISOString();
    console.log(`machine rollout: ${m.id}: agent tools ${t.status}${t.note ? ` (${t.note})` : ''}`);
  }

  private async waitOnline(id: string): Promise<boolean> {
    const until = this.now() + this.lim.settleMs;
    for (;;) {
      if (this.d.host.online(id) && !this.d.host.outdated(id)) return true;
      if (this.now() >= until) return false;
      await this.sleep(Math.min(5_000, this.lim.settleMs));
    }
  }

  private async checkAdoption(id: string, o: MachineOutcome, before: { id: string; title: string }[], since: number) {
    let live = this.d.host.liveAtHello(id, since);
    for (let i = 0; !live && i < 6; i++) {
      await this.sleep(Math.min(5_000, this.lim.settleMs));
      live = this.d.host.liveAtHello(id, since);
    }
    if (!live) {
      o.adoptionUnknown = true;
      return;
    }
    const ended = before.filter((a) => !live!.has(a.id));
    Object.assign(o, { adopted: before.length - ended.length, ended });
  }

  private line(id: string, o: MachineOutcome): string {
    const sums = (o.summary ?? []).map((l) => `    ${l}`);
    const agents =
      o.agentsBefore === undefined
        ? ''
        : o.adoptionUnknown
          ? ` ${o.agentsBefore} agent(s) were alive before; the daemon has not said hello since, so whether they were adopted is unchecked.`
          : o.ended?.length
            ? ` AGENTS THAT ENDED (${o.ended.length} of ${o.agentsBefore}): ${o.ended.map((a) => `${a.id} "${clip(a.title, 60)}"`).join(', ')}; the portal resumes the mid-turn ones, an idle one comes back on its next message.`
            : ` Agents: ${o.adopted ?? 0} of ${o.agentsBefore} adopted by the new daemon, none ended.`;
    const limits = o.status === 'ok' || o.status === 'failed' ? (o.settingsChanged?.length ? ` SETTINGS CHANGED although none was asked for: ${o.settingsChanged.join('; ')}.` : ' Limits unchanged.') : '';
    const commits = o.before || o.after ? ` ${o.before?.slice(0, 9) ?? '?'} → ${o.after?.slice(0, 9) ?? '?'}.` : '';
    const head =
      o.status === 'ok' ? `updated.${commits}${limits}${agents}`
      : o.status === 'current' ? `already on the deployed commit (${o.after?.slice(0, 9) ?? 'unknown'}); its daemon was left alone.`
      : o.status === 'failed' ? `FAILED: ${o.note}.${commits}${limits}${agents}${o.rollback ? ` Rollback: ${o.rollback}.` : ''}`
      : o.status === 'skipped' ? `skipped: ${o.note}.`
      : o.status === 'updating' ? 'updating now.'
      : o.held ? `waiting: ${o.note}.`
      : `waiting: ${o.note ?? 'not online'}. It is updated when it next comes online.`;
    const t = o.tools;
    const toolSums = t && (t.status === 'failed' || t.status === 'not-published') ? (t.summary ?? []).map((l) => `    tools: ${l}`) : [];
    const all = [...sums, ...toolSums];
    const toolsHeld = o.held && o.status !== 'pending' && !t ? ` Its agent tools wait: ${o.note}.` : '';
    return `- ${id}: ${head}${toolsLine(t)}${toolsHeld}${all.length ? `\n${all.join('\n')}` : ''}`;
  }

  /** The main report when every machine is settled (or only offline ones remain after the grace period), then follow-ups. */
  private report() {
    const s = this.state;
    if (!s.sha) return;
    const entries = Object.entries(s.machines);
    const settled = (o: MachineOutcome) => o.status !== 'pending' && o.status !== 'updating' && o.tools?.status !== 'publishing' && !o.held;
    const open = entries.filter(([, o]) => !settled(o));
    const graceOver = this.now() - Date.parse(s.verifiedAt ?? '') >= this.lim.graceMs;
    const tail = 'The deploy approval covers these updates; nothing is needed from anyone unless a line above says FAILED, NOT PUBLISHED or OFFLINE. Tell the user in a line if it does.';
    if (!s.reported) {
      if (entries.some(([, o]) => o.status === 'updating' || o.tools?.status === 'publishing')) return;
      if (open.length && !graceOver) return;
      const head = `[machine updates] Portal ${s.sha.slice(0, 9)}${s.previous ? ` (was ${s.previous.slice(0, 9)})` : ''} deployed and verified, so FF Factory updated the machines' daemons${s.tools ? ' and published the latest agent tools (final-factory-agents) on them' : ''} by itself (agents keep running through both: no drain, no waiting).`;
      const body = entries.map(([id, o]) => this.line(id, o)).join('\n');
      this.send(`${head}\n${body}\n${tail}`);
      s.reported = true;
      for (const [, o] of entries) if (settled(o)) o.told = true;
      this.save();
      return;
    }
    const fresh = entries.filter(([, o]) => !o.told && settled(o));
    if (!fresh.length) return;
    this.send(`[machine updates] Follow-up for portal ${s.sha.slice(0, 9)}: ${fresh.length === 1 ? 'a machine that was offline or held back' : 'machines that were offline or held back'} now settled.\n${fresh.map(([id, o]) => this.line(id, o)).join('\n')}\n${tail}`);
    for (const [, o] of fresh) o.told = true;
    this.save();
  }

  private send(text: string) {
    try {
      this.d.host.tell(this.state.by, text.slice(0, 7500));
    } catch (e) {
      console.warn('machine rollout: could not send its report:', (e as Error).message);
    }
  }
}

/** The `worker.ts tools` lines worth reporting: what was not published or failed and why, a warning, the checkout marker. */
function toolsSummary(lines: string[]): string[] {
  const keep = lines.filter((l) => /^(NOT PUBLISHED|FAILED|WARNING|ERROR|Cloned|publish-skills')/.test(l));
  return (keep.length ? keep : lines.slice(-4)).slice(-8).map((l) => clip(l, 240));
}

/** A tools run's outcome from its exit code and output (server/agentTools.ts EXIT and LINE). Exported for tests. */
export function toolsResult(code: number, out: string): Omit<ToolsOutcome, 'at'> {
  const lines = out.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = (prefix: string) => [...lines].reverse().find((l) => l.startsWith(prefix));
  const before = last(LINE.before);
  const after = last(LINE.after);
  // "Agent tools latest: final-factory-agents a8449abd8457: ff-agents 1.29.20, ..."
  const latest = /^\S+ ([0-9a-f]{7,40}): (.*)$/i.exec(last(LINE.latest)?.slice(LINE.latest.length).trim() ?? '');
  const why = lines.find((l) => /^(NOT PUBLISHED|FAILED|ERROR):/.test(l))?.replace(/^(NOT PUBLISHED|FAILED|ERROR):\s*/, '');
  const failed = code !== EXIT.ok;
  return {
    status: !failed ? 'ok' : code === EXIT.notPublished ? 'not-published' : 'failed',
    ...(before ? { before: parseVersions(before.slice(LINE.before.length)) } : {}),
    ...(after ? { after: parseVersions(after.slice(LINE.after.length)) } : {}),
    ...(latest ? { latest: parseVersions(latest[2]), latestSha: latest[1] } : {}),
    ...(failed ? { note: clip(why ?? `the installer's tools run exited ${code}`, 300), summary: toolsSummary(lines) } : {}),
    ...(!failed && lines.some((l) => l.startsWith('WARNING')) ? { warnings: lines.filter((l) => l.startsWith('WARNING')).slice(-4).map((l) => clip(l, 300)) } : {}),
  };
}

/** The agent tools part of a machine's report line: each plugin's version before → after. Exported for tests. */
export function toolsLine(t: ToolsOutcome | undefined): string {
  if (!t) return '';
  const list =
    t.before || t.after
      ? AGENT_PLUGINS.map((p) => {
          const b = t.before?.[p] ?? 'not installed';
          const a = (t.after ?? t.before)?.[p] ?? 'not installed';
          return b === a ? `${p} ${a}` : `${p} ${b} → ${a}`;
        }).join(', ')
      : 'plugin versions unknown';
  const master = t.latestSha ? ` (final-factory-agents ${t.latestSha.slice(0, 9)})` : '';
  const note = (t.note ?? '').replace(/\.+$/, '');
  switch (t.status) {
    case 'ok':
      return ` Agent tools: ${list}${master}; every installed plugin on master.${(t.warnings ?? []).map((w) => ` ${w}`).join('')}`;
    case 'not-published':
      return ` Agent tools NOT PUBLISHED: ${note}. ${list}.`;
    case 'failed':
      return ` Agent tools FAILED: ${note}. ${list}.`;
    case 'skipped':
      return ` Agent tools skipped: ${note}.`;
    default:
      return ' Agent tools: publishing now.';
  }
}
