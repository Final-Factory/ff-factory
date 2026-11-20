// The CI side of the per-test history (w4922, docs/test-history.md): every few minutes, the game repo's newest test
// artifacts go into the database (server/testHistory.ts), newest first, then back to config testHistory.backfillDays.
// - "Test results for editmode" (main.yml, every Test in editmode job): editmode-results.xml, the merge gate's selection on a
//   pull request, the whole suite on a release's push;
// - "Master batch results" (master-batch.yml): 00-full.xml and 00-full-smoke.xml at the batch tip, verdict.json (which
//   labels its failures) and coverage.json (each test class and the types it names, from test_select.py).
// CI itself does nothing new for this: the artifacts were there already (the master batch's coverage.json costs it 1 to 5 s).
// Reads use the system payer's GitHub token, as the master batch watch does (the portal's own login has no "Actions: read").
// Then the labeller runs (labelFailures), with GitHub's compare for what a pull request changed between two heads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Identity } from './identity.ts';
import type { RunResult } from './proc.ts';
import { ghRunner } from './githubTokens.ts';
import { labelFailures, parseNunit, type RunInfo, type Source, type TestCase, type TestHistory } from './testHistory.ts';

type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => Promise<RunResult>;

export const EDITMODE_ARTIFACT = 'Test results for editmode';
export const BATCH_ARTIFACT = 'Master batch results';
const EVERY_MS = 5 * 60_000;
/** Downloads per look: a backfill moves on a few at a time and never takes the portal's time or GitHub's budget. */
const DOWNLOADS_PER_LOOK = 12;
const PAGES_PER_LOOK = 10;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface TestHistorySettings {
  enabled: boolean;
  repo: string;
  backfillDays: number;
}

export function testHistorySettings(cfg: Pick<Config, 'testHistory'>): TestHistorySettings {
  const t = cfg.testHistory ?? {};
  const days = t.backfillDays;
  return {
    enabled: t.enabled !== false,
    repo: typeof t.repo === 'string' && REPO.test(t.repo) ? t.repo : 'Final-Factory/FinalFactory',
    backfillDays: typeof days === 'number' && Number.isFinite(days) ? Math.min(90, Math.max(0, Math.round(days))) : 21,
  };
}

export interface ArtifactRef {
  id: number;
  name: string;
  created: string;
  expired: boolean;
  runId: number;
  sha: string;
  branch: string;
}

export interface RunMeta {
  event: string;
  attempt: number;
  prs: number[];
  url: string;
  status: string;
}

