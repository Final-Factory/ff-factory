import fs from 'node:fs';
import path from 'node:path';
import type { Requester } from '../shared/types.ts';
import { readJsonDurable, writeJsonDurable } from './durable.ts';
import { readUpdateResult } from './restart.ts';
import { runsState } from './blockerWatch.ts';
import type { RunOptions, RunResult } from './proc.ts';

/**
 * The automatic portal deploy (w1634, lothsahn 2026-10-20: "Can we automatically deploy the portal on updates instead of
 * waiting for confirmation?"). Every minute it compares the commit the portal runs with the head of this app's main on
 * GitHub, and deploys the head by itself, through the deploy path a person's `fffctl update` and the ops worker's deploy
 * use (data/update.wanted, deploy/vm/guest/fff-update: build beside the running release, drain, restart, verify, roll
 * back), once all of these hold (docs/ops-worker.md, "Automatic deploys"):
 *
 * - **Batching.** Main has had no new commit for `quietMinutes` (15), or the oldest commit the portal does not run has
 *   waited `maxWaitMinutes` (60), so merges that land close together go out as one deploy and a steady stream of merges
 *   cannot hold one back for long. Chosen from ff-factory's own merges (311 first-parent commits on main, 2026-10-06..20,
 *   measured): 15 minutes gives 13 deploys a day for 22 merges, a median wait of 15 minutes after a merge and 60 at most.
 * - **Green CI.** Every workflow run on the head commit finished with none failed, and the pull request it merged (a push to
 *   main runs only the secret scan and the identity check; the whole suite ran on the pull request, docs/ci.md) finished
 *   green on its head. A commit that is not a pull request's merge is not deployed by itself.
 * - **Nothing it would cut off.** No coordinator turn open (a person's orchestrator, the dispatcher, the ops worker, a
 *   standing agent on the portal), no release build declared (build_plan), no restart or update already under way, and
 *   the last machine rollout done (`busy`). The drain of the deploy then waits for coordinator turns too (restart.ts,
 *   RestartRequest.auto). Workers on the machines are not touched by the portal's restart (machines.keepAgentsOnRestart).
 *
 * One deploy at a time: after the request it waits for the outcome (the new code verified, or update.result.json's
 * failure), records it in data/auto-deploy.json (portal_logs source auto_deploy) and, once verified, tells each person
 * whose pull request went out, in one line to their own orchestrator. A commit whose deploy failed is not tried again;
 * the next one on main is. Off with config autoDeploy.enabled false (set_app_config); then deploys wait for a person, as
 * before. Asking for a deploy by hand works either way.
 */

export const AUTO_DEPLOY_FILE = 'auto-deploy.json';

export const AUTO_DEPLOY_LIMITS = {
  tickMs: 60_000,
  /** No new commit on main for this long: the batch is closed. */
  quietMinutes: 15,
  /** The oldest commit the portal does not run has waited this long: deploy what main has now, even if merges go on. */
  maxWaitMinutes: 60,
  /** How long the deploy's drain waits for busy turns (fff-update hands it to the server's restart). */
  drainMinutes: 30,
  /** A deploy with no outcome after this long is recorded as failed (its commit is not tried again). */
  outcomeMs: 90 * 60_000,
  history: 50,
};

export interface BatchPr {
  number: number;
  title?: string;
}

/** What a commit's CI says for a deploy: green to go, running to wait, red to hold (with the text, logged). */
export interface CiVerdict {
  state: 'green' | 'running' | 'red';
  text: string;
  /** red because the commit's own workflow runs failed (w2140): which ("Windows tests: failure"). */
  failed?: string;
  /** The pull requests the commit merged, when read. */
  prs?: number[];
}

/**
 * The deploy held because CI failed on the head of main (w2140): nothing deploys, so every request blocked on a portal
 * deploy or a machine's update waits until a fix lands. Told on every pass while it holds (`held`); the one told keeps
 * its own "said it once".
 */
export interface DeployHold {
  sha: string;
  /** The failed runs, "Windows tests: failure". */
  workflows: string;
  /** The pull requests the head merged (whose worker is resumed to fix it). */
  prs: number[];
  since: string;
}

