// w3758 (lothsahn: "find what spends the GitHub API rate limit of the vault token ... and stop the waste"): the portal's
// GitHub REST reads made conditional, the budget GitHub reports on each answer, and a count of the portal's gh calls by caller.
//
// - ghGet: `gh api -i` with If-None-Match on the ETag of the last answer to the same path. GitHub answers 304 Not Modified when
//   nothing changed, and a 304 costs no REST budget (measured 2026-11-09 00:07Z on ffu's actions/runs: X-RateLimit-Used stayed
//   at 38 over three 304s, the next 200 made it 39). gh exits 1 on a 304 ("gh: HTTP 304") with the headers on stdout.
// - budgetOf: the REST budget the last answer on a credential reported (X-RateLimit-Remaining and -Reset), so a poller backs
//   off when few calls are left and reads nothing while it is spent.
// - noteGhCall / ghCallLine: every gh call the portal makes through ghRunner, counted by caller ("CI on <pr>", "the head of
//   <pr>"), REST or GraphQL, 304s and refusals apart, and logged with the token's own budget every GH_CALLS_LOG_MS.
import type { RunOptions, RunResult } from './proc.ts';

type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** The REST budget GitHub reported on a credential's last answer. */
export interface Budget {
  remaining: number;
  /** When it refills (ms). */
  resetAt: number;
  /** When it was read (ms). */
  at: number;
}

/** Below this many REST calls left, the portal's pollers read every GH_LOW_EVERY_MS instead of every two minutes. */
export const GH_LOW_REMAINING = 500;
export const GH_LOW_EVERY_MS = 10 * 60_000;

const budgets = new Map<string, Budget>();

/** The REST budget last seen for `who` (a person's token, or "portal" for the portal's own login); undefined once it has refilled. */
export function budgetOf(who: string | undefined, now = Date.now()): Budget | undefined {
  const b = budgets.get(who ?? 'portal');
  return b && b.resetAt > now ? b : undefined;
}

export function noteBudget(who: string | undefined, header: (n: string) => string | undefined, now = Date.now()) {
  if ((header('x-ratelimit-resource') ?? 'core') !== 'core') return;
  const remaining = Number(header('x-ratelimit-remaining'));
  const reset = Number(header('x-ratelimit-reset'));
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || header('x-ratelimit-remaining') === undefined) return;
  budgets.set(who ?? 'portal', { remaining, resetAt: reset * 1000, at: now });
}

/** For tests. */
export const resetBudgets = () => budgets.clear();

/** `gh api -i` output split into status, headers and body (also printed on errors, with exit 1, measured). */
export function splitInclude(out: string): { status: number; header: (n: string) => string | undefined; body: string } | undefined {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\n\n([\s\S]*)$/.exec(out.replace(/\r\n/g, '\n'));
  if (!m) return undefined;
  const headers = new Map(m[2].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()] as const));
  return { status: Number(m[1]), header: (n) => headers.get(n.toLowerCase()), body: m[3] };
}

const CACHE_MAX = 2000;

/** The last good answer to each path, by credential: its ETag and body. */
export class EtagCache {
  private readonly m = new Map<string, { etag: string; body: string }>();
  get(key: string) {
    const e = this.m.get(key);
    if (e) {
      // Most recently used last, so the oldest go first when it is full.
      this.m.delete(key);
      this.m.set(key, e);
    }
    return e;
  }
  set(key: string, etag: string, body: string) {
    this.m.delete(key);
    this.m.set(key, { etag, body });
    while (this.m.size > CACHE_MAX) this.m.delete(this.m.keys().next().value!);
  }
  get size() {
    return this.m.size;
  }
}

const shared = new EtagCache();

/**
 * A GitHub REST GET through gh, conditional on the last answer's ETag: answers like `gh api <path>` (exit 0 and the body on
 * stdout; else gh's exit, its words on stderr and the body on stdout), with an unchanged answer (304) served from the cache.
 * `who` keys the cache and the budget by credential (one person's token may not see what another's does).
 */
export async function ghGet(run: Runner, path: string, opts: RunOptions, who?: string, cache: EtagCache = shared): Promise<RunResult> {
  const key = `${who ?? 'portal'} ${path}`;
  const last = cache.get(key);
  const r = await run('gh', ['api', '-i', ...(last ? ['-H', `If-None-Match: ${last.etag}`] : []), path], opts);
  const a = splitInclude(r.stdout);
  if (!a) return r;
  noteBudget(who, a.header);
  if (a.status === 304 && last) return { code: 0, stdout: last.body, stderr: '' };
  if (a.status >= 200 && a.status < 300) {
    const etag = a.header('etag');
    if (etag) cache.set(key, etag, a.body);
    return { code: 0, stdout: a.body, stderr: r.stderr };
  }
  return { code: r.code || 1, stdout: a.body, stderr: r.stderr || a.body };
}

// ---------------------------------------------------------------- the count by caller