export interface TestHistoryGh {
  artifacts(repo: string, name: string, page: number): Promise<ArtifactRef[]>;
  run(repo: string, runId: number): Promise<RunMeta>;
  /** Download and unpack one artifact of a run into dir. */
  download(repo: string, runId: number, name: string, dir: string): Promise<void>;
  /** A ref's own diff against master: each changed file's blob sha ("" when deleted), or undefined past GitHub's 300 files. */
  diff(repo: string, sha: string): Promise<Map<string, string> | undefined>;
}

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined);
const said = (r: RunResult) => (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n')[0]!.slice(0, 200);

export function ghTestHistory(runnerFor: (what: string) => Runner): TestHistoryGh {
  const api = async (what: string, p: string, timeoutMs = 30_000) => {
    const r = await runnerFor(what)('gh', ['api', p], { timeoutMs });
    if (r.code !== 0) throw new Error(`gh api ${p}: ${said(r)}`);
    return JSON.parse(r.stdout) as unknown;
  };
  return {
    artifacts: async (repo, name, page) => {
      const j = obj(await api(`the ${name} artifacts of ${repo}`, `repos/${repo}/actions/artifacts?per_page=100&page=${page}&name=${encodeURIComponent(name)}`));
      const list = Array.isArray(j?.artifacts) ? j.artifacts : [];
      return list.map(obj).flatMap((a) => {
        const run = obj(a?.workflow_run);
        if (!a || typeof a.id !== 'number' || typeof run?.id !== 'number') return [];
        return [{ id: a.id, name: String(a.name), created: String(a.created_at), expired: a.expired === true, runId: run.id, sha: String(run.head_sha ?? ''), branch: String(run.head_branch ?? '') }];
      });
    },
    run: async (repo, runId) => {
      const j = obj(await api(`run ${runId} of ${repo}`, `repos/${repo}/actions/runs/${runId}`));
      const prs = (Array.isArray(j?.pull_requests) ? j.pull_requests : []).map((p) => obj(p)?.number).filter((n): n is number => typeof n === 'number');
      return { event: String(j?.event ?? ''), attempt: Number(j?.run_attempt ?? 1) || 1, prs, url: String(j?.html_url ?? ''), status: String(j?.status ?? '') };
    },
    download: async (repo, runId, name, dir) => {
      const r = await runnerFor(`the ${name} artifact of run ${runId} of ${repo}`)('gh', ['run', 'download', String(runId), '-R', repo, '-n', name, '-D', dir], { timeoutMs: 180_000 });
      if (r.code !== 0) throw new Error(`gh run download ${runId}: ${said(r)}`);
    },
    diff: async (repo, sha) => {
      const j = obj(await api(`what ${sha.slice(0, 9)} changes in ${repo}`, `repos/${repo}/compare/master...${sha}?per_page=300`, 60_000));
      const files = Array.isArray(j?.files) ? j.files.map(obj) : [];
      if (files.length >= 300) return undefined;
      return new Map(files.flatMap((f) => (typeof f?.filename === 'string' ? [[f.filename, f.status === 'removed' ? '' : String(f.sha ?? '')] as [string, string]] : [])));
    },
  };
}

/** The files two heads of one pull request differ in, as their own diffs against master show (undefined: unreadable). */
export function prDiffFrom(gh: Pick<TestHistoryGh, 'diff'>) {
  const cache = new Map<string, Promise<Map<string, string> | undefined>>();
  const diffOf = (repo: string, sha: string) => {
    const k = `${repo}@${sha}`;
    let p = cache.get(k);
    if (!p) {
      p = gh.diff(repo, sha).catch(() => undefined);
      cache.set(k, p);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
    }
    return p;
  };
  return async (repo: string, a: string, b: string): Promise<string[] | undefined> => {
    const [da, db] = await Promise.all([diffOf(repo, a), diffOf(repo, b)]);
    if (!da || !db) return undefined;
    const out = new Set<string>();
    for (const [f, s] of da) if (db.get(f) !== s) out.add(f);
    for (const f of db.keys()) if (!da.has(f)) out.add(f);
    return [...out].sort();
  };
}

/** The source of an editmode artifact's run: a pull request's merge gate, a release's push to master, or something else. */
export function sourceOf(event: string, branch: string): Source {
  if (event === 'pull_request' || event === 'pull_request_target') return 'pr-gate';
  if (event === 'push' && branch === 'master') return 'release';
  return 'ci-other';
}

const readIf = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined);

/** Ingest one downloaded artifact folder; answers how many test cases it brought. */
export function ingestArtifact(h: TestHistory, repo: string, a: ArtifactRef, meta: RunMeta, dir: string): number {
  const base: Omit<RunInfo, 'source' | 'key' | 'mode'> = {
    repo, ciRun: a.runId, attempt: meta.attempt, sha: a.sha, branch: a.branch, finished: new Date(a.created).toISOString(), url: meta.url,
    ...(meta.prs.length ? { pr: meta.prs[0] } : {}),
  };
  if (a.name === EDITMODE_ARTIFACT) {
    const xml = readIf(path.join(dir, 'editmode-results.xml'));
    if (!xml) return 0;
    const tests = parseNunit(xml);
    h.addRun({ ...base, source: sourceOf(meta.event, a.branch), key: `gh:${a.id}`, mode: 'EditMode' }, tests);
    return tests.length;
  }
  // The master batch: its tip's full run, the smoke PlayMode test, its verdict and the coverage map.
  let verdict: Record<string, unknown> | undefined;
  try {
    verdict = obj(JSON.parse(readIf(path.join(dir, 'verdict.json')) ?? 'null'));
  } catch {
    verdict = undefined;
  }
  const tip = typeof verdict?.tip === 'string' ? verdict.tip : a.sha;
  let n = 0;
  for (const [file, mode] of [['00-full.xml', 'EditMode'], ['00-full-smoke.xml', 'PlayMode']] as const) {
    const xml = readIf(path.join(dir, file));
    if (!xml) continue;
    const tests: TestCase[] = parseNunit(xml);
    const { runId } = h.addRun({ ...base, sha: tip, source: 'master-batch', key: `gh:${a.id}:${file}`, mode, ...(typeof verdict?.verdict === 'string' ? { verdict: verdict.verdict } : {}) }, tests);
    if (verdict) h.applyBatchVerdict(runId, verdict);
    n += tests.length;
  }
  try {
    const cov = obj(JSON.parse(readIf(path.join(dir, 'coverage.json')) ?? 'null'));
    // The newest coverage wins; an older batch's (a backfill) never replaces it.
    if (cov && typeof cov.sha === 'string' && obj(cov.classes) && a.created >= (h.meta('coverage_created') ?? '')) {
      h.setCoverage(cov.sha, obj(cov.classes)!);
      h.setMeta('coverage_created', a.created);
    }
  } catch {
    /* an unreadable coverage.json leaves the last one */
  }
  return n;
}

