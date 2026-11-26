import fs from 'node:fs';
import path from 'node:path';
import { readJsonDurable, writeJsonDurable } from './durable.ts';
import { prsInMessages, sameCommit, type BatchPr } from './autoDeploy.ts';
import { gitExecFileSync } from './safeGit.ts';
import type { RestartRequest } from './restart.ts';

/**
 * A portal deploy or restart announces itself (w5887, lothsahn 2026-11-26: "Please update the portal so when a new
 * deployment is starting it puts a message in all active orchestrators. You become unresponsive for 2-3 minutes during
 * updates and it would be good to know why.").
 *
 * Every restart the portal makes passes through its Drainer (restart.ts): the automatic deploy and `fffctl update` (the
 * ops worker's deploy) through deploy/vm/guest/fff-update's restart.request, `fffctl restart` and request_app_update
 * directly. When the Drainer takes one, `started` puts one system line in every active orchestrator's chat (a transcript
 * line, `store.append`: the person sees it at once and no turn opens, so an automatic deploy's drain, which waits for
 * coordinator turns, is not held up by it) and keeps the start in data/deploy-notice.json. stopServer records when the
 * server stopped; the next server's start (`booted`) records the downtime as a sample and posts the done line.
 *
 * The estimate is the median of the last restarts' measured downtimes (stop to the new server's start), never a fixed
 * guess. A notice never throws: each step is guarded and only logs, so it cannot block or delay a deploy.
 */

export const DEPLOY_NOTICE_FILE = 'deploy-notice.json';

export const DEPLOY_NOTICE_LIMITS = {
  /** Samples kept, and the most an estimate reads. */
  samples: 30,
  estimateFrom: 10,
  /** A start older than this when the next server starts is not reported done (it was something else). */
  staleMs: 6 * 60 * 60_000,
  /** A personal orchestrator is active when its chat moved within this long. */
  activeMs: 14 * 24 * 60 * 60_000,
};

/** One measured restart: when the server stopped and when the next one started. */
export interface RestartSample {
  stoppedAt: string;
  upAt: string;
  /** When the start line was posted (the drain began), when this server knew of it. */
  startedAt?: string;
  update: boolean;
  to?: string;
}

export interface PendingNotice {
  startedAt: string;
  reason: string;
  update: boolean;
  from?: string;
  to?: string;
  prs?: BatchPr[];
  estimateMinutes?: number;
  /** The sessions told. */
  told: string[];
}

export interface DeployNoticeState {
  pending?: PendingNotice;
  /** When this server began to stop (stopServer), for the next one's downtime sample. */
  stoppedAt?: string;
  samples: RestartSample[];
}

export interface DeployNoticeDeps {
  dataDir: string;
  /** The session ids of the active orchestrators (each person's, and the dispatcher's). */
  orchestrators: () => string[];
  /** One system line in a session's chat, with no turn. */
  note: (id: string, text: string) => void;
  log?: (line: string) => void;
  now?: () => number;
}

const short = (s: string | undefined) => (s ?? '?').slice(0, 9);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const minutes = (ms: number) => ms / 60_000;

/** "1.6 min", "under a minute" */
export function minutesText(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const m = minutes(ms);
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
}

/** The median downtime of the recent restarts, in whole minutes rounded up; an update prefers update samples. */
export function estimateMinutes(samples: readonly RestartSample[], update: boolean, take = DEPLOY_NOTICE_LIMITS.estimateFrom): { minutes: number; n: number } | undefined {
  const down = (s: RestartSample) => Date.parse(s.upAt) - Date.parse(s.stoppedAt);
  const ok = samples.filter((s) => Number.isFinite(down(s)) && down(s) >= 0);
  const same = ok.filter((s) => s.update === update);
  const use = (same.length >= 3 ? same : ok).slice(0, take).map(down).sort((a, b) => a - b);
  if (!use.length) return undefined;
  const mid = use.length >> 1;
  const median = use.length % 2 ? use[mid] : (use[mid - 1] + use[mid]) / 2;
  return { minutes: Math.max(1, Math.ceil(minutes(median))), n: use.length };
}

