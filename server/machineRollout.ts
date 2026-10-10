import fs from 'node:fs';
import path from 'node:path';
import type { Requester } from '../shared/types.ts';
import { readJsonDurable, writeJsonDurable } from './durable.ts';
import { daemonBehind } from './machines.ts';
import { SAFE_ROOT, SAFE_TARGET, workerUpdateRemote } from './opsWorker.ts';

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
 */

/** The marker fff-update writes when a deploy verified, and where the rollout keeps its state (both in the data folder). */
export const VERIFIED_FILE = 'update.verified.json';
export const ROLLOUT_FILE = 'machine-rollout.json';

export const ROLLOUT_LIMITS = {
  /** One installer run over ssh (npm ci on a slow machine included). */
  installMs: 15 * 60_000,
  /** After a failed run, how long the machine gets to be seen online before it counts as left without a daemon. */
  settleMs: 90_000,
  /** The main report waits this long after the verification for machines that are only reconnecting to the new portal. */
  graceMs: 10 * 60_000,
  /** A verified marker older than this is retired without a rollout (stale, e.g. restored data). */
  staleMarkerMs: 24 * 3_600_000,
  tickMs: 30_000,
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
  /** Send the report to a person's orchestrator, or (no person) the dispatcher. */
  tell(person: Requester | undefined, text: string): void;
  /** Who asked for the deploy that verified at this time (epoch ms), if anyone did through the ops worker. */
  requesterOf(verifiedAt: number): Requester | undefined;
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
}

export interface RolloutState {
  sha?: string;
  previous?: string;
  verifiedAt?: string;
  by?: Requester;
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<typeof ROLLOUT_LIMITS>;
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
    for (const o of Object.values(this.state.machines)) if (o.status === 'updating') Object.assign(o, { status: 'pending', note: 'the portal restarted during its update; looked at again' });
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
      this.state = { sha, previous: v?.previous || undefined, verifiedAt: new Date(at).toISOString(), ...(by ? { by } : {}), machines: {} };
      this.save();
      console.log(`machine rollout: portal ${sha.slice(0, 9)} verified${by ? ` (deploy asked for by ${by.userId})` : ''}; updating the machines' daemons`);
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
        if (o.status !== 'pending') continue;
        if (m.local) {
          Object.assign(o, { status: 'skipped', note: "the portal's own host: the portal runs its daemon itself" });
        } else if (!m.root) {
          Object.assign(o, { status: 'skipped', note: 'not a worker root install: updated another way (the portal redeploys it itself once idle)' });
        } else if (!SAFE_TARGET.test(m.target) || !SAFE_ROOT.test(m.root) || /\s/.test(m.root)) {
          Object.assign(o, { status: 'skipped', note: 'its ssh target or root folder has characters this will not pass to a shell' });
        } else if (!this.d.host.online(m.id)) {
          o.note = 'offline';
          continue;
        } else if (!this.needsUpdate(m.id, sha)) {
          Object.assign(o, { status: 'current', before: this.d.host.daemon(m.id), after: this.d.host.daemon(m.id), at: new Date(this.now()).toISOString() });
        } else {
          await this.updateOne(m, o, sha);
        }
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

  private needsUpdate(id: string, sha: string): boolean {
    return !!this.d.host.outdated(id) || !!daemonBehind({ daemon: this.d.host.daemon(id) }, sha);
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
    console.log(`machine rollout: updating ${m.id} (${before ?? 'unknown'} -> ${sha.slice(0, 9)}; ${agentsBefore.length} agent(s) alive)`);
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
      : o.status === 'current' ? `already on the deployed commit (${o.after?.slice(0, 9) ?? 'unknown'}); nothing to do.`
      : o.status === 'failed' ? `FAILED: ${o.note}.${commits}${limits}${agents}${o.rollback ? ` Rollback: ${o.rollback}.` : ''}`
      : o.status === 'skipped' ? `skipped: ${o.note}.`
      : o.status === 'updating' ? 'updating now.'
      : `waiting: ${o.note ?? 'not online'}. It is updated when it next comes online.`;
    return `- ${id}: ${head}${sums.length ? `\n${sums.join('\n')}` : ''}`;
  }

  /** The main report when every machine is settled (or only offline ones remain after the grace period), then follow-ups. */
  private report() {
    const s = this.state;
    if (!s.sha) return;
    const entries = Object.entries(s.machines);
    const settled = (o: MachineOutcome) => o.status !== 'pending' && o.status !== 'updating';
    const open = entries.filter(([, o]) => !settled(o));
    const graceOver = this.now() - Date.parse(s.verifiedAt ?? '') >= this.lim.graceMs;
    const tail = 'The deploy approval covers these updates; nothing is needed from anyone unless a line above says FAILED or OFFLINE. Tell the user in a line if it does.';
    if (!s.reported) {
      if (entries.some(([, o]) => o.status === 'updating')) return;
      if (open.length && !graceOver) return;
      const head = `[machine updates] Portal ${s.sha.slice(0, 9)}${s.previous ? ` (was ${s.previous.slice(0, 9)})` : ''} deployed and verified, so FF Factory updated the machines' daemons by itself (agents keep running through an update: no drain, no waiting).`;
      const body = entries.map(([id, o]) => this.line(id, o)).join('\n');
      this.send(`${head}\n${body}\n${tail}`);
      s.reported = true;
      for (const [, o] of entries) if (settled(o)) o.told = true;
      this.save();
      return;
    }
    const fresh = entries.filter(([, o]) => !o.told && settled(o));
    if (!fresh.length) return;
    this.send(`[machine updates] Follow-up for portal ${s.sha.slice(0, 9)}: ${fresh.length === 1 ? 'a machine that was offline' : 'machines that were offline'} now settled.\n${fresh.map(([id, o]) => this.line(id, o)).join('\n')}\n${tail}`);
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
