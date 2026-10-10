// The nightly e2e lab's results into the ledger (docs/intake.md, "Nightly e2e regressions"): what a night's report
// must look like, which results become work, and the request each becomes. Pure: server/intake.ts matches them
// against the ledger and files them. The lab is the team's own (FinalFactory scripts/nightly/ffnightly.py) and posts
// with a scoped API key, but its text is still cleaned and cut before it reaches a brief.
import { cleanLine, type IntakeDraft, type IntakeSettings } from './intakeRules.ts';
import type { NightlyNight, NightlyRelease, WorkPriority, WorkTriage } from '../shared/types.ts';

export const NIGHTLY_REPORT_VERSION = 1;
const MAX_RESULTS = 60;

export type NightlyClass = 'new' | 'still' | 'flaky';

/** One failing or flaky scenario of a night, as the lab reports it. */
export interface NightlyResult {
  scenario: string;
  title?: string;
  /** The scenario's file in the game repo ("scripts/nightly/scenarios/chaos-mp.json" for a generated chaos scenario). */
  file?: string;
  /** new: passed (or was not run) the night before; still: failed then too; flaky: failed, then passed on the rerun. */
  class: NightlyClass;
  step?: string;
  reason?: string;
  /** The first attempt's oracle, when the rerun failed too. */
  firstTry?: string;
  /** The scenario's evidence folder on the lab machine. */
  evidence?: string;
  desyncReports?: string[];
  lastGreen?: { night: string; sha: string };
  /** The first night of the current red streak (tonight for a new regression). */
  firstRed?: { night: string; sha: string };
  /** Nights running it has been flaky, tonight included. */
  flakyNights?: number;
  /** Entries of the lab's regression ledger (scripts/nightly/ledger.json) this scenario proves. */
  ledger?: { id: string; title: string; status: string }[];
  /** Whether the failing code is in a release (the lab checks the first red commit against the release commits). */
  release?: NightlyRelease;
  compare?: string;
  repro?: string;
}

export interface NightlyReport {
  v: number;
  /** The night ("2026-09-30"), the lab's name and the develop commit it tested. */
  date: string;
  lab: string;
  sha: string;
  /** The release that contains the tested commit, or none yet. */
  release?: NightlyRelease;
  /** Where the night's report.md is: on the lab, and BEAST's copy. */
  report?: { lab?: string; beast?: string };
  results: NightlyResult[];
  /**
   * How the night went (w864; a lab from before says nothing, and its results decide): passed, failed (a new or still
   * failing scenario), or broken (one cause, a failed build or a startup error across the battery, the lab; its
   * results are not filed one by one). A broken night may have no commit yet (sha "").
   */
  status?: 'passed' | 'failed' | 'broken';
  cause?: string;
  counts?: NonNullable<NightlyNight['counts']>;
  /** The portal's run request that started the night ("w901"), when a worker did. */
  request?: string;
}