/** What is going out: "deploying 1a2b3c4d5 (#12 Title, #13 Title)", or the restart's reason. */
export function whatLine(p: Pick<PendingNotice, 'update' | 'to' | 'prs' | 'reason' | 'from'>): string {
  if (!p.update) return `restarting (${clip(p.reason, 120)})`;
  // w5887: an update to the commit that already runs (an automatic deploy asked for what fffctl update had just put out).
  if (p.from && p.to && sameCommit(p.from, p.to)) return `deploying ${short(p.to)} again, the commit it already runs`;
  const prs = (p.prs ?? []).map((x) => `#${x.number}${x.title ? ` ${clip(x.title, 60)}` : ''}`);
  const list = prs.length > 6 ? [...prs.slice(0, 6), `${prs.length - 6} more`] : prs;
  return `deploying ${p.to ? short(p.to) : 'new code'}${list.length ? ` (${list.join(', ')})` : ''}`;
}

export function startLine(p: Pick<PendingNotice, 'update' | 'to' | 'prs' | 'reason' | 'from'>, est: { minutes: number; n: number } | undefined): string {
  const how = est
    ? `about ${est.minutes} minute${est.minutes === 1 ? '' : 's'} (the median of the last ${est.n} restart${est.n === 1 ? '' : 's'}, measured)`
    : 'a few minutes (no restart of this portal measured yet)';
  return `[portal] Portal ${p.update ? 'update' : 'restart'} starting: ${whatLine(p)}. I'll be unresponsive for ${how}.`;
}

export function doneLine(p: Pick<PendingNotice, 'update' | 'startedAt'>, o: { running?: string; upAt: number; stoppedAt?: string }): string {
  const took = minutesText(o.upAt - Date.parse(p.startedAt));
  const down = o.stoppedAt ? `, down ${minutesText(o.upAt - Date.parse(o.stoppedAt))}` : '';
  return `[portal] Portal ${p.update ? 'update' : 'restart'} done: now on ${o.running ? short(o.running) : 'unknown code'}, took ${took} since the start line${down}.`;
}