/** What a request blocked on a deploy says while the deploy is held (w2140). */
export function heldLine(h: Pick<DeployHold, 'sha' | 'workflows'>): string {
  return `deploy held: master CI failed on ${short(h.sha)} (${h.workflows})`;
}

export interface AutoDeployGithub {
  /** The full commit at the head of main. */
  head(): Promise<string>;
  ci(sha: string): Promise<CiVerdict>;
  /** The pull requests merged between the two commits (the batch), for the record and the people's lines. */
  prsBetween(from: string, to: string): Promise<BatchPr[]>;
}

export interface AutoDeployDeps {
  dataDir: string;
  /** Config autoDeploy.enabled (default on), on the portal VM only, never in a dry run. */
  enabled: () => boolean;
  settings?: () => { quietMinutes?: number; maxWaitMinutes?: number; drainMinutes?: number };
  /** The commit this portal runs (version.ts appVersion: short). */
  running: () => string | undefined;
  github: AutoDeployGithub;
  /** What a deploy now would cut off, in words; empty when nothing. */
  busy: () => Promise<string[]> | string[];
  /** Ask for the deploy: data/update.wanted with this commit (restart.ts writeUpdateWanted). */
  request: (o: { ref: string; reason: string; drainMinutes: number }) => void;
  /** The people of the ledger requests a pull request of this app belongs to. */
  peopleOf: (pr: number) => Requester[];
  /** One line to a person's own orchestrator. */
  tell: (person: Requester, text: string) => void;
  /** w2140: the deploy is held on failed CI of the head (every pass while it holds; the receiver says it once). */
  held?: (hold: DeployHold) => void;
  now?: () => number;
  log?: (line: string) => void;
  limits?: Partial<typeof AUTO_DEPLOY_LIMITS>;
}

export interface DeployRecord {
  /** The commit asked for (full). */
  sha: string;
  /** The commit the portal ran when it was asked for. */
  from?: string;
  requestedAt: string;
  prs: BatchPr[];
  /** Why it went now: the batch closed, or the longest wait was reached. */
  why: string;
  outcome?: 'deployed' | 'failed';
  outcomeAt?: string;
  /** The commit the portal runs after it (a deploy by hand in between can bring a newer one). */
  deployed?: string;
  note?: string;
  /** The people told, by user id. */
  told?: string[];
}

export interface AutoDeployState {
  /** The head of main as last read, and when it was first seen. */
  head?: { sha: string; seenAt: string };
  /** When a head the portal does not run was first seen (the longest wait counts from here). */
  waitingSince?: string;
  /** The deploy asked for and not settled yet. */
  requested?: DeployRecord;
  /** Commits whose deploy failed: not tried again (the next commit on main is). */
  failed: string[];
  /** What it waits for now, in words (logged when it changes). */
  waiting?: string;
  /** w2140: held because CI failed on the head of main. */
  held?: DeployHold;
  /** Newest first. */
  history: DeployRecord[];
}

const short = (s: string | undefined) => (s ?? '?').slice(0, 9);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Two commits are the same when the shorter is a prefix of the longer (the portal knows its own commit short). */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** One line for a person about their pull requests in a deploy (w1634). */
export function deployedLine(prs: readonly BatchPr[], sha: string): string {
  const list = prs.map((p) => `#${p.number}${p.title ? ` (${clip(p.title, 70)})` : ''}`).join(', ');
  return `[portal deploy] Your FF Factory pull request${prs.length > 1 ? 's' : ''} ${list} ${prs.length > 1 ? 'are' : 'is'} live: the portal deployed ${short(sha)} by itself (automatic deploy, w1634).`;
}

export class AutoDeploy {
  private readonly d: AutoDeployDeps;
  private readonly now: () => number;
  private readonly lim: typeof AUTO_DEPLOY_LIMITS;
  private readonly file: string;
  state: AutoDeployState = { failed: [], history: [] };
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(d: AutoDeployDeps) {
    this.d = d;
    this.now = d.now ?? (() => Date.now());
    this.lim = { ...AUTO_DEPLOY_LIMITS, ...d.limits };
    this.file = path.join(d.dataDir, AUTO_DEPLOY_FILE);
    const saved = readJsonDurable<AutoDeployState>(this.file, { generations: 0 });
    if (saved && typeof saved === 'object') this.state = { ...saved, failed: saved.failed ?? [], history: saved.history ?? [] };
  }