const SCENARIO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SHA = /^[0-9a-f]{7,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const SCENARIO_FILE = /^scripts\/nightly\/scenarios\/[\w.-]+\.json$/;
const COMPARE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/compare\/[0-9a-f]{7,40}\.\.\.[0-9a-f]{7,40}$/;

const str = (v: unknown, max: number) => (typeof v === 'string' ? cleanLine(v, max) : '');
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function nightSha(v: unknown): { night: string; sha: string } | undefined {
  const o = obj(v);
  const night = str(o?.night, 20);
  const sha = str(o?.sha, 40).toLowerCase();
  return DATE.test(night) && SHA.test(sha) ? { night, sha } : undefined;
}

function release(v: unknown): NightlyRelease | undefined {
  const o = obj(v);
  if (!o || !['yes', 'maybe', 'no'].includes(o.shipped as string)) return undefined;
  const version = str(o.version, 40);
  const sha = str(o.sha, 40).toLowerCase();
  const latest = str(o.latest, 40);
  const shipped = o.shipped as NightlyRelease['shipped'];
  return {
    // A release that ships it names its version; without one it cannot say it shipped.
    shipped: shipped !== 'no' && !VERSION.test(version) ? 'no' : shipped,
    ...(shipped !== 'no' && VERSION.test(version) ? { version } : {}),
    ...(shipped !== 'no' && SHA.test(sha) ? { sha } : {}),
    ...(VERSION.test(latest) ? { latest } : {}),
  };
}

/** A night's report as the lab posted it, checked field by field: a report, or why it is refused. */
export function parseNightlyReport(body: unknown): { report: NightlyReport } | { error: string } {
  const b = obj(body);
  if (!b) return { error: 'expected a JSON object' };
  if (b.v !== NIGHTLY_REPORT_VERSION)
    return {
      error: `unknown report version ${JSON.stringify(b.v)} (this portal reads ${NIGHTLY_REPORT_VERSION})`,
    };
  const date = str(b.date, 20);
  const lab = str(b.lab, 40);
  const sha = str(b.sha, 40).toLowerCase();
  if (!DATE.test(date)) return { error: 'date must be YYYY-MM-DD' };
  if (!/^[\w.-]{1,40}$/.test(lab)) return { error: 'lab must be a name (letters, digits, . _ -)' };
  const status = ['passed', 'failed', 'broken'].includes(b.status as string) ? (b.status as NightlyReport['status']) : undefined;
  if (b.status !== undefined && !status) return { error: 'status must be passed, failed or broken' };
  // A broken night may end before it knows the commit (the fetch failed).
  if (!/^[0-9a-f]{40}$/.test(sha) && !(status === 'broken' && sha === '')) return { error: 'sha must be the full 40-character commit' };
  if (!Array.isArray(b.results)) return { error: 'results must be a list' };
  const results: NightlyResult[] = [];
  for (const raw of b.results.slice(0, MAX_RESULTS)) {
    const r = obj(raw);
    const scenario = str(r?.scenario, 80);
    if (!r || !SCENARIO.test(scenario) || !['new', 'still', 'flaky'].includes(r.class as string)) continue;
    const ledger = Array.isArray(r.ledger)
      ? r.ledger
          .map(obj)
          .filter((e): e is Record<string, unknown> => !!e && /^[\w.-]{1,20}$/.test(String(e.id ?? '')))
          .slice(0, 5)
          .map((e) => ({
            id: String(e.id),
            title: str(e.title, 160),
            status: str(e.status, 20) || 'open',
          }))
      : [];
    const compare = str(r.compare, 200);
    const file = str(r.file, 120);
    const rel = release(r.release);
    const lastGreen = nightSha(r.lastGreen);
    const firstRed = nightSha(r.firstRed);
    results.push({
      scenario,
      class: r.class as NightlyClass,
      ...(str(r.title, 160) ? { title: str(r.title, 160) } : {}),
      ...(SCENARIO_FILE.test(file) ? { file } : {}),
      ...(str(r.step, 200) ? { step: str(r.step, 200) } : {}),
      ...(str(r.reason, 600) ? { reason: str(r.reason, 600) } : {}),
      ...(str(r.firstTry, 400) ? { firstTry: str(r.firstTry, 400) } : {}),
      ...(str(r.evidence, 300) ? { evidence: str(r.evidence, 300) } : {}),
      ...(Array.isArray(r.desyncReports) && r.desyncReports.length
        ? {
            desyncReports: r.desyncReports
              .slice(0, 6)
              .map((x) => str(x, 200))
              .filter(Boolean),
          }
        : {}),
      ...(lastGreen ? { lastGreen } : {}),
      ...(firstRed ? { firstRed } : {}),
      ...(typeof r.flakyNights === 'number' && Number.isFinite(r.flakyNights) ? { flakyNights: Math.max(0, Math.min(365, Math.round(r.flakyNights))) } : {}),
      ...(ledger.length ? { ledger } : {}),
      ...(rel ? { release: rel } : {}),
      ...(COMPARE.test(compare) ? { compare } : {}),
      ...(str(r.repro, 400) ? { repro: str(r.repro, 400) } : {}),
    });
  }
  const rep = obj(b.report);
  const rel = release(b.release);
  const c = obj(b.counts);
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(10_000, Math.round(v))) : 0);
  const request = str(b.request, 12);
  return {
    report: {
      v: NIGHTLY_REPORT_VERSION,
      date,
      lab,
      sha,
      ...(status ? { status } : {}),
      ...(str(b.cause, 600) ? { cause: str(b.cause, 600) } : {}),
      ...(c ? { counts: { ran: count(c.ran), passed: count(c.passed), failed: count(c.failed), flaky: count(c.flaky), env: count(c.env) } } : {}),
      ...(/^w\d{1,7}$/.test(request) ? { request } : {}),
      ...(rel ? { release: rel } : {}),
      ...(rep
        ? {
            report: {
              ...(str(rep.lab, 300) ? { lab: str(rep.lab, 300) } : {}),
              ...(str(rep.beast, 300) ? { beast: str(rep.beast, 300) } : {}),
            },
          }
        : {}),
      results,
    },
  };
}