/** The pull request numbers an automatic deploy's reason names: "update to <sha> (auto-deploy: #1295, #1289)". */
export function prsInReason(reason: string): BatchPr[] {
  const list = /\(auto-deploy: ([^)]*)\)/.exec(reason)?.[1] ?? '';
  return [...list.matchAll(/#(\d+)/g)].map((m) => ({ number: Number(m[1]) }));
}

/** The pull requests a deploy brings: merge commits in the prepared release between the running commit and it. */
export function prsInRelease(dir: string, from: string, to: string): BatchPr[] {
  const out = gitExecFileSync(['-C', dir, 'log', '--first-parent', '--format=%B%x00', `${from}..${to}`], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return prsInMessages(out.split('\0').map((m) => m.trim()));
}

export class DeployNotice {
  private readonly d: DeployNoticeDeps;
  private readonly file: string;
  private readonly now: () => number;
  state: DeployNoticeState = { samples: [] };

  constructor(d: DeployNoticeDeps) {
    this.d = d;
    this.file = path.join(d.dataDir, DEPLOY_NOTICE_FILE);
    this.now = d.now ?? (() => Date.now());
    try {
      const saved = readJsonDurable<DeployNoticeState>(this.file, { generations: 0 });
      if (saved && typeof saved === 'object') this.state = { ...saved, samples: Array.isArray(saved.samples) ? saved.samples : [] };
    } catch {
      // a bad file: start afresh
    }
  }

  private log(line: string) {
    (this.d.log ?? ((l: string) => console.log(l)))(`deploy notice: ${line}`);
  }

  private save() {
    writeJsonDurable(this.file, this.state, { indent: 2, generations: 0 });
  }

  private post(text: string): string[] {
    const told: string[] = [];
    let ids: string[] = [];
    try {
      ids = this.d.orchestrators();
    } catch (e) {
      this.log(`could not list the orchestrators: ${(e as Error).message}`);
    }
    for (const id of ids) {
      try {
        this.d.note(id, text);
        told.push(id);
      } catch (e) {
        this.log(`could not tell ${id}: ${(e as Error).message}`);
      }
    }
    return told;
  }

  /** The Drainer took a restart: tell every active orchestrator what goes out and for how long. Never throws. */
  started(req: Pick<RestartRequest, 'reason' | 'update'>, o: { from?: string; to?: string; prs?: BatchPr[] } = {}) {
    try {
      const to = o.to ?? /\bupdate to ([0-9a-f]{7,40})\b/i.exec(req.reason)?.[1];
      // With no titles found, the numbers fff-update put in the reason ("update to <sha> (auto-deploy: #1295, #1289)").
      const prs = o.prs?.length ? o.prs : prsInReason(req.reason);
      const p: PendingNotice = { startedAt: new Date(this.now()).toISOString(), reason: req.reason, update: req.update, ...(o.from ? { from: o.from } : {}), ...(to ? { to } : {}), ...(prs.length ? { prs } : {}), told: [] };
      const est = estimateMinutes(this.state.samples, req.update);
      if (est) p.estimateMinutes = est.minutes;
      p.told = this.post(startLine(p, est));
      this.state.pending = p;
      this.save();
      this.log(`start line to ${p.told.length} orchestrator(s): ${whatLine(p)}; estimate ${est ? `${est.minutes} min from ${est.n} sample(s)` : 'none (no sample)'}`);
    } catch (e) {
      this.log(`start: ${(e as Error).message}`);
    }
  }

  /** The drain gave up: the restart did not happen. Never throws. */
  cancelled(why: string) {
    try {
      const p = this.state.pending;
      if (!p) return;
      this.state.pending = undefined;
      this.save();
      this.post(`[portal] Portal ${p.update ? 'update' : 'restart'} cancelled: ${clip(why, 160)}. The portal stays on the code it runs.`);
    } catch (e) {
      this.log(`cancel: ${(e as Error).message}`);
    }
  }

  /** The server is stopping (stopServer): when, for the downtime. Synchronous, never throws. */
  stopping() {
    try {
      this.state.stoppedAt = new Date(this.now()).toISOString();
      this.save();
    } catch (e) {
      this.log(`stop: ${(e as Error).message}`);
    }
  }

  /**
   * The next server started: record the downtime (the stop this server knows of, or the resume file's) and, when a start
   * line went out, post the done line to the active orchestrators. Never throws.
   */
  booted(o: { running?: string; resumeAt?: string; update?: boolean }) {
    try {
      const upAt = this.now();
      const p = this.state.pending;
      const stoppedAt = this.state.stoppedAt ?? o.resumeAt;
      this.state.pending = undefined;
      this.state.stoppedAt = undefined;
      if (stoppedAt && Number.isFinite(Date.parse(stoppedAt)) && upAt - Date.parse(stoppedAt) < DEPLOY_NOTICE_LIMITS.staleMs) {
        const s: RestartSample = { stoppedAt, upAt: new Date(upAt).toISOString(), update: p?.update ?? o.update ?? false, ...(p ? { startedAt: p.startedAt } : {}), ...(o.running ? { to: o.running } : {}) };
        this.state.samples = [s, ...this.state.samples].slice(0, DEPLOY_NOTICE_LIMITS.samples);
      }
      this.save();
      if (!p) return;
      if (upAt - Date.parse(p.startedAt) > DEPLOY_NOTICE_LIMITS.staleMs) return this.log(`a start line from ${p.startedAt} is too old to report done`);
      let line = doneLine(p, { running: o.running, upAt, stoppedAt });
      if (p.update && p.to && o.running && !sameCommit(p.to, o.running)) line += ` It was to deploy ${short(p.to)}: the update did not take (fffctl logs, update.result.json).`;
      const told = this.post(line);
      this.log(`done line to ${told.length} orchestrator(s): ${line}`);
    } catch (e) {
      this.log(`boot: ${(e as Error).message}`);
    }
  }
}