  start(): this {
    this.timer = setInterval(() => void this.tick(), this.lim.tickMs);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 20_000).unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
  }

  /** Whether an automatic deploy was asked for and has not settled: its drain waits for coordinator turns too. */
  pending(): boolean {
    return !!this.state.requested;
  }

  private log(line: string) {
    (this.d.log ?? ((l: string) => console.log(l)))(`auto-deploy: ${line}`);
  }

  private save() {
    try {
      writeJsonDurable(this.file, this.state, { indent: 2, generations: 0 });
    } catch (e) {
      this.log(`could not save its state: ${(e as Error).message}`);
    }
  }

  /** What it waits for, logged once per change. */
  private wait(why: string | undefined) {
    if (why === this.state.waiting) return;
    this.state.waiting = why;
    this.save();
    if (why) this.log(`waiting: ${why}`);
  }

  private settings() {
    const s = this.d.settings?.() ?? {};
    const num = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
    return { quiet: num(s.quietMinutes, this.lim.quietMinutes), maxWait: num(s.maxWaitMinutes, this.lim.maxWaitMinutes), drain: Math.min(60, num(s.drainMinutes, this.lim.drainMinutes)) };
  }

  /** One pass. Exported through the class for tests; the timer calls it every minute. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass();
    } catch (e) {
      this.wait(`a pass failed: ${clip((e as Error).message, 200)}`);
    } finally {
      this.running = false;
    }
  }

  private async pass() {
    const running = this.d.running();
    // The outcome of a deploy asked for is recorded even while it is off: it was asked for while on.
    if (this.state.requested) {
      this.settle(running);
      if (this.state.requested) return;
    }
    if (!this.d.enabled()) return this.wait('off (config autoDeploy.enabled is false): deploys wait for a person');
    if (!running) return this.wait('the commit this portal runs is unknown');
    const head = (await this.d.github.head()).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`the head of main is not a commit (${clip(head, 60)})`);
    const now = this.now();
    if (sameCommit(running, head)) {
      this.hold(undefined);
      if (this.state.waitingSince || this.state.head?.sha !== head) {
        this.state.waitingSince = undefined;
        this.state.head = { sha: head, seenAt: new Date(now).toISOString() };
        this.save();
      }
      return this.wait(undefined);
    }
    if (this.state.head?.sha !== head) {
      this.state.head = { sha: head, seenAt: new Date(now).toISOString() };
      this.state.waitingSince ??= this.state.head.seenAt;
      this.save();
    }
    if (this.state.failed.some((f) => sameCommit(f, head))) return this.wait(`the deploy of ${short(head)} failed; the next commit on main is deployed`);
    const { quiet, maxWait, drain } = this.settings();
    const quietFor = now - Date.parse(this.state.head.seenAt);
    const waited = now - Date.parse(this.state.waitingSince ?? this.state.head.seenAt);
    const batchClosed = quietFor >= quiet * 60_000;
    const longest = waited >= maxWait * 60_000;
    if (!batchClosed && !longest) {
      return this.wait(`batching: main moved to ${short(head)} ${Math.floor(quietFor / 60_000)} min ago; it goes out after ${quiet} min with no new merge, or ${maxWait} min after the first commit the portal does not run`);
    }
    const ci = await this.d.github.ci(head);
    this.hold(ci.state === 'red' && ci.failed ? { sha: head, workflows: ci.failed, prs: ci.prs ?? [], since: this.state.held?.sha === head ? this.state.held.since : new Date(now).toISOString() } : undefined);
    if (ci.state !== 'green') return this.wait(`CI of ${short(head)}: ${ci.text}`);
    const busy = await this.d.busy();
    if (busy.length) return this.wait(`not now, it would cut off: ${busy.join('; ')}`);
    const prs = await this.d.github.prsBetween(running, head).catch(() => [] as BatchPr[]);
    const why = batchClosed ? `no new merge for ${Math.floor(quietFor / 60_000)} min` : `the first commit waited ${Math.floor(waited / 60_000)} min`;
    const reason = `auto-deploy${prs.length ? `: ${prs.map((p) => `#${p.number}`).join(', ')}` : ''}`;
    this.d.request({ ref: head, reason, drainMinutes: drain });
    this.state.requested = { sha: head, from: running, requestedAt: new Date(now).toISOString(), prs, why };
    this.state.waiting = undefined;
    this.save();
    this.log(`deploying ${head.slice(0, 12)} (from ${running}; ${why}; CI green: ${ci.text}; pull requests ${prs.map((p) => `#${p.number}`).join(', ') || 'none found'})`);
  }

  /** w2140: record a hold on failed CI (or its end), and tell the requests it holds up on every pass while it holds. */
  private hold(h: DeployHold | undefined) {
    const was = this.state.held;
    if (h?.sha !== was?.sha || h?.workflows !== was?.workflows) {
      this.state.held = h;
      this.save();
      if (h) this.log(`held: ${heldLine(h)}; the requests blocked on a deploy are told, and the worker that merged it is resumed to fix it`);
      else if (was) this.log(`no longer held on the failed CI of ${short(was.sha)}`);
    }
    if (!h) return;
    try {
      this.d.held?.(h);
    } catch (e) {
      this.log(`could not tell the requests the deploy holds up: ${(e as Error).message}`);
    }
  }

  /** The verification marker fff-update writes (data/update.verified.json; the machine rollout renames it .done). */
  private verifiedSince(since: number): string | undefined {
    for (const f of ['update.verified.json', 'update.verified.done.json']) {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(this.d.dataDir, f), 'utf8').replace(/^﻿/, '')) as { sha?: string; at?: string };
        if (v.sha && Date.parse(v.at ?? '') >= since) return v.sha;
      } catch {
        // absent or being written
      }
    }
    return undefined;
  }

  /** Record how the deploy asked for ended, once it has. */
  private settle(running: string | undefined) {
    const r = this.state.requested!;
    const at = Date.parse(r.requestedAt);
    const verified = this.verifiedSince(at);
    const result = readUpdateResult(this.d.dataDir, r.requestedAt);
    if (verified && sameCommit(running, verified)) return this.finish('deployed', verified, sameCommit(verified, r.sha) ? undefined : `the portal went to ${short(verified)} (a newer deploy in between)`);
    if (result && !result.ok) return this.finish('failed', undefined, result.error ?? 'the update failed (update.result.json)');
    if (this.now() - at > this.lim.outcomeMs) {
      if (sameCommit(running, r.sha)) return this.finish('deployed', running, 'running it, but no verification was seen');
      return this.finish('failed', undefined, `no outcome within ${Math.round(this.lim.outcomeMs / 60_000)} min (journalctl -u fff-update in the VM)`);
    }
  }

  private finish(outcome: 'deployed' | 'failed', deployed: string | undefined, note: string | undefined) {
    const r: DeployRecord = { ...this.state.requested!, outcome, outcomeAt: new Date(this.now()).toISOString(), ...(deployed ? { deployed } : {}), ...(note ? { note } : {}) };
    this.state.requested = undefined;
    if (outcome === 'failed') {
      this.state.failed = [r.sha, ...this.state.failed.filter((f) => f !== r.sha)].slice(0, 20);
      this.log(`the deploy of ${r.sha.slice(0, 12)} failed: ${note}; it is not tried again, the next commit on main is`);
    } else {
      this.state.waitingSince = undefined;
      r.told = this.tellPeople(r);
      this.log(`deployed ${(deployed ?? r.sha).slice(0, 12)} (asked for at ${r.requestedAt}, from ${r.from ?? '?'})${note ? `: ${note}` : ''}; told ${r.told.join(', ') || 'nobody (no ledger request names its pull requests)'}`);
    }
    this.state.history = [r, ...this.state.history].slice(0, this.lim.history);
    this.save();
  }

  /** One line to each person whose pull request went out, to their own orchestrator. */
  private tellPeople(r: DeployRecord): string[] {
    const by = new Map<string, { person: Requester; prs: BatchPr[] }>();
    for (const p of r.prs) {
      for (const person of this.d.peopleOf(p.number)) {
        const k = person.userId.toLowerCase();
        const e = by.get(k) ?? { person, prs: [] };
        if (!e.prs.some((x) => x.number === p.number)) e.prs.push(p);
        by.set(k, e);
      }
    }
    for (const { person, prs } of by.values()) {
      try {
        this.d.tell(person, deployedLine(prs, r.deployed ?? r.sha));
      } catch (e) {
        this.log(`could not tell ${person.userId}: ${(e as Error).message}`);
      }
    }
    return [...by.values()].map((e) => e.person.userId);
  }
}

