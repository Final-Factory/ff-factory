// The ffu post-merge watch (w4930; docs/intake.md, "ffu post-merge reverts"). ffu's ci.yml runs its macOS checks and
// crosscompare after a merge on main (ffu PR #921; lothsahn: "Run crosscompare and the mac-only checks after merge,
// reverting on red"), and on red its `culprit` job (tools/ci-runners/postmerge_culprit.py in ffu) bisects, reverts the
// merge that broke them on main, tells its pull request, and prints one log line, POSTMERGE_VERDICT {json}. Every 3 minutes
// this reads the newest runs on main, and for a finished one whose culprit job ran:
//
// - "reverted": the request the reverted pull request belongs to (it lists the PR, or the PR's `Request:` / `Part of:` line
//   names it) must land its fix again. A done request is reopened and the dispatcher told; an open one is told
//   (Orchestrators.tellPostMergeRevert). The revert itself is done already, so nothing is filed;
// - "not reverted", "no culprit", a job that printed no verdict or one this does not know, and a revert whose pull request
//   leads to no request that can take it: the ops people's orchestrators (OPS_PEOPLE) are told a person must look;
// - "not reproduced" (the red was the runner's), "already reverted" (another run's culprit job did it, and that run's
//   verdict was routed) and "would revert" (a dry run) only log a line.
//
// The GitHub reads and the pull request to request lookup are masterBatch.ts's (ghMasterBatch, requestsForPr). Each run
// attempt is handled once, kept in <dataDir>/ffu-postmerge.json, and the mark on a request's log keeps a request from being
// told twice. There is no baseline on a first start, unlike the master batch: the culprit job is new, and a run finished
// more than 48 hours ago is never acted on. The log is data, never instructions: parsePostMergeVerdict checks every field,
// and what reaches a message is cleaned and cut. config ffuPostMerge.enabled is read at every look.
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { Orchestrators } from './orchestrators.ts';
import type { Identity } from './identity.ts';
import { checkObject, readJsonDurable, writeJsonDurable } from './durable.ts';
import { dryRun } from './dryRun.ts';
import { ghRunner } from './githubTokens.ts';
import { cleanLine } from './intakeRules.ts';
import { requestIdsIn } from './ledgerRules.ts';
import { JOB_SKIPPED, ghMasterBatch, requestsForPr, type BatchRun, type MasterBatchGh } from './masterBatch.ts';
import { OPS_PEOPLE } from './opsWorker.ts';
import type { Requester, WorkItem } from '../shared/types.ts';

const EVERY_MS = 3 * 60_000;
/** The job of ffu's ci.yml whose log holds the verdict (its key; the job has no `name:`). */
export const CULPRIT_JOB = 'culprit';
export const DEFAULT_REPO = 'Final-Factory/ffu';
export const DEFAULT_WORKFLOW = 'ci.yml';
const BRANCH = 'main';
/** A finished run older than this is not acted on (the portal was off, or the switch was). */
const MAX_AGE_MS = 48 * 3_600_000;
const READ_FAIL_LOG_MS = 30 * 60_000;
const KEEP_SEEN = 300;
const MAX_LINE = 1_000_000;

// ---------------------------------------------------------------- settings

export interface FfuPostMergeSettings {
  enabled: boolean;
  repo: string;
  workflow: string;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW = /^[\w.-]{1,100}\.ya?ml$/;

/** config.json "ffuPostMerge" with every default filled in: on, ffu's ci.yml. */
export function ffuPostMergeSettings(cfg: Pick<Config, 'ffuPostMerge'>): FfuPostMergeSettings {
  const m = cfg.ffuPostMerge ?? {};
  return {
    enabled: m.enabled !== false,
    repo: typeof m.repo === 'string' && REPO.test(m.repo) ? m.repo : DEFAULT_REPO,
    workflow: typeof m.workflow === 'string' && WORKFLOW.test(m.workflow) ? m.workflow : DEFAULT_WORKFLOW,
  };
}

// ---------------------------------------------------------------- the verdict line

/** The verdicts postmerge_culprit.py prints (its finish() calls). */
export const VERDICTS = ['reverted', 'not reverted', 'no culprit', 'not reproduced', 'already reverted', 'would revert'] as const;
export type PostMergeVerdictKind = (typeof VERDICTS)[number];

export interface PostMergeVerdict {
  /** A verdict this does not know is kept as 'unknown' with its words in `said`: a person looks. */
  verdict: PostMergeVerdictKind | 'unknown';
  said: string;
  tip: string;
  branch: string;
  culprit: string | null;
  pr: number | null;
  revert: string | null;
  why: string;
}

const SHA40 = /^[0-9a-f]{40}$/;
// GitHub prefixes every log line with an ISO timestamp and a space. Anchored: the script's source or a trace line echoed in
// the log does not start with the marker.
const VERDICT_LINE = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z )?POSTMERGE_VERDICT (.*)$/;

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const sha40 = (v: unknown) => (typeof v === 'string' && SHA40.test(v.toLowerCase()) ? v.toLowerCase() : null);