/** Why a result does not become work: a flaky scenario below the nights threshold. Undefined when it does. */
export function nightlySkip(r: NightlyResult, s: IntakeSettings['nightly']): string | undefined {
  if (r.class !== 'flaky') return undefined;
  const n = r.flakyNights ?? 1;
  return n >= s.flakyNights ? undefined : `flaky ${n} night(s) running, under the ${s.flakyNights} that file it`;
}

/** Urgent when the failing code shipped to players; high otherwise (Ben, 2026-09-30). */
export function nightlyPriority(results: readonly NightlyResult[]): WorkPriority {
  return results.some((r) => r.release?.shipped === 'yes') ? 'urgent' : 'high';
}

const short = (sha: string) => sha.slice(0, 9);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** "shipped in 0.50.0.53", "may have shipped in 0.50.0.53", "in no release yet (newest 0.50.0.53)". */
export function releaseLine(rel: NightlyRelease | undefined): string {
  if (!rel) return 'unknown (the lab could not check the releases)';
  if (rel.shipped === 'yes') return `shipped in ${rel.version} (the first release that contains the first failing commit${rel.sha ? `, ${short(rel.sha)}` : ''})`;
  if (rel.shipped === 'maybe') return `may have shipped in ${rel.version} (a release between the last green and the first red night${rel.sha ? `, ${short(rel.sha)}` : ''}; bisect to tell)`;
  return `in no release yet${rel.latest ? ` (newest release ${rel.latest})` : ''}`;
}

function what(r: NightlyResult): string {
  if (r.class === 'flaky') return `flaky ${r.flakyNights ?? '?'} nights running`;
  return r.class === 'still' ? 'still failing' : 'new regression';
}

/** The request's title for one scenario. */
export function nightlyTitle(r: NightlyResult, sha: string): string {
  const where = r.release?.shipped === 'yes' ? ` (shipped in ${r.release.version})` : '';
  const head = r.class === 'flaky' ? `${r.scenario} flaky ${r.flakyNights ?? '?'} nights running` : `${r.scenario} fails on develop ${short(sha)}`;
  return clip(`Nightly e2e: ${head}${where}`, 120);
}

/** The facts of one scenario, as a brief's section. */
export function scenarioBlock(r: NightlyResult): string[] {
  return [
    `### ${r.scenario} (${what(r)})`,
    `- Scenario: ${r.scenario}${r.title ? `, "${r.title}"` : ''}${r.file ? ` (\`${r.file}\`)` : ''}`,
    `- Oracle: ${r.step ? `failed at step ${r.step}: ` : ''}${r.reason ?? 'no reason recorded'}`,
    ...(r.firstTry ? [`- First try said: ${r.firstTry}`] : []),
    `- Last green night: ${r.lastGreen ? `${r.lastGreen.night} (\`${short(r.lastGreen.sha)}\`)` : 'none on record'}; first red night: ${r.firstRed ? `${r.firstRed.night} (\`${short(r.firstRed.sha)}\`)` : 'tonight'}`,
    ...(r.compare ? [`- Commits in between: ${r.compare}`] : []),
    `- Release: ${releaseLine(r.release)}`,
    ...(r.ledger?.length
      ? [`- Regression ledger (\`scripts/nightly/ledger.json\`): ${r.ledger.map((e) => `${e.id} [${e.status}] ${e.title}`).join('; ')}`]
      : ['- Regression ledger: no entry names this scenario']),
    ...(r.evidence ? [`- Evidence on the lab (every peer's log, snapshots, screenshots): \`${r.evidence}\``] : []),
    ...(r.desyncReports?.length ? [`- Desync reports: ${r.desyncReports.map((d) => `\`${d}\``).join(', ')}`] : []),
    ...(r.repro ? [`- Repro: \`${r.repro}\``] : []),
  ];
}

