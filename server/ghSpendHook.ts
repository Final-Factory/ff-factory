// w3758 (lothsahn, through the orchestrator: "check whether one worker's bulk API reads can starve the portal's pollers, and
// add a guard"). They can: w3747's timing scripts read the last 1,000 runs of ffu and of the game repo through the API and spent
// the shared lothsahn token's REST budget from about 23:00 to 00:02 UTC on 2026-11-09; the portal's CI waits then read nothing
// (and, before this request's fix, cleared) and ffu#518's `ff-pr merge` failed with "rate limit exceeded". The sampler of this
// request saw about 1,000 calls in three minutes at 00:08Z, while the portal's own reads spend a few a minute.
//
// The hooks of a worker that holds a vault GitHub token (GH_TOKEN), on every machine:
// - PreToolUse: a Bash command that can call GitHub (gh, curl, a script) is refused while the token has fewer than
//   GH_RESERVE calls left before it refills, so the last of them stay for the portal's CI waits and the workers' merges;
//   `ff-pr` (status and merge), `gh pr merge` and the rate-limit read itself are never held.
// - PostToolUse: when the token's count rose by GH_SPEND_WARN or more while one command ran, the worker reads how much went
//   and how to read less (the rise counts every caller of the token in that time, so it says "about").
// The budget is read from GET /rate_limit, which GitHub does not charge for, at most once every READ_EVERY_MS for the refusal.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/** Calls kept for the portal's CI waits and the workers' merges: below this, other GitHub commands wait for the refill. */
export const GH_RESERVE = 750;
/** A rise this big in the token's count during one command earns the worker a line about it. */
export const GH_SPEND_WARN = 300;
const READ_EVERY_MS = 30_000;

export interface CoreBudget {
  limit: number;
  used: number;
  remaining: number;
  /** When it refills (seconds since the epoch, as GitHub says). */
  reset: number;
}

export type BudgetReader = () => Promise<CoreBudget | undefined>;

/** GET /rate_limit with the token (free), the core (REST) budget; undefined when it cannot be read. */
export function rateLimitReader(token: string, fetcher: typeof fetch = fetch): BudgetReader {
  return async () => {
    try {
      const r = await fetcher('https://api.github.com/rate_limit', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) return undefined;
      const core = ((await r.json()) as { resources?: { core?: CoreBudget } }).resources?.core;
      return core && Number.isFinite(core.used) && Number.isFinite(core.reset) ? core : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Whether a Bash command can call GitHub's API: gh, curl or wget, or a script or interpreter that may (a guess, broad on purpose). */
export function mayCallGithub(command: string): boolean {
  return /(^|[\s;&|(`$])(gh|ff-pr|curl|wget|python3?|node|bash|sh|zsh|pwsh|uv|npx|tsx|deno|ruby|perl)(\s|$)|(^|[;&|(]\s*)\S+\.(py|sh|ts|mjs|js|ps1)(\s|$)|api\.github\.com/.test(command);
}

/** Commands never held: the merges and CI reads the reserve is for, and the budget read itself. */
export function exemptFromReserve(command: string): boolean {
  return /(^|[\s;&|(])ff-pr(\s|$)|\bgh\s+pr\s+merge\b|\bgh\s+api\s+rate_limit\b|\bgh\s+auth\b/.test(command);
}

const hhmm = (resetS: number) => new Date(resetS * 1000).toISOString().slice(11, 16);

export function reserveRefusal(b: CoreBudget, nowMs: number): string | undefined {
  if (b.remaining >= GH_RESERVE || b.reset * 1000 <= nowMs) return undefined;
  return (
    `GitHub's API budget of the shared token is down to ${b.remaining} of ${b.limit} calls until it refills at ${hhmm(b.reset)}Z ` +
    `(${Math.max(1, Math.round((b.reset * 1000 - nowMs) / 60_000))} min). The last ${GH_RESERVE} are kept for the portal's CI waits and ` +
    `merges (w3758), so this command, which may call GitHub, waits until then: set a check-in (wake_me) past ${hhmm(b.reset)}Z, or carry on ` +
    `with work that needs no GitHub. ff-pr status and merge still run. If a script of yours spent it, read less next time: ` +
    `per_page=100, only the fields and runs you need, and the answers saved to a file instead of read again.`
  );
}

export function spendNote(before: CoreBudget, after: CoreBudget): string | undefined {
  if (after.reset !== before.reset) return undefined;
  const spent = after.used - before.used;
  if (spent < GH_SPEND_WARN) return undefined;
  return (
    `That command spent about ${spent} of the shared GitHub token's ${after.limit} REST calls an hour (the token's count rose by that ` +
    `while it ran; other callers in that time count too): ${after.remaining} are left until ${hhmm(after.reset)}Z, and the portal's CI ` +
    `waits and everyone's merges share them. Below ${GH_RESERVE} left, GitHub commands are held until the refill (w3758). ` +
    `Read less: per_page=100 with only the runs or fields you need, save the answers to a file and reuse them, or spread a bulk read over hours.`
  );
}

/**
 * The PreToolUse and PostToolUse hooks of one worker process with a vault GitHub token. `read` is the token's rate-limit read
 * (rateLimitReader); it fails open: a budget it cannot read holds nothing.
 */
export function ghSpendHooks(read: BudgetReader, now: () => number = Date.now): { pre: HookCallback; post: HookCallback } {
  let cached: { at: number; b: CoreBudget | undefined } | undefined;
  const before = new Map<string, CoreBudget>();
  const commandOf = (input: unknown) => {
    const i = input as { tool_name?: string; tool_input?: { command?: unknown } };
    return i.tool_name === 'Bash' && typeof i.tool_input?.command === 'string' ? i.tool_input.command : undefined;
  };
  const fresh = async () => {
    const b = await read();
    cached = { at: now(), b };
    return b;
  };
  const pre: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const command = commandOf(input);
    if (!command || !mayCallGithub(command)) return {};
    const b = cached && now() - cached.at < READ_EVERY_MS ? cached.b : await fresh();
    if (!b) return {};
    const why = exemptFromReserve(command) ? undefined : reserveRefusal(b, now());
    if (why) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: why } };
    if (toolUseId) {
      // The count before this command, read now (a cached one would count other commands' calls as this one's).
      const start = cached && now() - cached.at < 2_000 ? b : await fresh();
      if (start) before.set(toolUseId, start);
      while (before.size > 50) before.delete(before.keys().next().value!);
    }
    return {};
  };
  const post: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== 'PostToolUse' || !toolUseId) return {};
    const start = before.get(toolUseId);
    if (!start) return {};
    before.delete(toolUseId);
    const b = await fresh();
    const note = b && spendNote(start, b);
    return note ? { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: note } } : {};
  };
  return { pre, post };
}
