// w3758: one worker's bulk GitHub reads cannot spend the shared token's last calls, and it hears when one command spent hundreds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exemptFromReserve, GH_RESERVE, ghSpendHooks, mayCallGithub, rateLimitReader, type CoreBudget } from './ghSpendHook.ts';

const NOW = Date.parse('2026-11-09T00:05:00Z');
const RESET = Date.parse('2026-11-09T01:02:32Z') / 1000;
const bash = (event: 'PreToolUse' | 'PostToolUse', command: string) => ({ hook_event_name: event, tool_name: 'Bash', tool_input: { command }, session_id: 's', transcript_path: '', cwd: '' }) as never;
const opts = { signal: new AbortController().signal };

test('which commands may call GitHub, and which the reserve never holds', () => {
  for (const c of ['gh run list -R Final-Factory/ffu -L 1000', 'python3 scripts/timing.py', 'cd x && node t.ts', 'curl -s https://api.github.com/repos/a/b', 'bash "$TMPDIR/leg.sh" 1920', 'ff-pr merge', './scripts/runs.py --all']) assert.ok(mayCallGithub(c), c);
  for (const c of ['grep -n foo bar.ts', 'git log --oneline -5', 'ls -la', 'cat ghost.txt']) assert.ok(!mayCallGithub(c), c);
  for (const c of ['ff-pr merge', 'ff-pr status', 'gh pr merge 518 --merge', 'gh api rate_limit']) assert.ok(exemptFromReserve(c), c);
  assert.ok(!exemptFromReserve('gh api repos/a/b/actions/runs --paginate'));
});

test('w3747 as it happened: a bulk read is held once the token is below the reserve, ff-pr merge is not; above it nothing is held', async () => {
  let b: CoreBudget = { limit: 5000, used: 4300, remaining: 700, reset: RESET };
  let reads = 0;
  const { pre } = ghSpendHooks(async () => (reads++, b), () => NOW);
  const held = (await pre(bash('PreToolUse', 'python3 timing.py --runs 1000'), 't1', opts)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(held.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(held.hookSpecificOutput!.permissionDecisionReason!, new RegExp(`down to 700 of 5000 calls until it refills at 01:02Z \\(58 min\\)\\. The last ${GH_RESERVE} are kept`));
  assert.deepEqual(await pre(bash('PreToolUse', 'ff-pr merge'), 't2', opts), {});
  assert.deepEqual(await pre(bash('PreToolUse', 'grep -n x y'), 't3', opts), {}, 'no GitHub: not even read');
  b = { ...b, used: 1000, remaining: 4000 };
  const r0 = reads;
  await new Promise((r) => setTimeout(r, 0));
  const { pre: pre2 } = ghSpendHooks(async () => (reads++, b), () => NOW);
  assert.deepEqual(await pre2(bash('PreToolUse', 'gh run list -L 1000'), 't4', opts), {});
  assert.ok(reads > r0);
  // A budget past its refill time is a stale reading: nothing held.
  const { pre: pre3 } = ghSpendHooks(async () => ({ limit: 5000, used: 4999, remaining: 1, reset: NOW / 1000 - 1 }), () => NOW);
  assert.deepEqual(await pre3(bash('PreToolUse', 'gh api x'), 't5', opts), {});
  // It cannot be read: it fails open.
  const { pre: pre4 } = ghSpendHooks(async () => undefined, () => NOW);
  assert.deepEqual(await pre4(bash('PreToolUse', 'gh api x'), 't6', opts), {});
});

test('a command the token\'s count rose by 300 or more during earns the worker a line; a small one or a refill between does not', async () => {
  let used = 1000;
  let reset = RESET;
  const { pre, post } = ghSpendHooks(async () => ({ limit: 5000, used, remaining: 5000 - used, reset }), () => NOW);
  await pre(bash('PreToolUse', 'python3 timing.py'), 'a', opts);
  used += 950;
  const out = (await post(bash('PostToolUse', 'python3 timing.py'), 'a', opts)) as { hookSpecificOutput?: { additionalContext?: string } };
  assert.match(out.hookSpecificOutput!.additionalContext!, /^That command spent about 950 of the shared GitHub token's 5000 REST calls an hour .*3050 are left until 01:02Z/);
  await pre(bash('PreToolUse', 'gh pr view 1'), 'b', opts);
  used += 3;
  assert.deepEqual(await post(bash('PostToolUse', 'gh pr view 1'), 'b', opts), {});
  await pre(bash('PreToolUse', 'gh run list'), 'c', opts);
  reset += 3600;
  used = 900;
  assert.deepEqual(await post(bash('PostToolUse', 'gh run list'), 'c', opts), {}, 'refilled in between: no rise to count');
});

test('rateLimitReader: the core budget with the token as a Bearer header; an error or a refusal is undefined', async () => {
  let auth = '';
  const ok = rateLimitReader('tok', (async (_u: string, init: RequestInit) => {
    auth = (init.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 12, remaining: 4988, reset: RESET } } }));
  }) as never);
  assert.deepEqual(await ok(), { limit: 5000, used: 12, remaining: 4988, reset: RESET });
  assert.equal(auth, 'Bearer tok');
  assert.equal(await rateLimitReader('tok', (async () => new Response('no', { status: 401 })) as never)(), undefined);
  assert.equal(await rateLimitReader('tok', (async () => { throw new Error('offline'); }) as never)(), undefined);
});