const TODO = [
  'What to do: reproduce it first (the repro line above, on a player built from the commit tested). Then either fix the game bug, or, when the scenario itself is wrong, fix the scenario and say why with the evidence. Never weaken an oracle to make a real regression pass.',
  'For the dispatcher: this is determinism-critical work; start its worker on Opus (model opus). One worker may take several nightly requests from the same night (decide_work link).',
];

function header(rep: NightlyReport): string[] {
  return [
    `The nightly e2e lab \`${rep.lab}\` ran the battery on ${rep.date} against develop \`${rep.sha}\`.`,
    `- The commit tested is ${releaseLine(rep.release)}.`,
    ...(rep.report?.lab || rep.report?.beast
      ? [
          `- The night's report: ${[rep.report.lab && `\`${rep.report.lab}\` on ${rep.lab}`, rep.report.beast && `\`${rep.report.beast}\` on BEAST`].filter(Boolean).join(', ')}; Max posts its TL;DR in #dev-chat with the report attached.`,
        ]
      : []),
  ];
}

/** The keys that make a later night's result the same work: `nightly:<scenario>` (server/intakeRules.ts identityKeys). */
export const nightlyKey = (scenario: string) => `nightly:${scenario.toLowerCase()}`;

/** The request for one scenario, or for a night's batch when more fail at once than intake.nightly.batchOver. */
export function nightlyDraft(rep: NightlyReport, results: readonly NightlyResult[]): IntakeDraft & { priority: WorkPriority; triage: WorkTriage } {
  const batch = results.length > 1;
  const release = results.find((r) => r.release?.shipped === 'yes')?.release ?? results.find((r) => r.release?.shipped === 'maybe')?.release ?? rep.release;
  const title = batch
    ? clip(`Nightly e2e ${rep.date}: ${results.length} regressions on develop ${short(rep.sha)}${results.some((r) => r.release?.shipped === 'yes') ? ' (some shipped)' : ''}`, 120)
    : nightlyTitle(results[0], rep.sha);
  const brief = [
    ...header(rep),
    ...(batch
      ? [
          `- ${results.length} scenarios failed at once, more than intake.nightly.batchOver, so they are one request: often one cause (a broken build, the lab). Split it with decide_work if they turn out to differ.`,
        ]
      : []),
    '',
    ...results.flatMap((r) => [...scenarioBlock(r), '']),
    ...TODO,
  ].join('\n');
  return {
    title,
    brief: clip(brief, 7800),
    priority: nightlyPriority(results),
    triage: {
      class: 'regression',
      reason: `nightly e2e: ${batch ? `${results.length} scenarios` : what(results[0])} on develop ${short(rep.sha)}, ${release?.shipped === 'yes' ? `shipped in ${release.version}` : release?.shipped === 'maybe' ? `may have shipped in ${release.version}` : 'not released yet'}`,
    },
    source: {
      kind: 'nightly',
      untrusted: false,
      channel: 'nightly e2e',
      ...(results.length === 1 && results[0].compare ? { url: results[0].compare } : {}),
      ...(release?.version && release.shipped !== 'no' ? { version: release.version } : {}),
      nightly: {
        scenarios: results.map((r) => r.scenario),
        date: rep.date,
        lab: rep.lab,
        sha: rep.sha,
        nights: results.map((r) => `${rep.date} ${r.scenario}`),
        ...(release ? { release } : {}),
      },
    },
  };
}

/** The line a later night adds to the open request already on a scenario (once per night and scenario). */
export function nightlyAgainLine(rep: NightlyReport, r: NightlyResult): string {
  return `nightly ${rep.date}: ${r.scenario} ${r.class === 'flaky' ? `flaky again (${r.flakyNights ?? '?'} nights running)` : 'failed again'} on develop ${short(rep.sha)}${r.reason ? `: ${clip(r.reason, 160)}` : ''}; ${releaseLine(r.release)}`;
}

/** How the night went: what the lab said, else (a lab from before w864) red when a scenario is new or still failing. */
export function nightStatus(rep: NightlyReport): 'passed' | 'failed' | 'broken' {
  return rep.status ?? (rep.results.some((r) => r.class !== 'flaky') ? 'failed' : 'passed');
}

/** The key of a broken night's request: later broken nights join the open one (one cause until someone fixes it). */
export const NIGHT_BROKEN = 'night-broken';