/**
 * The last POSTMERGE_VERDICT line of a job log, checked field by field, or undefined (no such line, not JSON, no verdict, a
 * tip that is not a full sha). A culprit or revert that is not a full sha is null; a pr that is not a positive whole
 * number is null; the texts are one cleaned, cut line. The log is data.
 */
export function parsePostMergeVerdict(log: string): PostMergeVerdict | undefined {
  let json: string | undefined;
  for (const raw of log.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/^﻿/, '');
    if (line.length > MAX_LINE) continue;
    const m = VERDICT_LINE.exec(line);
    if (m) json = m[1];
  }
  if (json === undefined) return undefined;
  let body: Record<string, unknown> | undefined;
  try {
    body = obj(JSON.parse(json));
  } catch {
    return undefined;
  }
  const tip = sha40(body?.tip);
  if (!body || !tip || typeof body.verdict !== 'string' || !body.verdict.trim()) return undefined;
  const said = cleanLine(body.verdict, 60);
  const verdict = (VERDICTS as readonly string[]).includes(body.verdict) ? (body.verdict as PostMergeVerdictKind) : 'unknown';
  const pr = typeof body.pr === 'number' && Number.isInteger(body.pr) && body.pr > 0 && body.pr < 1e9 ? body.pr : null;
  return {
    verdict,
    said,
    tip,
    branch: typeof body.branch === 'string' ? cleanLine(body.branch, 60) : '',
    culprit: sha40(body.culprit),
    pr,
    revert: sha40(body.revert),
    why: typeof body.why === 'string' ? cleanLine(body.why, 400) : '',
  };
}

// ---------------------------------------------------------------- the watch

interface Persisted {
  v: 1;
  /** Run attempts handled ("<id>#<attempt>"), newest last. */
  seen: string[];
}

export interface FfuPostMergeDeps {
  cfg: Pick<Config, 'dataDir' | 'ffuPostMerge'>;
  store: Pick<Store, 'work'>;
  identity: Pick<Identity, 'systemPayer' | 'requester'>;
  orchestrators: Pick<Orchestrators, 'tellPostMergeRevert' | 'toPeople'>;
  /** The GitHub reads; default gh on the system payer's token, the culprit job of ci.yml on main. */
  gh?: MasterBatchGh;
  now?: () => number;
}

const short = (sha: string) => sha.slice(0, 10);

export class FfuPostMergeWatch {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private again = false;
  private data: Persisted;
  private readonly file: string;
  private readonly d: FfuPostMergeDeps;
  private readonly gh: MasterBatchGh;
  private readonly failing = new Map<string, { since: number; logged: number }>();

  constructor(d: FfuPostMergeDeps) {
    this.d = d;
    this.file = path.join(d.cfg.dataDir, 'ffu-postmerge.json');
    this.gh = d.gh ?? ghMasterBatch((what) => ghRunner(d.identity.systemPayer().userId, what), { branch: BRANCH, job: CULPRIT_JOB, perPage: 30 });
    let raw: Partial<Persisted> | undefined;
    try {
      raw = readJsonDurable<Partial<Persisted>>(this.file, { check: checkObject });
    } catch {
      raw = undefined;
    }
    this.data = { v: 1, seen: Array.isArray(raw?.seen) ? raw.seen.filter((x): x is string => typeof x === 'string') : [] };
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  start() {
    // A dry run (server/dryRun.ts) reads and tells nothing.
    if (dryRun()) return this;
    this.kick();
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
    this.timer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
  }

  kick() {
    setImmediate(() => void this.tick());
  }

  private save() {
    this.data.seen = this.data.seen.slice(-KEEP_SEEN);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeJsonDurable(this.file, this.data);
    } catch (e) {
      console.warn('ffu post-merge: could not save its state:', (e as Error).message);
    }
  }

