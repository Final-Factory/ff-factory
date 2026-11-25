/**
 * CI: fail when a production dependency of the server (the repo root) or the web UI (web/) has a high or critical
 * advisory (w5519, finding 13 of the w5452 security audit; lothsahn: "npm audit fix plus an audit step in CI").
 *
 *   node scripts/audit-gate.ts            audits . and web, as CI does
 *
 * It runs `npm audit --omit=dev --audit-level=high --json` in each project (from the lockfile; no install needed) and
 * fails on every high or critical advisory that .github/npm-audit-allow.json does not allow. An advisory's own severity
 * counts, not its package's: a moderate advisory in a package that also has a high one is not gated.
 *
 * The allowlist is for an advisory with no fix yet, and is narrow on purpose (docs/ci.md, "npm audit"): each entry
 * names one advisory (GHSA id) in one package in one project, with a reason, the request that added it and an `until`
 * date at most 90 days away. An expired entry fails, and so does an entry that no longer matches anything, so the list
 * holds only advisories that are still open.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const PROJECTS = ['.', 'web'] as const;
export const ALLOW_FILE = '.github/npm-audit-allow.json';
export const MAX_ALLOW_DAYS = 90;
const GATED = new Set(['high', 'critical']);

export interface Advisory {
  project: string;
  package: string;
  id: string;
  severity: string;
  title: string;
  url: string;
}

export interface AllowEntry {
  advisory: string;
  package: string;
  project: string;
  reason: string;
  request: string;
  until: string;
}

interface AuditVia {
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
}

interface AuditReport {
  vulnerabilities?: Record<string, { via?: (string | AuditVia)[] }>;
  error?: { code?: string; summary?: string; detail?: string };
}

const advisoryId = (url: string) => url.split('/').filter(Boolean).pop() ?? url;

/** The high and critical advisories of one `npm audit --json` report, each once. */
export function gatedAdvisories(project: string, report: AuditReport): Advisory[] {
  if (report.error) throw new Error(`npm audit failed in ${project}: ${report.error.code ?? ''} ${report.error.summary ?? ''}`.trim());
  const seen = new Map<string, Advisory>();
  for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === 'string' || !via.url || !GATED.has(via.severity ?? '')) continue;
      const a: Advisory = {
        project,
        package: via.name ?? pkg,
        id: advisoryId(via.url),
        severity: via.severity!,
        title: via.title ?? '',
        url: via.url,
      };
      seen.set(`${a.package}\0${a.id}`, a);
    }
  }
  return [...seen.values()];
}

const DAY_MS = 86_400_000;

/** The allowlist's own problems: a malformed, too long or expired entry. */
export function allowProblems(allow: AllowEntry[], today: Date): string[] {
  const problems: string[] = [];
  allow.forEach((e, i) => {
    const at = `${ALLOW_FILE} entry ${i + 1} (${e.advisory ?? '?'})`;
    if (!/^GHSA(-[0-9a-z]{4}){3}$/.test(e.advisory ?? '')) problems.push(`${at}: "advisory" must be one GHSA id`);
    if (!e.package) problems.push(`${at}: "package" is required`);
    if (!(PROJECTS as readonly string[]).includes(e.project)) problems.push(`${at}: "project" must be one of ${PROJECTS.join(', ')}`);
    if (!e.reason || e.reason.trim().length < 20) problems.push(`${at}: "reason" must say why (no fix yet, not reachable, ...)`);
    if (!/^w\d+$/.test(e.request ?? '')) problems.push(`${at}: "request" must name the request that allowed it (wNNN)`);
    const until = /^\d{4}-\d{2}-\d{2}$/.test(e.until ?? '') ? Date.parse(`${e.until}T23:59:59Z`) : NaN;
    if (Number.isNaN(until)) problems.push(`${at}: "until" must be a date, YYYY-MM-DD`);
    else if (until < today.getTime()) problems.push(`${at}: expired on ${e.until}; fix it or renew it with a reason`);
    else if (until > today.getTime() + MAX_ALLOW_DAYS * DAY_MS) problems.push(`${at}: "until" is more than ${MAX_ALLOW_DAYS} days away`);
  });
  return problems;
}

/** Every failure: gated advisories not allowed, allowlist problems, and entries that match nothing any more. */
export function evaluate(advisories: Advisory[], allow: AllowEntry[], today: Date): { failures: string[]; allowed: Advisory[] } {
  const failures = allowProblems(allow, today);
  const matches = (e: AllowEntry, a: Advisory) => e.advisory === a.id && e.package === a.package && e.project === a.project;
  const allowed: Advisory[] = [];
  for (const a of advisories) {
    if (allow.some((e) => matches(e, a))) allowed.push(a);
    else failures.push(`${a.project}: ${a.package} ${a.severity}: ${a.title} (${a.url})`);
  }
  for (const e of allow) {
    if (!advisories.some((a) => matches(e, a))) failures.push(`${ALLOW_FILE}: ${e.advisory} in ${e.package} (${e.project}) matches nothing now; remove it`);
  }
  return { failures, allowed };
}

function audit(root: string, project: string): AuditReport {
  try {
    const out = execFileSync('npm', ['audit', '--omit=dev', '--audit-level=high', '--json'], {
      cwd: path.join(root, project),
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits 1 when it finds anything; its report is still on stdout.
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) return JSON.parse(stdout);
    throw err;
  }
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const root = path.resolve(import.meta.dirname, '..');
  const allow: AllowEntry[] = JSON.parse(readFileSync(path.join(root, ALLOW_FILE), 'utf8')).allow ?? [];
  const advisories = PROJECTS.flatMap((p) => gatedAdvisories(p, audit(root, p)));
  const { failures, allowed } = evaluate(advisories, allow, new Date());
  for (const a of allowed) console.log(`allowed by ${ALLOW_FILE}: ${a.project}: ${a.package} ${a.id} (${a.severity})`);
  if (failures.length) {
    console.error(`npm audit (production dependencies, high and critical): ${failures.length} problem(s)`);
    for (const f of failures) console.error(`  ${f}`);
    console.error(`Fix: npm audit fix (or a targeted bump) in that project; with no fix yet, see docs/ci.md, "npm audit".`);
    process.exit(1);
  }
  console.log(`npm audit: no high or critical advisory in the production dependencies of ${PROJECTS.join(' and ')}`);
}