// ---------------------------------------------------------------- GitHub, through gh

type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
const GH_OPTS = { timeoutMs: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } };
const said = (r: RunResult) => clip((r.stderr || r.stdout || `exit ${r.code}`).replace(/\s+/g, ' ').trim(), 200);

/** The pull request numbers and titles in merge commits' messages ("Merge pull request #12 from x/y\n\nTitle"). */
export function prsInMessages(messages: readonly string[]): BatchPr[] {
  const out: BatchPr[] = [];
  for (const m of messages) {
    const x = /^Merge pull request #(\d+) from \S+(?:\r?\n\r?\n([^\r\n]+))?/.exec(m);
    if (x && !out.some((p) => p.number === Number(x[1]))) out.push({ number: Number(x[1]), ...(x[2] ? { title: x[2].trim() } : {}) });
  }
  return out;
}

/** GitHub as the automatic deploy reads it: Contents and Actions read, and Pull requests read (the portal's token). */
export function ghAutoDeploy(repo: () => Promise<string | undefined>, branch: string, run: Runner): AutoDeployGithub {
  const slug = async () => {
    const r = await repo();
    if (!r) throw new Error("this app's GitHub repo is unknown (its checkout has no github.com origin; config autoDeploy.repo)");
    return r;
  };
  const runs = async (s: string, sha: string) => {
    const a = await run('gh', ['api', `repos/${s}/actions/runs?head_sha=${sha}&per_page=100`], GH_OPTS);
    if (a.code !== 0) throw new Error(`the workflow runs of ${short(sha)} cannot be read: ${said(a)}`);
    return runsState(JSON.parse(a.stdout) as Parameters<typeof runsState>[0], short(sha));
  };
  return {
    async head() {
      const s = await slug();
      const r = await run('gh', ['api', `repos/${s}/commits/${branch}`, '--jq', '.sha'], GH_OPTS);
      if (r.code !== 0) throw new Error(`the head of ${s} ${branch} cannot be read: ${said(r)}`);
      return r.stdout.trim();
    },
    async ci(sha) {
      const s = await slug();
      const own = await runs(s, sha);
      if (own.none) return { state: 'running', text: 'no workflow run on it yet' };
      if (!own.done) return { state: 'running', text: own.text };
      const pulls = async () => {
        const p = await run('gh', ['api', `repos/${s}/commits/${sha}/pulls`, '--jq', '[.[] | select(.merged_at != null) | {number: .number, head: .head.sha}]'], GH_OPTS);
        if (p.code !== 0) throw new Error(`the pull request of ${short(sha)} cannot be read: ${said(p)}`);
        return JSON.parse(p.stdout || '[]') as { number: number; head: string }[];
      };
      if (/failed/.test(own.text)) {
        // w2140: which runs failed and which pull request the commit merged, for the requests the hold keeps waiting.
        const merged = await pulls().catch(() => []);
        return { state: 'red', text: own.text, ...(own.failed ? { failed: own.failed } : {}), prs: merged.map((x) => x.number) };
      }
      const prs = await pulls();
      if (!prs.length) return { state: 'red', text: `${short(sha)} is not the merge of a pull request, so it is not deployed by itself (a person deploys it by hand)` };
      for (const pr of prs) {
        const c = await runs(s, pr.head);
        if (c.none || !c.done) return { state: 'running', text: `pull request #${pr.number}: ${c.text}` };
        if (/failed/.test(c.text)) return { state: 'red', text: `pull request #${pr.number}: ${c.text}` };
      }
      return { state: 'green', text: `${own.text}; pull request ${prs.map((x) => `#${x.number}`).join(', ')} green on its head` };
    },
    async prsBetween(from, to) {
      const s = await slug();
      const r = await run('gh', ['api', `repos/${s}/compare/${from}...${to}`, '--jq', '[.commits[].commit.message]'], GH_OPTS);
      if (r.code !== 0) throw new Error(`compare ${short(from)}...${short(to)}: ${said(r)}`);
      return prsInMessages(JSON.parse(r.stdout || '[]') as string[]);
    },
  };
}