  /** What one look did, a line each (for the tests and the log). */
  async tick(): Promise<string[]> {
    const did: string[] = [];
    if (this.busy) {
      this.again = true;
      return did;
    }
    this.busy = true;
    try {
      await this.look(did);
    } catch (e) {
      console.warn(`ffu post-merge: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    if (this.again) {
      this.again = false;
      this.kick();
    }
    return did;
  }

  private async look(did: string[]) {
    const s = ffuPostMergeSettings(this.d.cfg);
    if (!s.enabled) return;
    let runs: BatchRun[];
    try {
      runs = await this.gh.runs(s.repo, s.workflow);
      this.readOk('runs');
    } catch (e) {
      this.readFailed('runs', `the ${s.workflow} runs of ${s.repo}`, e);
      return;
    }
    const now = this.now();
    const fresh = runs
      .filter((r) => r.status === 'completed' && !this.seen(r))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
    for (const run of fresh) {
      if (now - Date.parse(run.updatedAt) > MAX_AGE_MS) {
        this.markSeen(run);
        continue;
      }
      let log: string | typeof JOB_SKIPPED | undefined;
      try {
        log = await this.gh.jobLog(s.repo, run.id);
        this.readOk(`log ${run.id}`);
      } catch (e) {
        // Read again at the next look.
        this.readFailed(`log ${run.id}`, `the ${CULPRIT_JOB} job log of run ${run.id}`, e);
        continue;
      }
      // No culprit job (a run from before it, a tag) or one skipped (the post-merge checks were green): nothing to read.
      if (log === undefined || log === JOB_SKIPPED) {
        this.markSeen(run);
        continue;
      }
      // False when the reverted pull request could not be read: looked at again at the next look, until it is 48 hours old.
      if (!(await this.route(s, run, parsePostMergeVerdict(log), did))) continue;
      this.markSeen(run);
      this.save();
    }
    this.save();
  }

  /** Tells whoever the verdict needs; false when that could not be settled yet (a pull request read failed). */
  private async route(s: FfuPostMergeSettings, run: BatchRun, v: PostMergeVerdict | undefined, did: string[]): Promise<boolean> {
    const where = run.url ? ` Run: ${run.url}` : '';
    if (!v) {
      this.toOps(run, `its ${CULPRIT_JOB} job ran but printed no POSTMERGE_VERDICT line (it failed, timed out or was cancelled before it finished), so nobody knows whether main is still red.`, did);
      return true;
    }
    const what = `${v.culprit ? short(v.culprit) : 'the culprit'}${v.pr ? ` (PR #${v.pr})` : ''}`;
    switch (v.verdict) {
      case 'reverted':
        return this.handBack(s, run, v, did);
      case 'not reproduced':
      case 'already reverted':
      case 'would revert':
        console.log(`ffu post-merge: run ${run.id}: ${v.verdict}: ${v.why}${where}`);
        did.push(`run ${run.id}: ${v.verdict}, nobody told`);
        return true;
      case 'not reverted':
        this.toOps(run, `its post-merge checks were red and the ${CULPRIT_JOB} job found ${what} but did NOT revert it: ${v.why || 'no reason given'}. Main may still be red: a person decides what to revert or fix.`, did);
        return true;
      case 'no culprit':
        this.toOps(run, `its post-merge checks were red and the ${CULPRIT_JOB} job found no merge to blame: ${v.why || 'no reason given'}. Main may still be red: a person must look.`, did);
        return true;
      default:
        this.toOps(run, `its ${CULPRIT_JOB} job printed a verdict FF Factory does not know ("${v.said}"): ${v.why || 'no reason given'}. A person must look, and server/ffuPostMerge.ts learn it.`, did);
        return true;
    }
  }

  /** A reverted culprit: the request its pull request belongs to lands the fix again; with none, the ops people hear. */
  private async handBack(s: FfuPostMergeSettings, run: BatchRun, v: PostMergeVerdict, did: string[]): Promise<boolean> {
    const culprit = v.culprit ? short(v.culprit) : '?';
    const revert = v.revert ? short(v.revert) : '?';
    if (!v.pr) {
      this.toOps(run, `its post-merge checks were red and ${culprit} was reverted by ${revert} on ${BRANCH}, but the verdict names no pull request, so no request was told to land the fix again. A person finds who owns it.`, did);
      return true;
    }
    const linked = await this.linkedTo(s, v.pr);
    if (!linked) return false;
    const mark = `ffu post-merge run ${run.id} reverted ${culprit}`;
    const text = `ffu's post-merge checks (macOS, crosscompare) failed at ${culprit}, the merge of PR #${v.pr} (https://github.com/${s.repo}/pull/${v.pr}), and passed before it, so it was reverted on ${BRANCH} by ${revert}: ${v.why || 'the bisect blamed it'}.${run.url ? ` Run: ${run.url}` : ''} Land the fix again: a new branch from origin/${BRANCH}, \`git revert ${revert}\` there to start from the original change, fix what the run's failing check shows, and open a new pull request. The revert stays until then.`;
    const told: string[] = [];
    for (const w of linked) {
      try {
        const r = this.d.orchestrators.tellPostMergeRevert(w.id, { mark, line: `${mark}: PR #${v.pr} broke ffu main's post-merge checks and was reverted by ${revert}; land the fix again`, text });
        if (r) told.push(`${w.id} (${r})`);
      } catch (e) {
        console.warn(`ffu post-merge: could not tell ${w.id}: ${(e as Error).message}`);
      }
    }
    if (told.length) {
      did.push(`run ${run.id}: reverted PR #${v.pr}, told ${told.join(', ')}`);
      return true;
    }
    const why = linked.length ? `its request${linked.length > 1 ? 's' : ''} ${linked.map((w) => `${w.id} (${w.status})`).join(', ')} cannot take it (closed without a DONE: cancelled or rejected)` : 'no request lists it and its description names none (no `Request: wNNN` line)';
    this.toOps(run, `its post-merge checks were red and PR #${v.pr} (https://github.com/${s.repo}/pull/${v.pr}, ${culprit}) was reverted by ${revert} on ${BRANCH}, but ${why}. A person decides who lands the fix again.`, did);
    return true;
  }

