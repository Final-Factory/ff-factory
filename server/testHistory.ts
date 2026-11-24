// The per-test history (w4922, docs/test-history.md): every game-repo test run FF Factory can see, test by test, in one
// SQLite database, <dataDir>/test-history.db. The CI runs come from their artifacts (server/testHistoryCi.ts): the merge gate
// and the release's "Test results for editmode", the master batch's "Master batch results" with its verdict. A worker's runs in
// its sandbox's editor come from the game repo's Assets/Editor/TestHistoryRecorder.cs, whose files the machine daemon sends
// (machine/testHistorySpool.ts). Nobody records anything by hand.
//
// Every failure gets a label once what happened next shows it (labelFailures):
// - fp (false positive): it passed again with nothing changed (a re-run, the master batch's confirm), or after only the
//   test or files outside the game changed;
// - detect (correct failure detection): the master batch's bisect named the merge that broke it, or it passed again after
//   only game code changed;
// - unknown: the evidence cannot say (both changed, the base moved, it never ran again). Never a guess.
// The ready-made queries and a read-only SQL route (queryTestHistory) answer which tests are slow, which are noisy and which
// ever catch anything. The database only suggests: removing or changing a test is a person's call.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { GateTuning } from './gateTuning.ts';

export const TEST_HISTORY_FILE = 'test-history.db';
/** Per-test results are kept this long (a failing run's until its failures are labelled); the failures and their labels for good. */
export const KEEP_RESULTS_DAYS = 60;
/** The per-test, per-day rollup: what the queries count; a year of it. */
export const KEEP_DAYS_DAYS = 365;
/** A failure that nothing has decided after this long is labelled unknown. */
export const DECIDE_WITHIN_DAYS = 7;
const DAY = 86_400_000;
const MAX_MESSAGE = 600;

/** Who set a label, ranked: 0 the labeller ("auto"), 1 a worker ("worker:<session>"), 2 a person ("person:<name>"). */
export function labelRank(by: string | null | undefined): number {
  if (!by || by === 'auto') return 0;
  return by.startsWith('worker:') ? 1 : 2;
}

export type Source = 'pr-gate' | 'master-batch' | 'release' | 'ci-other' | 'local';
export const SOURCES = ['pr-gate', 'master-batch', 'release', 'ci-other', 'local'] as const satisfies readonly Source[];
export type Outcome = 'pass' | 'fail' | 'skip' | 'inconclusive';
export type Label = 'fp' | 'detect' | 'unknown';

export interface TestCase {
  name: string;
  outcome: Outcome;
  ms: number;
  categories?: string[];
  message?: string;
}

export interface RunInfo {
  source: Source;
  /** Unique per run: "gh:<run id>:<artifact>" for CI, "local:<machine>/<sandbox>/<file>" for a worker's. */
  key: string;
  repo?: string;
  ciRun?: number;
  attempt?: number;
  sha?: string;
  base?: string;
  pr?: number;
  branch?: string;
  machine?: string;
  sandbox?: string;
  requests?: string[];
  sessions?: string[];
  /**
   * A local run's tagging (tagFor in index.ts): "session" (the worker session that ran it, from its own environment),
   * "sandbox" (the one worker in the editor's sandbox), "shared" (several workers there: all named), "none" (no worker
   * known: untagged). Unset for CI.
   */
  tagged?: 'session' | 'sandbox' | 'shared' | 'none';
  started?: string;
  finished: string;
  mode?: string;
  verdict?: string;
  /** A local run's fingerprint: each path that differs from its base, with its blob hash or "deleted". */
  changes?: Record<string, string> | null;
  url?: string;
}

/** The test's class: its full name without the method and its arguments ("Ns.Class.Method(1)" → "Ns.Class"). */
export function classOf(name: string): string {
  const bare = name.includes('(') ? name.slice(0, name.indexOf('(')) : name;
  const i = bare.lastIndexOf('.');
  return i > 0 ? bare.slice(0, i) : bare;
}

// ---------------------------------------------------------------- what a change touched

export type PathKind = 'test' | 'game' | 'other';

/** A changed path's kind: the tests' own folders, the rest of the game (Assets, Packages, ProjectSettings), or neither. */
export function pathKind(p: string): PathKind {
  const f = p.replace(/\\/g, '/');
  if (/^Assets\/(Tests|TestsSlow|Scripts\/PlayModeTests)\//.test(f) || /^Assets\/.*\/(Tests|Editor\/Tests)\//.test(f)) return 'test';
  if (/^(Assets|Packages|ProjectSettings)\//.test(f)) return 'game';
  return 'other';
}

/**
 * The label a failure earns from the files that changed between it and the next run where the test passed. No change: the
 * same code passed, so the failure was the run's (flaky, environment, timing). Only the tests (and files outside the game):
 * the test was what got fixed. Only game code: the test caught a real problem in it. Both: nobody can say which.
 */
export function labelFromChange(paths: readonly string[] | undefined, again: string): { label: Label; reason: string } {
  if (!paths) return { label: 'unknown', reason: `passed ${again}, but what changed in between could not be read` };
  const kinds = new Set(paths.map(pathKind));
  const shown = (k: PathKind) => paths.filter((p) => pathKind(p) === k).slice(0, 3).join(', ');
  if (!paths.length) return { label: 'fp', reason: `passed ${again} with nothing changed (flaky, timing or environment)` };
  if (kinds.has('test') && kinds.has('game')) return { label: 'unknown', reason: `passed ${again} after both tests and game code changed (${shown('test')}; ${shown('game')})` };
  if (kinds.has('game')) return { label: 'detect', reason: `passed ${again} after only game code changed (${shown('game')})` };
  if (kinds.has('test')) return { label: 'fp', reason: `passed ${again} after only the tests changed (${shown('test')}): the test was fixed, not the game` };
  return { label: 'fp', reason: `passed ${again} after only files outside the game changed (${shown('other')})` };
}

/**
 * The dirty paths of a local run's fingerprint that are the failing test's own source file (w5457): the class name is the file
 * name ("Ns.PanelsHiddenHintTest.Case(1)" → ".../PanelsHiddenHintTest.cs"; a nested class's outer class names the file).
 */
export function ownSourceIn(test: string, paths: Iterable<string>): string[] {
  const cls = classOf(test);
  const name = (cls.slice(cls.lastIndexOf('.') + 1).split('+')[0] ?? '').toLowerCase();
  if (!name) return [];
  return [...paths].filter((p) => /\.cs$/i.test(p) && p.slice(p.lastIndexOf('/') + 1, -3).toLowerCase() === name);
}

/**
 * w5457: a local failure the test's own author earned. The run was a worker's while it wrote or edited that test (its source is
 * dirty in the failing run, or differs from the passing run), so the pass that followed says nothing about flakiness. Answers
 * the label to give, or undefined when the test's source was not in play. Gap: a stale import or compile (a reverted asset not
 * re-imported, a probe built before recompiling) changes no file, so it still reads as "nothing changed" and stays fp; nothing
 * the runs record tells it apart, so the byRate list can still carry such a test until a worker relabels it by hand.
 */
export function beingWritten(test: string, failing: Record<string, string> | null | undefined, between: readonly string[] | undefined): { label: Label; reason: string } | undefined {
  const own = ownSourceIn(test, [...Object.keys(failing ?? {}), ...(between ?? [])]);
  if (!own.length) return undefined;
  return { label: 'unknown', reason: `the test was being written or edited (${own.slice(0, 2).join(', ')} was changed in the local run or before the next pass), so the pass says nothing about flakiness` };
}

/** The paths whose content differs between two local fingerprints of the same base. */
export function changedBetween(a: Record<string, string>, b: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [p, h] of Object.entries(a)) if (b[p] !== h) out.add(p);
  for (const p of Object.keys(b)) if (!(p in a)) out.add(p);
  return [...out].sort();
}

// ---------------------------------------------------------------- reading results

const ATTR = /([\w-]+)="([^"]*)"/g;
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');