export interface TestHistoryCiDeps {
  cfg: Pick<Config, 'dataDir' | 'testHistory'>;
  history: TestHistory;
  identity?: Pick<Identity, 'systemPayer'>;
  gh?: TestHistoryGh;
  now?: () => number;
  log?: (line: string) => void;
}

export class TestHistoryCi {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly d: TestHistoryCiDeps;
  private readonly gh: TestHistoryGh;
  private readonly prDiff: ReturnType<typeof prDiffFrom>;
  private lastError = '';

  constructor(d: TestHistoryCiDeps) {
    this.d = d;
    this.gh = d.gh ?? ghTestHistory((what) => ghRunner(d.identity?.systemPayer().userId, what) as Runner);
    this.prDiff = prDiffFrom(this.gh);
  }

  start() {
    this.timer = setInterval(() => void this.look(), EVERY_MS);
    this.timer.unref?.();
    setTimeout(() => void this.look(), 30_000).unref?.();
    return this;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One look: new and backfill artifacts (a few), then the labeller. Answers what it did, for the log and tests. */
  async look(): Promise<{ ingested: number; tests: number; labelled: number } | undefined> {
    const s = testHistorySettings(this.d.cfg);
    if (!s.enabled || this.busy) return undefined;
    this.busy = true;
    const now = (this.d.now ?? Date.now)();
    const h = this.d.history;
    let ingested = 0;
    let tests = 0;
    let labelled = 0;
    try {
      const cutoff = new Date(now - s.backfillDays * 86_400_000).toISOString();
      let budget = DOWNLOADS_PER_LOOK;
      for (const name of [BATCH_ARTIFACT, EDITMODE_ARTIFACT]) {
        // Half the downloads each, so a backfill of one never starves the other's new runs.
        let mine = name === BATCH_ARTIFACT ? Math.ceil(budget / 2) : budget;
        for (let page = 1; page <= PAGES_PER_LOOK && mine > 0; page++) {
          const list = await this.gh.artifacts(s.repo, name, page);
          if (!list.length) break;
          let older = false;
          for (const a of list) {
            if (a.created < cutoff) {
              older = true;
              break;
            }
            if (a.expired || h.ciSeen(a.id)) continue;
            if (mine <= 0) break;
            mine--;
            budget--;
            const got = await this.one(s.repo, a);
            if (got !== undefined) {
              ingested++;
              tests += got;
            }
          }
          if (older) {
            if (!h.meta(`ci_oldest_done:${name}`)) h.setMeta(`ci_oldest_done:${name}`, cutoff);
            break;
          }
        }
      }
      const oldest = h.all("SELECT min(finished) AS f FROM runs WHERE source <> 'local'")[0]?.f;
      if (typeof oldest === 'string') h.setMeta('ci_oldest', oldest);
      labelled = await labelFailures(h, this.prDiff, now);
      h.prune();
      if (ingested || labelled) this.d.log?.(`test history: ${ingested} CI artifacts (${tests} test results), ${labelled} failures labelled`);
      this.lastError = '';
      return { ingested, tests, labelled };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== this.lastError) this.d.log?.(`test history: CI read failed: ${msg}`);
      this.lastError = msg;
      return { ingested, tests, labelled };
    } finally {
      this.busy = false;
    }
  }

  /** Download, ingest and forget one artifact; undefined (and marked, so it is not tried for ever) when it could not be read. */
  private async one(repo: string, a: ArtifactRef): Promise<number | undefined> {
    const h = this.d.history;
    const dir = fs.mkdtempSync(path.join(fs.existsSync(this.d.cfg.dataDir) ? this.d.cfg.dataDir : os.tmpdir(), 'test-history-dl-'));
    try {
      const meta = await this.gh.run(repo, a.runId);
      await this.gh.download(repo, a.runId, a.name, dir);
      const n = ingestArtifact(h, repo, a, meta, dir);
      h.markCiSeen(a.id, n ? 'ok' : 'empty');
      return n;
    } catch (e) {
      const tries = h.ciTries(a.id) + 1;
      h.markCiSeen(a.id, tries >= 3 ? `failed: ${(e as Error).message.slice(0, 200)}` : undefined, tries);
      this.d.log?.(`test history: artifact ${a.id} (run ${a.runId}) not read (try ${tries}): ${(e as Error).message}`);
      return undefined;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