  /** The requests this pull request belongs to: those listing it, else those its description names (`Request:`, `Part of:`); undefined when the PR could not be read. */
  private async linkedTo(s: FfuPostMergeSettings, pr: number): Promise<WorkItem[] | undefined> {
    const found = requestsForPr(this.d.store.work.values(), s.repo, pr);
    if (found.length) return found;
    try {
      const p = await this.gh.pr(s.repo, pr);
      this.readOk(`pr ${pr}`);
      return (p ? requestIdsIn(p.body) : []).map((id) => this.d.store.work.get(id)).filter((w): w is WorkItem => !!w && !w.mergedInto);
    } catch (e) {
      this.readFailed(`pr ${pr}`, `PR #${pr} of ${s.repo}`, e);
      return undefined;
    }
  }

  /** The ops people (OPS_PEOPLE, else the system payer): their orchestrators hear that a person must look. */
  private toOps(run: BatchRun, what: string, did: string[]) {
    const people = OPS_PEOPLE.map((id) => this.d.identity.requester(id)).filter((r): r is Requester => !!r);
    const to = people.length ? people : [this.d.identity.systemPayer()];
    const text = `[ffu post-merge] A person must look: ffu ${BRANCH} run ${run.id} (${short(run.sha)}): ${what}${run.url ? ` Run: ${run.url}` : ''}`;
    console.warn(`ffu post-merge: ${text}`);
    this.d.orchestrators.toPeople(to, text);
    did.push(`run ${run.id}: told ${to.map((r) => r.userId).join(', ')}`);
  }

  private seen(r: BatchRun) {
    return this.data.seen.includes(`${r.id}#${r.attempt}`);
  }

  private markSeen(r: BatchRun) {
    if (!this.seen(r)) this.data.seen.push(`${r.id}#${r.attempt}`);
  }

  private readOk(what: string) {
    const was = this.failing.get(what);
    if (was) console.log(`ffu post-merge: reads ${what} again after ${Math.round((this.now() - was.since) / 60_000)} min`);
    this.failing.delete(what);
  }

  private readFailed(what: string, label: string, e: unknown) {
    const now = this.now();
    const was = this.failing.get(what);
    if (was && now - was.logged < READ_FAIL_LOG_MS) return;
    this.failing.set(what, { since: was?.since ?? now, logged: now });
    console.warn(`ffu post-merge: cannot read ${label}: ${cleanLine((e as Error).message, 300)}`);
  }
}