function nunitOutcome(result: string): Outcome {
  if (result === 'Passed') return 'pass';
  if (result === 'Failed') return 'fail';
  if (result === 'Skipped') return 'skip';
  return 'inconclusive';
}

/** The test cases of an NUnit 3 results file (Unity's -testResults, the merge gate's and the master batch's XML). */
export function parseNunit(xml: string): TestCase[] {
  const out: TestCase[] = [];
  const open = /<test-case\s([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(ATTR)) attrs[a[1]!] = unxml(a[2]!);
    const name = attrs.fullname;
    if (!name) continue;
    const tc: TestCase = { name, outcome: nunitOutcome(attrs.result ?? ''), ms: Math.round(Number(attrs.duration ?? 0) * 1000) || 0 };
    if (!m[2]) {
      const end = xml.indexOf('</test-case>', open.lastIndex);
      const body = end < 0 ? '' : xml.slice(open.lastIndex, end);
      const cats = [...body.matchAll(/<property\s+name="Category"\s+value="([^"]*)"/g)].map((c) => unxml(c[1]!));
      if (cats.length) tc.categories = cats;
      if (tc.outcome === 'fail') {
        const msg = /<message>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/message>/.exec(body);
        const text = (msg?.[1] ?? (msg?.[2] ? unxml(msg[2]) : '')).trim();
        if (text) tc.message = text.slice(0, MAX_MESSAGE);
      }
      if (end >= 0) open.lastIndex = end;
    }
    out.push(tc);
  }
  return out;
}

const OUTCOMES = new Set<Outcome>(['pass', 'fail', 'skip', 'inconclusive']);
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** A local record as TestHistoryRecorder.cs writes it; undefined when it is not one. */
export interface LocalRecord {
  info: Omit<RunInfo, 'source' | 'key'>;
  tests: TestCase[];
  machineName?: string;
  project?: string;
  /** The worker session whose shell started the run (FF_SESSION_ID; a batch run), or its temp folder's ffa-<id>. */
  session?: string;
  /** The run never finished: its recorder's running file, sent once it went stale (the editor crashed or was killed). */
  running: boolean;
  /** How many tests the run set out to run (0: not known). */
  planned: number;
}

/** The session id in a worker temp folder's name (`.../ffa-<id>`, server/cleanup.ts sessionTempDir). */
export function sessionOfTemp(tmp: string | undefined): string | undefined {
  const m = tmp ? /(?:^|[\\/])ffa-([\w-]{4,40})[\\/]*$/.exec(tmp) : null;
  return m?.[1];
}

export function parseLocalRecord(text: string): LocalRecord | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object' || j.version !== 1 || !Array.isArray(j.tests)) return undefined;
  const tests: TestCase[] = [];
  for (const t of j.tests as Record<string, unknown>[]) {
    const name = str(t?.name, 1000);
    const outcome = t?.outcome as Outcome;
    if (!name || !OUTCOMES.has(outcome)) continue;
    const tc: TestCase = { name, outcome, ms: typeof t.ms === 'number' && Number.isFinite(t.ms) ? Math.max(0, Math.round(t.ms)) : 0 };
    if (Array.isArray(t.categories)) tc.categories = t.categories.filter((c): c is string => typeof c === 'string').slice(0, 20);
    const msg = str(t.message, MAX_MESSAGE);
    if (msg) tc.message = msg;
    tests.push(tc);
  }
  const finished = str(j.finished, 40);
  if (!finished || !Number.isFinite(Date.parse(finished))) return undefined;
  let changes: Record<string, string> | null = null;
  if (j.changes && typeof j.changes === 'object' && !j.changesTruncated) {
    changes = {};
    for (const [p, h] of Object.entries(j.changes as Record<string, unknown>)) if (typeof h === 'string') changes[p.slice(0, 400)] = h.slice(0, 64);
  }
  const running = j.status === 'running';
  const planned = typeof j.planned === 'number' && Number.isFinite(j.planned) ? Math.max(0, Math.round(j.planned)) : 0;
  const session = (str(j.session, 40) || undefined) ?? sessionOfTemp(str(j.tmp, 400));
  return {
    info: {
      finished: new Date(finished).toISOString(),
      started: str(j.started, 40),
      sha: str(j.head, 40),
      base: str(j.base, 40),
      branch: str(j.branch, 200),
      mode: str(j.mode, 20),
      changes,
      ...(running ? { verdict: `incomplete: ${tests.length} of ${planned || '?'} tests finished before the run stopped` } : {}),
    },
    tests,
    machineName: str(j.machine, 100),
    project: str(j.project, 400),
    ...(session && /^[\w-]+$/.test(session) ? { session } : {}),
    running,
    planned,
  };
}

// ---------------------------------------------------------------- the database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS tests(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, class TEXT NOT NULL, categories TEXT,
  performance INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tests_class ON tests(class);
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, key TEXT NOT NULL UNIQUE, repo TEXT, ci_run INTEGER, attempt INTEGER,
  sha TEXT, base TEXT, pr INTEGER, branch TEXT, machine TEXT, sandbox TEXT, requests TEXT, sessions TEXT, tagged TEXT,
  started TEXT, finished TEXT NOT NULL, mode TEXT, tests INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL,
  skipped INTEGER NOT NULL, total_ms INTEGER NOT NULL, verdict TEXT, changes TEXT, url TEXT, recorded TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_line ON runs(source, branch, finished);