/** The one request for a broken night (w864): find the cause, the game or the lab, instead of N regressions. */
export function brokenNightDraft(rep: NightlyReport, runId?: string): IntakeDraft & { priority: WorkPriority; triage: WorkTriage } {
  const at = rep.sha ? ` on develop ${short(rep.sha)}` : '';
  return {
    title: clip(`Nightly e2e ${rep.date}: the night broke${at}: ${rep.cause ?? 'no reason given'}`, 120),
    brief: clip(
      [
        `The nightly e2e lab \`${rep.lab}\` reported the night ${rep.date} broken${at}: one cause stopped the battery, so its scenarios have no verdict and none is filed as a regression.`,
        `- Cause, as the lab saw it: ${rep.cause ?? 'none given'}`,
        ...(rep.counts ? [`- Counts: ${rep.counts.ran} ran, ${rep.counts.passed} passed, ${rep.counts.failed} failed, ${rep.counts.env} could not run.`] : []),
        ...(rep.report?.lab ? [`- The night's report (or its no-verdict note) on ${rep.lab}: \`${rep.report.lab}\`; its log is logs/nightly-${rep.date}.log in the same nightly root.`] : []),
        ...(runId ? [`- The run request: ${runId}.`] : []),
        `- The commit tested is ${releaseLine(rep.release)}.`,
        '',
        'What to do: find whether the cause is in the game (a startup error, a failed build of develop: fix it like any regression, red before and green after) or in the lab (the machine, the scripts in scripts/nightly, a missing tool or file: fix the lab). Rerun a few scenarios on a player built from that commit to show which (python3 scripts/nightly/ffnightly.py run --scenario <id> --no-retry). Do not change any oracle or allowlist to make the night pass.',
      ].join('\n'),
      7800,
    ),
    priority: rep.release?.shipped === 'yes' ? 'urgent' : 'high',
    triage: { class: 'regression', reason: `nightly e2e: the night ${rep.date} broke${at}` },
    source: {
      kind: 'nightly',
      untrusted: false,
      channel: 'nightly e2e',
      nightly: { scenarios: [NIGHT_BROKEN], date: rep.date, lab: rep.lab, sha: rep.sha, nights: [`${rep.date} ${NIGHT_BROKEN}`], ...(rep.release ? { release: rep.release } : {}) },
    },
  };
}

/** The night's run request the portal's nightly schedule files (w864; docs/intake.md, "The nightly run"). */
export function nightlyRunDraft(a: { date: string; machine: string; time: string; tz: string; dueBy: string }): IntakeDraft & { priority: WorkPriority; triage: WorkTriage; constraints: string } {
  return {
    title: `Nightly e2e run ${a.date} on ${a.machine}`,
    brief: [
      `Run the nightly e2e lab for the night ${a.date} on ${a.machine}, filed by the portal's nightly schedule (${a.time} ${a.tz}). The intake rules below say how: start it with scripts/nightly/nightly_worker.sh, check it at every check-in, and end with its outcome once it has delivered.`,
      `- Its report must reach FF Factory by ${a.dueBy}; with none by then, the portal raises the missing-night alarm.`,
      '- The lab posts its own summary in #dev-chat as Max and files its regressions through the nightly intake: nothing to post or file by hand.',
      '- For the dispatcher: the worker mostly waits and reads a report (a check every 25 minutes for about two and a half hours), so start it on Sonnet at medium effort.',
    ].join('\n'),
    priority: 'normal',
    triage: { class: 'follow-up', reason: `the nightly e2e run of ${a.date}, filed by the portal's schedule` },
    constraints: `Run it on ${a.machine}, in one of its sandboxes, and nowhere else: Lothsahn chose ${a.machine} for the nightly run ("Create a portal timer that happens and when it does it triggers a run on LothDesktop to do the desync run", 2026-10-10), the one exception to his rule that work avoids it.`,
    source: { kind: 'nightly-run', untrusted: false, channel: 'nightly e2e', nightlyRun: { date: a.date, machine: a.machine } },
  };
}

/** Whether open work names a scenario: its id as a whole word in the title or brief (a person filed the fix by hand). */
export function mentionsScenario(text: string, scenario: string): boolean {
  const esc = scenario.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, 'i').test(text);
}