/** How often the count is logged (and the token's budget read, which GitHub does not charge for). */
export const GH_CALLS_LOG_MS = 15 * 60_000;

type Count = { rest: number; notModified: number; graphql: number; refused: number; rateLimited: number };
const counts = new Map<string, Count>();

/** The caller with its pull request or commit taken out: "CI on Final-Factory/ffu#518" is "CI on <pr>". */
export const callerOf = (what: string) =>
  what
    .replace(/[\w.-]+\/[\w.-]+#\d+/g, '<pr>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'unnamed';

/** Whether a gh call is GraphQL (`gh pr ...`, `gh api graphql`, `gh repo view`...) rather than a REST call. */
export const isGraphql = (args: readonly string[]) => (args[0] === 'api' ? args.includes('graphql') : ['pr', 'repo', 'issue'].includes(args[0] ?? ''));

/** Count one gh call the portal made for `what`. */
export function noteGhCall(what: string, args: readonly string[], r: RunResult) {
  if (!args.length || ['auth', 'version', 'config'].includes(args[0])) return;
  // The rate-limit read is free (GitHub does not charge for GET /rate_limit) and is the measurement itself.
  if (args.includes('rate_limit')) return;
  const k = callerOf(what);
  const c = counts.get(k) ?? { rest: 0, notModified: 0, graphql: 0, refused: 0, rateLimited: 0 };
  const out = `${r.stdout.slice(0, 64)}\n${r.stderr.slice(0, 400)}`;
  if (isGraphql(args)) c.graphql++;
  else if (/^HTTP\/[\d.]+ 304/.test(r.stdout) || /HTTP 304/.test(r.stderr)) c.notModified++;
  else c.rest++;
  if (r.code !== 0 && /rate limit exceeded|secondary rate limit/i.test(out)) c.rateLimited++;
  else if (r.code !== 0 && !/HTTP 304/.test(out)) c.refused++;
  counts.set(k, c);
}

/** The count since the last call, busiest REST caller first, and starts a new one: "CI on <pr>: rest 40, 304 120, graphql 30, refused 2". */
export function takeGhCalls(): { caller: string; count: Count }[] {
  const out = [...counts].map(([caller, count]) => ({ caller, count })).sort((a, b) => b.count.rest - a.count.rest || b.count.graphql - a.count.graphql);
  counts.clear();
  return out;
}

export function ghCallLine(rows: readonly { caller: string; count: Count }[], minutes: number, budget?: { coreUsed: number; coreLimit: number; coreReset: number; graphqlUsed: number }, now = Date.now()): string {
  const sum = rows.reduce((s, r) => s + r.count.rest, 0);
  const g = rows.reduce((s, r) => s + r.count.graphql, 0);
  const nm = rows.reduce((s, r) => s + r.count.notModified, 0);
  const parts = rows.map((r) => {
    const c = r.count;
    return `${r.caller}: rest ${c.rest}${c.notModified ? `, 304 ${c.notModified}` : ''}${c.graphql ? `, graphql ${c.graphql}` : ''}${c.refused ? `, refused ${c.refused}` : ''}${c.rateLimited ? `, rate limited ${c.rateLimited}` : ''}`;
  });
  const b = budget ? `; the token's budget: REST ${budget.coreUsed} of ${budget.coreLimit} used, refills in ${Math.max(0, Math.round((budget.coreReset * 1000 - now) / 60_000))} min; GraphQL ${budget.graphqlUsed} used` : '';
  return `github calls, last ${minutes} min, the portal's: REST ${sum} (+${nm} free 304s), GraphQL ${g}${b}${parts.length ? ` | ${parts.join(' | ')}` : ''} (w3758)`;
}

/**
 * Logs the count by caller every GH_CALLS_LOG_MS with the token's own budget beside it (GET /rate_limit, free), so the
 * calls the portal does not make (the workers' gh and ff-pr) are the difference between the two.
 */
export function startGhCallLog(run: Runner, log: (line: string) => void = console.log): () => void {
  let last = Date.now();
  const t = setInterval(() => {
    void (async () => {
      const rows = takeGhCalls();
      const now = Date.now();
      const minutes = Math.round((now - last) / 60_000);
      last = now;
      let budget: Parameters<typeof ghCallLine>[2];
      try {
        const r = await run('gh', ['api', 'rate_limit'], { timeoutMs: 30_000 });
        const j = JSON.parse(r.stdout) as { resources?: { core?: { used: number; limit: number; reset: number }; graphql?: { used: number } } };
        if (r.code === 0 && j.resources?.core) budget = { coreUsed: j.resources.core.used, coreLimit: j.resources.core.limit, coreReset: j.resources.core.reset, graphqlUsed: j.resources.graphql?.used ?? 0 };
      } catch {
        // No budget line this time; the count stands alone.
      }
      log(ghCallLine(rows, minutes, budget, now));
    })();
  }, GH_CALLS_LOG_MS);
  t.unref?.();
  return () => clearInterval(t);
}