CREATE INDEX IF NOT EXISTS runs_finished ON runs(finished);
CREATE TABLE IF NOT EXISTS results(
  run_id INTEGER NOT NULL, test_id INTEGER NOT NULL, outcome TEXT NOT NULL, ms INTEGER NOT NULL,
  PRIMARY KEY(run_id, test_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS results_test ON results(test_id, run_id);
CREATE TABLE IF NOT EXISTS test_days(
  day TEXT NOT NULL, source TEXT NOT NULL, test_id INTEGER NOT NULL, runs INTEGER NOT NULL, passes INTEGER NOT NULL,
  fails INTEGER NOT NULL, total_ms INTEGER NOT NULL, max_ms INTEGER NOT NULL,
  PRIMARY KEY(day, source, test_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS test_days_test ON test_days(test_id, day);
CREATE TABLE IF NOT EXISTS failures(
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, test_id INTEGER NOT NULL, message TEXT,
  label TEXT, reason TEXT, labelled_by TEXT, labelled_at TEXT, UNIQUE(run_id, test_id));
CREATE INDEX IF NOT EXISTS failures_test ON failures(test_id);
CREATE INDEX IF NOT EXISTS failures_pending ON failures(label);
CREATE TABLE IF NOT EXISTS coverage(class TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY(class, type)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS coverage_type ON coverage(type);
CREATE TABLE IF NOT EXISTS run_starts(key TEXT PRIMARY KEY, sessions TEXT, requests TEXT, tagged TEXT NOT NULL, at TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ci_seen(artifact_id INTEGER PRIMARY KEY, status TEXT, tries INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relabel_log(
  batch TEXT NOT NULL, failure_id INTEGER NOT NULL, test TEXT NOT NULL, old_label TEXT, old_reason TEXT, old_by TEXT, old_at TEXT,
  new_label TEXT NOT NULL, new_reason TEXT NOT NULL, at TEXT NOT NULL, reverted_at TEXT, PRIMARY KEY(batch, failure_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gate_tuning(day TEXT PRIMARY KEY, at TEXT NOT NULL, summary TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
`;

type Row = Record<string, string | number | null>;

export interface PendingFailure {
  id: number;
  runId: number;
  test: string;
  testId: number;
  source: Source;
  repo: string | null;
  sha: string | null;
  base: string | null;
  branch: string | null;
  machine: string | null;
  sandbox: string | null;
  finished: string;
  changes: string | null;
}

/** What the next run of a failed test on its line shows: the first later pass, and whether any later run exists. */
export interface NextPass {
  runId: number;
  source: Source;
  sha: string | null;
  base: string | null;
  finished: string;
  changes: string | null;
}

export class TestHistory {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(o: { dataDir: string; now?: () => number; file?: string }) {
    this.file = o.file ?? path.join(o.dataDir, TEST_HISTORY_FILE);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.now = o.now ?? Date.now;
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // A database made before runs.tagged (#1050's first deploy).
    if (!(this.db.prepare('PRAGMA table_info(runs)').all() as Row[]).some((c) => c.name === 'tagged')) this.db.exec('ALTER TABLE runs ADD COLUMN tagged TEXT');
    if (!this.meta('recorded_since')) this.setMeta('recorded_since', new Date(this.now()).toISOString());
  }

  close() {
    this.db.close();
  }

  meta(k: string): string | undefined {
    const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as Row | undefined;
    return typeof r?.v === 'string' ? r.v : undefined;
  }

  setMeta(k: string, v: string) {
    this.db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  hasRun(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM runs WHERE key = ?').get(key);
  }

  /** Whether a CI artifact is done with: read, or given up on after its tries. */
  ciSeen(artifactId: number): boolean {
    const r = this.db.prepare('SELECT status FROM ci_seen WHERE artifact_id = ?').get(artifactId) as Row | undefined;
    return !!r && r.status !== null;
  }

  ciTries(artifactId: number): number {
    const r = this.db.prepare('SELECT tries FROM ci_seen WHERE artifact_id = ?').get(artifactId) as Row | undefined;
    return r ? Number(r.tries) : 0;
  }

  /** Mark a CI artifact read (status), or count a failed try (status undefined: it is tried again on a later look). */
  markCiSeen(artifactId: number, status: string | undefined, tries = 0) {
    this.db
      .prepare('INSERT INTO ci_seen(artifact_id, status, tries, at) VALUES(?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET status = excluded.status, tries = excluded.tries, at = excluded.at')
      .run(artifactId, status ?? null, tries, new Date(this.now()).toISOString());
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * Record one run and its test cases, once per key (a second call with the same key does nothing and answers its id). Skipped
   * and inconclusive cases are kept in the run's results but count in no rollup; a master batch keeps only its failures there. A Performance-tagged test is flagged, so the
   * ready-made queries leave it out (it runs in no CI; its local runs stay apart).
   */
  addRun(run: RunInfo, tests: readonly TestCase[]): { runId: number; added: boolean } {
    const had = this.db.prepare('SELECT id FROM runs WHERE key = ?').get(run.key) as Row | undefined;
    if (had) return { runId: Number(had.id), added: false };
    return this.tx(() => {
      const passed = tests.filter((t) => t.outcome === 'pass').length;
      const failed = tests.filter((t) => t.outcome === 'fail').length;
      const skipped = tests.length - passed - failed;
      const totalMs = tests.reduce((s, t) => s + (t.outcome === 'skip' ? 0 : t.ms), 0);
      const recorded = new Date(this.now()).toISOString();
      const res = this.db
        .prepare(
          `INSERT INTO runs(source, key, repo, ci_run, attempt, sha, base, pr, branch, machine, sandbox, requests, sessions, tagged, started, finished, mode,
            tests, passed, failed, skipped, total_ms, verdict, changes, url, recorded) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          run.source, run.key, run.repo ?? null, run.ciRun ?? null, run.attempt ?? null, run.sha ?? null, run.base ?? null, run.pr ?? null,
          run.branch ?? null, run.machine ?? null, run.sandbox ?? null, run.requests?.length ? run.requests.join(',') : null,
          run.sessions?.length ? run.sessions.join(',') : null, run.tagged ?? null, run.started ?? null, run.finished, run.mode ?? null, tests.length,
          passed, failed, skipped, totalMs, run.verdict ?? null, run.changes ? JSON.stringify(run.changes) : null, run.url ?? null, recorded,
        );
      const runId = Number(res.lastInsertRowid);
      const day = run.finished.slice(0, 10);
      const upsertTest = this.db.prepare(
        `INSERT INTO tests(name, class, categories, performance, first_seen, last_seen) VALUES(?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET last_seen = max(last_seen, excluded.last_seen), first_seen = min(first_seen, excluded.first_seen),
           categories = coalesce(excluded.categories, categories), performance = max(performance, excluded.performance) RETURNING id`,
      );
      const addResult = this.db.prepare('INSERT OR REPLACE INTO results(run_id, test_id, outcome, ms) VALUES(?,?,?,?)');
      const addDay = this.db.prepare(
        `INSERT INTO test_days(day, source, test_id, runs, passes, fails, total_ms, max_ms) VALUES(?,?,?,1,?,?,?,?)
         ON CONFLICT(day, source, test_id) DO UPDATE SET runs = runs + 1, passes = passes + excluded.passes, fails = fails + excluded.fails,
           total_ms = total_ms + excluded.total_ms, max_ms = max(max_ms, excluded.max_ms)`,
      );
      const addFailure = this.db.prepare('INSERT OR IGNORE INTO failures(run_id, test_id, message) VALUES(?,?,?)');
      for (const t of tests) {
        const cats = t.categories?.length ? t.categories.join(',') : null;
        const perf = t.categories?.includes('Performance') ? 1 : 0;
        const id = Number((upsertTest.get(t.name, classOf(t.name), cats, perf, run.finished, run.finished) as Row).id);
        // A master batch runs the whole suite (about 22,000 cases) some 30 times a day: its passes live in the day rollup only.
        if (run.source !== 'master-batch' || t.outcome === 'fail') addResult.run(runId, id, t.outcome, t.ms);
        if (t.outcome === 'pass' || t.outcome === 'fail') addDay.run(day, run.source, id, t.outcome === 'pass' ? 1 : 0, t.outcome === 'fail' ? 1 : 0, t.ms, t.ms);
        if (t.outcome === 'fail') addFailure.run(runId, id, t.message ?? null);
      }
      return { runId, added: true };
    });
  }

  /**
   * Label one failure. `by` says who: "auto" (the labeller), "worker:<session>" (a worker, through test_history set_label),
   * or "person:<name>" (an orchestrator for its person, or the dispatcher as "person:dispatcher"). A label replaces only one
   * of the same or a lower rank: auto < worker < person. Answers whether it was written.
   */
  label(failureId: number, label: Label, reason: string, by: string): boolean {
    const rank = labelRank(by);
    const guard = rank === 0 ? " AND (labelled_by IS NULL OR labelled_by = 'auto')" : rank === 1 ? " AND (labelled_by IS NULL OR labelled_by = 'auto' OR labelled_by LIKE 'worker:%')" : '';
    const r = this.db
      .prepare(`UPDATE failures SET label = ?, reason = ?, labelled_by = ?, labelled_at = ? WHERE id = ?${guard}`)
      .run(label, reason.slice(0, 500), by.slice(0, 80), new Date(this.now()).toISOString(), failureId);
    return Number(r.changes) > 0;
  }

  /** One failure's label and who set it, or undefined when there is no such failure. */
  failure(failureId: number): { label: string | null; labelledBy: string | null; test: string } | undefined {
    const r = this.db.prepare('SELECT f.label, f.labelled_by, t.name FROM failures f JOIN tests t ON t.id = f.test_id WHERE f.id = ?').get(failureId) as Row | undefined;
    return r ? { label: (r.label as string | null) ?? null, labelledBy: (r.labelled_by as string | null) ?? null, test: String(r.name) } : undefined;
  }

  /** The failure of a test in a run, by the test's full name. */
  failureId(runId: number, test: string): number | undefined {
    const r = this.db.prepare('SELECT f.id FROM failures f JOIN tests t ON t.id = f.test_id WHERE f.run_id = ? AND t.name = ?').get(runId, test) as Row | undefined;
    return r ? Number(r.id) : undefined;
  }

  /**
   * A master batch's own verdict on its failures (master-batch.py): a test that passed on the re-run at the same commit is
   * flaky (fp); one the bisect pinned on a merge is a detection, with that merge named; one it could not pin is unknown.
   */
  applyBatchVerdict(runId: number, verdict: { verdict?: unknown; flaky?: unknown; unresolved?: unknown; culprits?: unknown }) {
    // hung and unresolved (w5413): no run confirmed these failures, so the bisect never ran (w5415).
    const unconfirmed = verdict.verdict === 'hung' || verdict.verdict === 'unresolved';
    const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    for (const t of names(verdict.flaky)) {
      const id = this.failureId(runId, t);
      if (id) this.label(id, 'fp', 'master batch: failed, then passed on the re-run at the same commit', 'auto');
    }
    for (const c of Array.isArray(verdict.culprits) ? verdict.culprits : []) {
      const pr = typeof c?.pr === 'number' ? ` PR #${c.pr}` : '';
      const sha = typeof c?.sha === 'string' ? ` (${c.sha.slice(0, 9)})` : '';
      for (const t of names(c?.tests)) {
        const id = this.failureId(runId, t);
        if (id) this.label(id, 'detect', `master batch: the bisect named the merge that broke it:${pr}${sha}`, 'auto');
      }
    }
    for (const t of names(verdict.unresolved)) {
      const id = this.failureId(runId, t);
      if (id) this.label(id, 'unknown', unconfirmed ? 'master batch: an editor hung or gave no results, so no run confirmed it and no merge was blamed' : 'master batch: confirmed at the tip, but the bisect could not pin it on one merge', 'auto');
    }
  }

  /** The failures no label has reached yet, oldest first. */
  pending(limit = 500): PendingFailure[] {
    return (
      this.db
        .prepare(
          `SELECT f.id, f.run_id AS runId, t.name AS test, t.id AS testId, r.source, r.repo, r.sha, r.base, r.branch, r.machine, r.sandbox, r.finished, r.changes
           FROM failures f JOIN runs r ON r.id = f.run_id JOIN tests t ON t.id = f.test_id WHERE f.label IS NULL ORDER BY r.finished LIMIT ?`,
        )
        .all(limit) as unknown as PendingFailure[]
    );
  }

  /**
   * The later runs of a failed test on its line: CI runs of the same branch (a pull request's head branch, master), or a
   * worker's runs in the same sandbox on the same branch. Answers the first later pass and how many later runs there were.
   */
  nextOnLine(f: PendingFailure): { pass?: NextPass; later: number } {
    const local = f.source === 'local';
    const where = local ? "r.source = 'local' AND r.machine IS ? AND r.sandbox IS ? AND r.branch IS ?" : "r.source <> 'local' AND r.source <> 'master-batch' AND r.branch IS ?";
    const args = local ? [f.machine, f.sandbox, f.branch] : [f.branch];
    const rows = this.db
      .prepare(
        `SELECT r.id AS runId, r.source, r.sha, r.base, r.finished, r.changes, x.outcome FROM results x JOIN runs r ON r.id = x.run_id
         WHERE x.test_id = ? AND r.finished > ? AND ${where} AND x.outcome IN ('pass', 'fail') ORDER BY r.finished LIMIT 50`,
      )
      .all(f.testId, f.finished, ...args) as Row[];
    const pass = rows.find((r) => r.outcome === 'pass');
    return { later: rows.length, ...(pass ? { pass: { runId: Number(pass.runId), source: pass.source as Source, sha: pass.sha as string | null, base: pass.base as string | null, finished: String(pass.finished), changes: pass.changes as string | null } } : {}) };
  }

  /** Coverage from the game repo's test_select.py (master batch artifact coverage.json): each test class → the types it names. */
  setCoverage(sha: string, classes: Record<string, unknown>) {
    this.tx(() => {
      this.db.exec('DELETE FROM coverage');
      const add = this.db.prepare('INSERT OR IGNORE INTO coverage(class, type) VALUES(?, ?)');
      for (const [cls, types] of Object.entries(classes)) if (Array.isArray(types)) for (const t of types) if (typeof t === 'string') add.run(cls.slice(0, 300), t.slice(0, 200));
      this.setMeta('coverage_sha', sha);
      this.setMeta('coverage_at', new Date(this.now()).toISOString());
    });
  }

  /** A local run's tags when it started (the daemon saw its running file), kept until its record comes; the first one stays. */
  noteStart(key: string, tags: Pick<RunInfo, 'sessions' | 'requests' | 'tagged'>) {
    this.db
      .prepare('INSERT OR IGNORE INTO run_starts(key, sessions, requests, tagged, at) VALUES(?,?,?,?,?)')
      .run(key, tags.sessions?.join(',') ?? '', tags.requests?.join(',') ?? '', tags.tagged ?? 'none', new Date(this.now()).toISOString());
  }

  startTags(key: string): Pick<RunInfo, 'sessions' | 'requests' | 'tagged'> | undefined {
    const r = this.db.prepare('SELECT sessions, requests, tagged FROM run_starts WHERE key = ?').get(key) as Row | undefined;
    if (!r) return undefined;
    const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',') : []);
    return { sessions: list(r.sessions), requests: list(r.requests), tagged: r.tagged as RunInfo['tagged'] };
  }

  /** Drop per-test results older than KEEP_RESULTS_DAYS of runs whose failures are all labelled; the rollup and failures stay. */
  prune(keepDays = KEEP_RESULTS_DAYS): number {
    const cutoff = new Date(this.now() - keepDays * DAY).toISOString();
    const r = this.db.prepare('DELETE FROM results WHERE run_id IN (SELECT id FROM runs WHERE finished < ? AND id NOT IN (SELECT run_id FROM failures WHERE label IS NULL))').run(cutoff);
    // The day rollup (about 22,000 rows a day for each source that runs the whole suite) is kept KEEP_DAYS_DAYS.
    this.db.prepare('DELETE FROM test_days WHERE day < ?').run(new Date(this.now() - KEEP_DAYS_DAYS * DAY).toISOString().slice(0, 10));
    // A start whose record never came within a week (its file was lost): a running file is sent within STALE_MS of its end.
    this.db.prepare('DELETE FROM run_starts WHERE at < ?').run(new Date(this.now() - 7 * DAY).toISOString());
    return Number(r.changes);
  }

  /** The labeller's own fp labels on local failures finished since `sinceIso`, oldest first (w5467). */
  autoLocalFp(sinceIso: string): (PendingFailure & { oldReason: string | null; oldAt: string | null })[] {
    return this.db
      .prepare(
        `SELECT f.id, f.run_id AS runId, t.name AS test, t.id AS testId, r.source, r.repo, r.sha, r.base, r.branch, r.machine, r.sandbox, r.finished, r.changes, f.reason AS oldReason, f.labelled_at AS oldAt
         FROM failures f JOIN runs r ON r.id = f.run_id JOIN tests t ON t.id = f.test_id
         WHERE r.source = 'local' AND f.label = 'fp' AND f.labelled_by = 'auto' AND r.finished >= ? ORDER BY r.finished`,
      )
      .all(sinceIso) as unknown as (PendingFailure & { oldReason: string | null; oldAt: string | null })[];
  }

  /** Write one relabel (the labeller's rank) and its log row together. */
  relabelLogged(batch: string, f: PendingFailure & { oldReason?: string | null; oldAt?: string | null }, label: Label, reason: string) {
    this.tx(() => {
      if (!this.label(f.id, label, reason, 'auto')) return;
      this.db
        .prepare('INSERT OR REPLACE INTO relabel_log(batch, failure_id, test, old_label, old_reason, old_by, old_at, new_label, new_reason, at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(batch, f.id, f.test, 'fp', f.oldReason ?? null, 'auto', f.oldAt ?? null, label, reason.slice(0, 500), new Date(this.now()).toISOString());
    });
  }

  /** Restore a batch's old labels (only where the row still holds the batch's own auto label); answers how many. */
  revertBatch(batch: string): number {
    return this.tx(() => {
      let n = 0;
      const at = new Date(this.now()).toISOString();
      for (const r of this.all('SELECT failure_id, old_label, old_reason, old_by, old_at, new_reason FROM relabel_log WHERE batch = ? AND reverted_at IS NULL', batch)) {
        const u = this.db
          .prepare("UPDATE failures SET label = ?, reason = ?, labelled_by = ?, labelled_at = ? WHERE id = ? AND label = 'unknown' AND labelled_by = 'auto' AND reason = ?")
          .run(r.old_label, r.old_reason, r.old_by, r.old_at, r.failure_id, String(r.new_reason).slice(0, 500));
        if (Number(u.changes) > 0) {
          n++;
          this.db.prepare('UPDATE relabel_log SET reverted_at = ? WHERE batch = ? AND failure_id = ?').run(at, batch, r.failure_id);
        }
      }
      return n;
    });
  }

  /** Read-only SELECTs for the queries (the ad-hoc SQL route runs apart, in a worker, on its own read-only connection). */
  all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  /** The daily merge-gate tuning's own row (server/gateTuning.ts, w4928): one per day, the newest replacing that day's. */
  saveGateTuning(day: string, at: string, summary: string, json: string) {
    this.db.prepare('INSERT INTO gate_tuning(day, at, summary, json) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET at = excluded.at, summary = excluded.summary, json = excluded.json').run(day, at, summary, json);
  }
}

/** One key for a local run's running and finished files, so a run is recorded once. */
export const localRunKey = (machineId: string, sandbox: string, file: string) => `local:${machineId}/${sandbox}/${file.replace(/\.running\.json$/, '.json')}`;

// ---------------------------------------------------------------- labelling

/** The files a pull request's own change differs in between two of its head commits (CI), or undefined when unreadable. */
export type PrDiff = (repo: string, a: string, b: string) => Promise<string[] | undefined>;

/**
 * The one reason a local failure is not counted (w5457; lothsahn, w5467: "Flaky tests in local runs still matter! We want the
 * gents to go faster"): the worker was writing or editing that very test. Every other local failure stays as the change rules
 * label it, a stall (a test minutes slower than its median) included. `p` is the next pass; undefined when it is no local run.
 */
export function notTheGame(f: PendingFailure, p: NextPass): { label: Label; reason: string } | undefined {
  if (f.source !== 'local' || p.source !== 'local') return undefined;
  const fc = f.changes ? (JSON.parse(f.changes) as Record<string, string>) : undefined;
  const pc = p.changes ? (JSON.parse(p.changes) as Record<string, string>) : undefined;
  return beingWritten(f.test, fc, fc && pc && f.base === p.base ? changedBetween(fc, pc) : undefined);
}

/**
 * w5467: recompute the labeller's own fp labels on local failures of the last `days` days with today's rules (notTheGame),
 * changing only those the rules now call unknown. A hand label (worker or person) is never touched. Every change is logged in
 * relabel_log with the old label, so `revertRelabel` can undo the batch. dryRun reports without writing.
 */
export function relabelLocalFp(h: TestHistory, o: { days?: number; dryRun: boolean; now?: number }): { batch: string; scanned: number; changed: { id: number; test: string; reason: string }[] } {
  const now = o.now ?? Date.now();
  const batch = new Date(now).toISOString();
  const changed: { id: number; test: string; reason: string }[] = [];
  const rows = h.autoLocalFp(new Date(now - (o.days ?? 30) * DAY).toISOString());
  for (const f of rows) {
    const p = h.nextOnLine(f).pass;
    const v = p && notTheGame(f, p);
    if (!v || v.label === 'fp') continue;
    changed.push({ id: f.id, test: f.test, reason: v.reason });
    if (!o.dryRun) h.relabelLogged(batch, f, v.label, v.reason);
  }
  return { batch, scanned: rows.length, changed };
}

/** Undo one relabel batch: put back each logged row's old label if it still carries the batch's. Answers how many it restored. */
export function revertRelabel(h: TestHistory, batch: string): number {
  return h.revertBatch(batch);
}

const ageDays = (iso: string, now: number) => (now - Date.parse(iso)) / DAY;

/**
 * Give every pending failure the label what happened next shows, where it shows one (labelFromChange). A failure on a line
 * that never ran the test again, or never passed it, waits DECIDE_WITHIN_DAYS and is then unknown. Answers how many it labelled.
 */
export async function labelFailures(h: TestHistory, prDiff: PrDiff, now = Date.now(), limit = 500): Promise<number> {
  let n = 0;
  for (const f of h.pending(limit)) {
    const old = ageDays(f.finished, now) > DECIDE_WITHIN_DAYS;
    if (f.source === 'master-batch') {
      // Its own verdict labels it (applyBatchVerdict); a failure no list named (a run cut short) is unknown after a day.
      if (ageDays(f.finished, now) > 1) n += +h.label(f.id, 'unknown', 'master batch: named in none of its verdict lists', 'auto');
      continue;
    }
    const next = h.nextOnLine(f);
    if (!next.pass) {
      if (old) n += +h.label(f.id, 'unknown', next.later ? `never passed again on its ${f.source === 'local' ? 'sandbox' : 'branch'} within ${DECIDE_WITHIN_DAYS} days` : `never ran again on its ${f.source === 'local' ? 'sandbox' : 'branch'} within ${DECIDE_WITHIN_DAYS} days`, 'auto');
      continue;
    }
    const p = next.pass;
    const notGame = notTheGame(f, p);
    if (notGame) {
      n += +h.label(f.id, notGame.label, notGame.reason, 'auto');
      continue;
    }
    const again = f.source === 'local' ? 'in the next local run that passed' : `in CI at ${String(p.sha).slice(0, 9)}`;
    let verdict: { label: Label; reason: string };
    if (f.source === 'local' && p.source === 'local') {
      if (f.sha && f.sha === p.sha && (f.changes ?? '') === (p.changes ?? '')) verdict = labelFromChange([], 'on a re-run');
      else if (!f.changes || !p.changes) verdict = { label: 'unknown', reason: 'passed again, but a run kept no record of its changes (too many changed files)' };
      else if (f.base !== p.base) verdict = { label: 'unknown', reason: "passed again after the branch's base moved (origin/master merged in), so the change cannot be told apart" };
      else verdict = labelFromChange(changedBetween(JSON.parse(f.changes), JSON.parse(p.changes)), again);
    } else if (f.sha && f.sha === p.sha) verdict = labelFromChange([], 'on a re-run at the same commit');
    else if (f.repo && f.sha && p.sha) verdict = labelFromChange(await prDiff(f.repo, f.sha, p.sha), again);
    else verdict = { label: 'unknown', reason: 'passed again, but the commits are not recorded' };
    n += +h.label(f.id, verdict.label, verdict.reason, 'auto');
  }
  return n + (await labelStreaks(h, prDiff));
}

/** Master-line batches a test fails in a row before its failures stop counting as flakes (w5465). */
const STREAK = 3;
/** The master line: the batches and release runs on master, each running the whole suite. */
const MASTER_LINE = "r.branch = 'master' AND r.source IN ('master-batch', 'release')";

/**
 * A test that fails in STREAK or more master-line batches in a row is no flake, whatever each batch's confirm said (w5465:
 * 13 tests another class broke passed alone, so each of 15 batches called them flaky, 195 fp rows, until #3130 fixed the
 * polluter). Its automatic fp labels become detect when game code changed between its last failing batch and the next
 * batch that ran without the failure, else unknown (still failing, only tests changed, or the diff unreadable). A batch
 * is one run's sha and finish time: the master batch keeps an EditMode and a smoke run side by side, and only failures.
 */
export async function labelStreaks(h: TestHistory, prDiff: PrDiff): Promise<number> {
  const tests = h.all(
    `SELECT f.test_id AS id FROM failures f JOIN runs r ON r.id = f.run_id WHERE ${MASTER_LINE} AND f.label = 'fp' AND f.labelled_by = 'auto'
     GROUP BY f.test_id`,
  );
  if (!tests.length) return 0;
  const batches = h.all(`SELECT sha, finished, max(repo) AS repo FROM runs r WHERE ${MASTER_LINE} GROUP BY sha, finished ORDER BY finished, sha`);
  const diffs = new Map<string, Promise<string[] | undefined>>();
  let n = 0;
  for (const { id } of tests) {
    const fails = h.all(
      `SELECT f.id, f.label, f.labelled_by, r.sha, r.finished FROM failures f JOIN runs r ON r.id = f.run_id WHERE f.test_id = ? AND ${MASTER_LINE}`,
      Number(id),
    );
    const at = new Map<string, Row[]>();
    for (const f of fails) at.set(`${f.sha}|${f.finished}`, [...(at.get(`${f.sha}|${f.finished}`) ?? []), f]);
    let run: Row[] = [];
    let last: Row | undefined;
    const settle = async (next: Row | undefined) => {
      const batchesInRun = new Set(run.map((f) => `${f.sha}|${f.finished}`)).size;
      const flakes = run.filter((f) => f.label === 'fp' && f.labelled_by === 'auto');
      if (batchesInRun >= STREAK && flakes.length) {
        let label: Label = 'unknown';
        let reason = `master line: failed in ${batchesInRun} batches in a row and has not passed since, so not a flake (w5465)`;
        if (next && last) {
          const key = `${last.sha}..${next.sha}`;
          if (!diffs.has(key)) diffs.set(key, last.repo ? prDiff(String(last.repo), String(last.sha), String(next.sha)) : Promise.resolve(undefined));
          const paths = await diffs.get(key)!;
          const game = paths?.some((p) => pathKind(p) === 'game');
          label = game ? 'detect' : 'unknown';
          reason = `master line: failed in ${batchesInRun} batches in a row, then ran clean from ${String(next.sha).slice(0, 9)} on, ${
            game ? 'after a change to game code: a real failure a merge fixed' : paths ? 'after only tests or other files changed' : 'and the change between them could not be read'
          }; not a flake (w5465)`;
        }
        for (const f of flakes) n += +h.label(Number(f.id), label, reason, 'auto');
      }
      run = [];
    };
    for (const b of batches) {
      const hit = at.get(`${b.sha}|${b.finished}`);
      if (hit) {
        run.push(...hit);
        last = b;
      } else if (run.length) await settle(b);
    }
    if (run.length) await settle(undefined);
  }
  return n;
}

// ---------------------------------------------------------------- the queries

export const QUERIES = ['summary', 'slowest', 'false_positives', 'detections', 'never_caught', 'failures', 'test', 'local_runs', 'gate_tuning', 'sql', 'set_label', 'relabel'] as const;
export type QueryName = (typeof QUERIES)[number];

export interface QueryArgs {
  query: QueryName;
  /** Only runs of these sources (default: every CI source and local). */
  sources?: Source[];
  /** The window in days (default 30; never_caught's "never in N days"). */
  days?: number;
  limit?: number;
  /** A substring of the test's full name. */
  test?: string;
  /** Rank false_positives by rate (with at least minRuns runs) instead of count. */
  byRate?: boolean;
  minRuns?: number;
  /** Include Performance-tagged tests (left out by default: they run in no CI). */
  performance?: boolean;
  /** failures: only this label ('pending' for none yet). */
  label?: Label | 'pending';
  sql?: string;
  /** local_runs: only the runs no worker could be named for (tagged "none"). */
  untagged?: boolean;
  /** local_runs: only a request's runs ("w4922"). */
  request?: string;
  /** set_label: the failure (failures' failure_id) and why. */
  failureId?: number;
  reason?: string;
  /** relabel: report only (the default); false writes. */
  dryRun?: boolean;
  /** relabel: undo this batch (its id as the log shows it) instead of running one. */
  batch?: string;
}

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Text table: a header row, then one line per row, cells cut to 120 characters. */
export function table(rows: Row[], empty = '(no rows)'): string {
  if (!rows.length) return empty;
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').slice(0, 120));
  return [cols.join(' | '), ...rows.map((r) => cols.map((c) => cell(r[c])).join(' | '))].join('\n');
}

/** A ready-made query's rows (not sql: that is runSql). */
export function readyQuery(h: TestHistory, a: QueryArgs, now = Date.now()): { title: string; rows: Row[] } {
  const days = Math.min(3650, Math.max(1, Math.round(a.days ?? 30)));
  const limit = Math.min(200, Math.max(1, Math.round(a.limit ?? 20)));
  const since = new Date(now - days * DAY).toISOString().slice(0, 10);
  const sources = (a.sources?.length ? a.sources : SOURCES).filter((s) => SOURCES.includes(s));
  const inSources = `(${sources.map((s) => `'${s}'`).join(',')})`;
  const perf = a.performance ? '' : 'AND t.performance = 0';
  const like = a.test ? `AND t.name LIKE '%' || ? || '%' ESCAPE '\\'` : '';
  const likeArg = a.test ? [esc(a.test)] : [];
  const scope = `last ${days} days, sources ${sources.join(', ')}${a.performance ? ', Performance tests included' : ''}`;
  const fpCounts = `SELECT f.test_id, sum(f.label = 'fp') AS fp, sum(f.label = 'detect') AS detect, sum(f.label = 'unknown') AS unknown, sum(f.label IS NULL) AS pending, count(*) AS failures,
      sum(f.labelled_by LIKE 'worker:%') AS by_worker, sum(f.labelled_by LIKE 'person:%') AS by_person
    FROM failures f JOIN runs r ON r.id = f.run_id WHERE r.finished >= ? AND r.source IN ${inSources} GROUP BY f.test_id`;
  const runCounts = `SELECT test_id, sum(runs) AS runs, sum(total_ms) AS total_ms, max(max_ms) AS max_ms FROM test_days WHERE day >= ? AND source IN ${inSources} GROUP BY test_id`;
  switch (a.query) {
    case 'summary': {
      const rows = h.all(
        `SELECT source, count(*) AS runs, sum(tests) AS results, sum(failed) AS failures, min(finished) AS first_run, max(finished) AS last_run FROM runs GROUP BY source ORDER BY source`,
      );
      const labels = h.all(`SELECT coalesce(label, 'pending') AS label, count(*) AS failures FROM failures GROUP BY label ORDER BY failures DESC`);
      const tests = h.all(`SELECT count(*) AS tests, sum(performance) AS performance_tests FROM tests`)[0]!;
      return {
        title: `Recorded since ${h.meta('recorded_since') ?? '?'}; ${tests.tests} tests (${tests.performance_tests ?? 0} Performance-tagged); coverage from ${h.meta('coverage_sha')?.slice(0, 9) ?? 'none yet'}; CI backfilled to ${h.meta('ci_oldest') ?? 'not yet'}.\nLabels: ${labels.map((l) => `${l.label} ${l.failures}`).join(', ') || 'none yet'}`,
        rows,
      };
    }
    case 'slowest':
      return {
        title: `Slowest tests by average time (${scope})`,
        rows: h.all(
          `SELECT t.name AS test, c.runs, round(1.0 * c.total_ms / c.runs) AS avg_ms, c.max_ms, round(c.total_ms / 1000.0) AS total_s
           FROM (${runCounts}) c JOIN tests t ON t.id = c.test_id WHERE c.runs > 0 ${perf} ${like} ORDER BY avg_ms DESC LIMIT ?`,
          since, ...likeArg, limit,
        ),
      };
    case 'false_positives': {
      const minRuns = Math.max(1, Math.round(a.minRuns ?? 5));
      return {
        title: `Most false positives ${a.byRate ? `by rate (at least ${minRuns} runs)` : 'by count'} (${scope}); fp_rate = fp / runs`,
        rows: h.all(
          `SELECT t.name AS test, f.fp, coalesce(c.runs, 0) AS runs, round(100.0 * f.fp / max(coalesce(c.runs, 0), 1), 2) AS fp_rate_pct, f.detect, f.unknown, f.pending, f.by_worker, f.by_person
           FROM (${fpCounts}) f JOIN tests t ON t.id = f.test_id LEFT JOIN (${runCounts}) c ON c.test_id = f.test_id
           WHERE f.fp > 0 ${perf} ${like} ${a.byRate ? 'AND coalesce(c.runs, 0) >= ?' : ''} ORDER BY ${a.byRate ? 'fp_rate_pct DESC, f.fp DESC' : 'f.fp DESC, fp_rate_pct DESC'} LIMIT ?`,
          since, since, ...likeArg, ...(a.byRate ? [minRuns] : []), limit,
        ),
      };
    }
    case 'detections':
      return {
        title: `Most correct failure detections (${scope})`,
        rows: h.all(
          `SELECT t.name AS test, f.detect, f.fp, f.unknown, coalesce(c.runs, 0) AS runs, f.by_worker, f.by_person,
             (SELECT x.reason FROM failures x JOIN runs r ON r.id = x.run_id WHERE x.test_id = t.id AND x.label = 'detect' ORDER BY r.finished DESC LIMIT 1) AS last_detection
           FROM (${fpCounts}) f JOIN tests t ON t.id = f.test_id LEFT JOIN (${runCounts}) c ON c.test_id = f.test_id
           WHERE f.detect > 0 ${perf} ${like} ORDER BY f.detect DESC, runs DESC LIMIT ?`,
          since, since, ...likeArg, limit,
        ),
      };
    case 'never_caught':
      return {
        title: `Tests that caught no real bug (no detect label) in the ${scope}, by total run time; a suggestion to review, never a removal. Recorded since ${h.meta('recorded_since') ?? '?'}.`,
        rows: h.all(
          `SELECT t.name AS test, c.runs, round(c.total_ms / 1000.0) AS total_s, round(1.0 * c.total_ms / c.runs) AS avg_ms, coalesce(f.fp, 0) AS fp, t.first_seen,
             (SELECT count(*) FROM coverage v WHERE v.class = t.class) AS covers_types,
             (SELECT group_concat(type, ' ') FROM (SELECT type FROM coverage v WHERE v.class = t.class ORDER BY type LIMIT 8)) AS covers
           FROM (${runCounts}) c JOIN tests t ON t.id = c.test_id LEFT JOIN (${fpCounts}) f ON f.test_id = c.test_id
           WHERE coalesce(f.detect, 0) = 0 AND c.runs > 0 ${perf} ${like} ORDER BY c.total_ms DESC LIMIT ?`,
          since, since, ...likeArg, limit,
        ),
      };
    case 'failures': {
      const lab = a.label === 'pending' ? 'AND f.label IS NULL' : a.label ? 'AND f.label = ?' : '';
      return {
        title: `Failures, newest first (${scope})`,
        rows: h.all(
          `SELECT r.finished, r.source, coalesce('#' || r.pr, r.branch) AS line, substr(r.sha, 1, 9) AS sha, r.machine, r.sandbox, r.requests, t.name AS test,
             coalesce(f.label, 'pending') AS label, f.reason, f.labelled_by, f.id AS failure_id
           FROM failures f JOIN runs r ON r.id = f.run_id JOIN tests t ON t.id = f.test_id
           WHERE r.finished >= ? AND r.source IN ${inSources} ${perf} ${like} ${lab} ORDER BY r.finished DESC LIMIT ?`,
          since, ...likeArg, ...(a.label && a.label !== 'pending' ? [a.label] : []), limit,
        ),
      };
    }
    case 'test': {
      if (!a.test) throw new Error('query "test" needs test: a part of the test\'s full name');
      return {
        title: `Runs of tests matching "${a.test}" (${scope}), per day and source`,
        rows: h.all(
          `SELECT t.name AS test, d.day, d.source, d.runs, d.passes, d.fails, round(1.0 * d.total_ms / d.runs) AS avg_ms, d.max_ms
           FROM test_days d JOIN tests t ON t.id = d.test_id WHERE d.day >= ? AND d.source IN ${inSources} ${like} ORDER BY d.day DESC, t.name LIMIT ?`,
          since, ...likeArg, limit,
        ),
      };
    }
    case 'local_runs': {
      const req = a.request ? `AND ',' || r.requests || ',' LIKE '%,' || ? || ',%' ESCAPE '\\'` : '';
      return {
        title: `Local runs, newest first (last ${days} days${a.untagged ? ', untagged only' : ''}${a.request ? `, request ${a.request}` : ''}); tagged: session (the worker that ran it), sandbox (the one worker in that sandbox), shared (several there), none (untagged)`,
        rows: h.all(
          `SELECT r.finished, r.machine, r.sandbox, r.tagged, r.requests, r.sessions, r.branch, substr(r.sha, 1, 9) AS sha, r.mode, r.tests, r.passed, r.failed,
             round(r.total_ms / 1000.0) AS total_s, r.verdict
           FROM runs r WHERE r.source = 'local' AND r.finished >= ? ${a.untagged ? "AND r.tagged = 'none'" : ''} ${req} ORDER BY r.finished DESC LIMIT ?`,
          since, ...(a.request ? [esc(a.request)] : []), limit,
        ),
      };
    }
    case 'gate_tuning': {
      // The daily merge-gate tuning (w4928, server/gateTuning.ts, docs/gate-tuning.md): the newest day's summary, its
      // move-out proposals as rows.
      const r = h.all('SELECT summary, json FROM gate_tuning ORDER BY day DESC LIMIT 1')[0];
      if (!r) return { title: 'Merge-gate tuning (w4928): no run yet; it runs once a day (docs/gate-tuning.md).', rows: [] };
      const t = JSON.parse(String(r.json)) as GateTuning;
      return {
        title: `${r.summary}\nProposed to move out of the gate, most gate time first (crown_jewel: a determinism or save guard, never moved without a person's explicit yes):`,
        rows: t.proposals.slice(0, limit).map((p) => ({ test: p.test, gate_runs: p.gateRuns, share_pct: p.sharePct, since: p.firstDay, span_days: p.spanDays, per_run_s: p.perRunS, total_s: p.totalS, bound_95_pct: p.boundPct, crown_jewel: p.crownJewel ? 'yes' : '' })),
      };
    }
    default:
      throw new Error(`unknown query ${a.query}; one of ${QUERIES.join(', ')}`);
  }
}

// ---------------------------------------------------------------- ad-hoc SQL

export const SQL_MAX_ROWS = 200;
export const SQL_TIMEOUT_MS = 10_000;

/** Why a statement is not one read-only SELECT, or undefined when it is. */
export function sqlProblem(sql: string): string | undefined {
  const s = sql.trim().replace(/;\s*$/, '');
  if (!s) return 'empty';
  if (s.length > 4000) return 'longer than 4000 characters';
  if (s.includes(';')) return 'one statement only (no ";" inside)';
  if (!/^(select|with)\b/i.test(s)) return 'only SELECT (or WITH ... SELECT) is allowed';
  if (/\b(attach|detach|pragma|vacuum|insert|update|delete|replace|create|drop|alter|reindex|load_extension)\b/i.test(s.replace(/'[^']*'/g, "''"))) return 'read-only: no ATTACH, PRAGMA, writes or schema changes';
  return undefined;
}

const SQL_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.file, { readOnly: true });
  const rows = [];
  let more = false;
  for (const r of db.prepare(workerData.sql).iterate()) {
    if (rows.length >= workerData.max) { more = true; break; }
    rows.push(r);
  }
  parentPort.postMessage({ rows, more });
} catch (e) {
  parentPort.postMessage({ error: String(e && e.message || e) });
} finally {
  try { db && db.close(); } catch {}
}`;

/**
 * One read-only SELECT on the database, in a worker thread on its own read-only connection, stopped after SQL_TIMEOUT_MS
 * so a runaway query never holds the portal. At most `max` rows.
 */
export function runSql(file: string, sql: string, max = SQL_MAX_ROWS, timeoutMs = SQL_TIMEOUT_MS): Promise<{ rows: Row[]; more: boolean }> {
  const problem = sqlProblem(sql);
  if (problem) return Promise.reject(new Error(`sql refused: ${problem}`));
  return new Promise((resolve, reject) => {
    const w = new Worker(SQL_WORKER, { eval: true, workerData: { file, sql: sql.trim().replace(/;\s*$/, ''), max: Math.min(SQL_MAX_ROWS, Math.max(1, max)) } });
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error(`sql stopped after ${timeoutMs / 1000} s: narrow it (a WHERE on runs.finished or test_days.day, a LIMIT)`));
    }, timeoutMs);
    w.once('message', (m: { rows?: Row[]; more?: boolean; error?: string }) => {
      clearTimeout(timer);
      void w.terminate();
      if (m.error) reject(new Error(`sql: ${m.error}`));
      else resolve({ rows: m.rows ?? [], more: !!m.more });
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** The answer of the test_history tool: a ready-made query or ad-hoc SQL, as text. */
export async function queryTestHistory(h: TestHistory, a: QueryArgs, now = Date.now(), by?: string): Promise<string> {
  if (a.query === 'set_label') return setLabelByHand(h, a, by);
  if (a.query === 'relabel') return relabelByHand(h, a, now, by);
  if (a.query === 'sql') {
    if (!a.sql) throw new Error('query "sql" needs sql: one SELECT (tables: docs/test-history.md)');
    const r = await runSql(h.file, a.sql, a.limit ?? SQL_MAX_ROWS);
    return `${table(r.rows)}${r.more ? `\n(first ${r.rows.length} rows; add a LIMIT or narrow it)` : ''}`;
  }
  const r = readyQuery(h, a, now);
  return `${r.title}\n${table(r.rows)}`;
}

/**
 * test_history set_label: a worker's or a person's label on one failure, recorded as theirs (`by`, which the portal sets from
 * the caller, never from the arguments). It replaces the labeller's, and a person's replaces a worker's; a worker's never
 * replaces a person's.
 */
export function setLabelByHand(h: TestHistory, a: QueryArgs, by: string | undefined): string {
  if (!by || labelRank(by) === 0) throw new Error('set_label: the caller is not known');
  if (a.failureId === undefined) throw new Error('set_label needs failureId (the failure_id column of query failures)');
  if (a.label !== 'fp' && a.label !== 'detect' && a.label !== 'unknown') throw new Error('set_label needs label: fp, detect or unknown');
  const reason = a.reason?.trim();
  if (!reason) throw new Error('set_label needs reason: what shows it (a re-run, the commit that fixed it)');
  const f = h.failure(a.failureId);
  if (!f) throw new Error(`set_label: no failure ${a.failureId}`);
  if (!h.label(a.failureId, a.label, reason, by)) return `Not changed: failure ${a.failureId} (${f.test}) is labelled ${f.label} by ${f.labelledBy}, which a worker's label does not replace.`;
  return `Failure ${a.failureId} (${f.test}) is now ${a.label}, set by ${by}${f.label ? ` (was ${f.label} by ${f.labelledBy})` : ''}.`;
}

/** Where a local run's workers and requests come from (Agents in index.ts). */
export interface RunTagSource {
  /** The live workers in a machine's sandbox and their requests. */
  workInSandbox(machineId: string, sandbox: string): { sessions: string[]; requests: string[] };
  /** A worker session's requests, or undefined when there is no such worker session. */
  sessionWork(sessionId: string): string[] | undefined;
}

/**
 * A local run's tags: the worker session named in its record (a run its shell started) with that session's requests; else
 * the live workers in its sandbox when the run started (`atStart`, TestHistory.noteStart: the daemon sees a running file
 * within a minute), or, without that, when its record came (the editor's runs: one worker "sandbox", several "shared");
 * else "none", untagged, so query local_runs untagged finds it. w4922: an editor run whose record came after its worker
 * had left the sandbox (stopped on a wait for CI, moved to other work) was untagged when only the record's time counted.
 */
export function localRunTags(src: RunTagSource, machineId: string, sandbox: string, session?: string, atStart?: Pick<RunInfo, 'sessions' | 'requests' | 'tagged'>): Pick<RunInfo, 'sessions' | 'requests' | 'tagged'> {
  const own = session ? src.sessionWork(session) : undefined;
  if (session && own) return { sessions: [session], requests: [...new Set(own)].sort(), tagged: 'session' };
  if (atStart && atStart.tagged !== 'none' && atStart.sessions?.length) return atStart;
  const here = sandbox ? src.workInSandbox(machineId, sandbox) : { sessions: [], requests: [] };
  if (here.sessions.length) return { sessions: here.sessions, requests: here.requests, tagged: here.sessions.length === 1 ? 'sandbox' : 'shared' };
  return { sessions: session ? [session] : [], requests: [], tagged: 'none' };
}

/**
 * test_history relabel (w5467): recompute the labeller's own fp labels on local failures with today's rules, a dry run unless
 * dryRun is false (writing needs a known caller). batch + dryRun false undoes one batch. Every change is in relabel_log.
 */
export function relabelByHand(h: TestHistory, a: QueryArgs, now: number, by: string | undefined): string {
  const dry = a.dryRun !== false;
  if (a.batch) {
    if (dry) {
      const r = h.all("SELECT count(*) AS n FROM relabel_log WHERE batch = ? AND reverted_at IS NULL", a.batch)[0];
      return `Batch ${a.batch}: ${r?.n ?? 0} change(s) could be reverted (dry run; pass dryRun: false to revert).`;
    }
    if (!by || labelRank(by) === 0) throw new Error('relabel: the caller is not known');
    return `Batch ${a.batch}: reverted ${revertRelabel(h, a.batch)} row(s), by ${by}.`;
  }
  if (!dry && (!by || labelRank(by) === 0)) throw new Error('relabel: the caller is not known');
  const r = relabelLocalFp(h, { days: a.days ?? 30, dryRun: dry, now });
  const byTest = new Map<string, number>();
  for (const c of r.changed) byTest.set(classOf(c.test), (byTest.get(classOf(c.test)) ?? 0) + 1);
  const top = [...byTest].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([c, n]) => `${c}: ${n}`).join('; ');
  return `${dry ? 'DRY RUN, nothing written' : `Written as batch ${r.batch} by ${by}`}: scanned ${r.scanned} auto fp local failure(s) of the last ${a.days ?? 30} days, ${r.changed.length} now unknown.\nBy class: ${top || 'none'}`;
}
