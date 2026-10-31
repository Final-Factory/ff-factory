import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { READ_CHAIN_LENGTH, READ_CHAIN_NUDGE, isReadSearchBash, isReadSearchCall, readChainHook } from './readChainHook.ts';
import { READ_CHAIN_DEFAULT_PERCENT, READ_CHAIN_MARK, inReadChainPilot, readChainPercent, withReadChainMark } from './readChain.ts';
import { inEarlyCompactPilot, inPilot } from './autoCompact.ts';
import { inTerseProsePilot } from './terseProse.ts';
import { normalizeSetting } from './appConfig.ts';
import { buildOptions, type LaunchSpec } from './launch.ts';
import type { Config } from './config.ts';

/**
 * w2014 (lothsahn: "nudge workers to hand long read/search chains to Explore"): after five reads or searches in a row a pilot
 * worker reads one line pointing it at a subagent.
 */

const worker = (p: number | undefined) => ({ worker: { readChainPilotPercent: p } as Config['worker'] });
const ids = Array.from({ length: 2000 }, (_, i) => `s-${i.toString(36)}-${(i * 7919).toString(16)}`);

test('read/search Bash: commands that only read or search count', () => {
  for (const c of [
    'cat server/launch.ts',
    'sed -n 330,480p server/launch.ts',
    'grep -rn "hooks:\\|PreToolUse" server --include=*.ts | grep -v test.ts | head -30',
    'cd "$TMPDIR/ff" && git log --oneline -3 && grep -rn "x|y" . | head',
    'git -C ../ff show HEAD:server/a.ts | head -40',
    "rg -n 'a; b' src 2>/dev/null",
    'ls server | grep -i hook; wc -l server/*.ts',
    'find . -name "*.ts" -newer x | head',
    'echo ---; tail -40 log.txt',
    'git diff origin/main -- server/ | cut -c1-200',
    "awk '{print $1}' f | sort | uniq -c",
  ]) assert.ok(isReadSearchBash(c), c);
});

test('read/search Bash: anything that writes, runs or waits does not', () => {
  for (const c of [
    'npm test',
    'git commit -m "grep it"',
    'git push origin HEAD',
    'sed -i s/a/b/ f.ts',
    'sed -ni p f.ts',
    'cat a > b',
    'grep x f >> out.txt',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} \\;',
    'cd x && npm ci',
    'cd x',
    'echo hi',
    'gh pr view 12 --json state',
    'python scripts/compact-compare.py --ids',
    'cat <<EOF > f\nx\nEOF',
    'until [ -f x ]; do sleep 20; done',
    'grep "unclosed f',
    '',
  ]) assert.ok(!isReadSearchBash(c), JSON.stringify(c));
  assert.ok(!isReadSearchBash(undefined));
});

test('read/search calls: Read, Grep, Glob and read-only Bash; nothing else', () => {
  for (const t of ['Read', 'Grep', 'Glob']) assert.ok(isReadSearchCall(t, {}), t);
  assert.ok(isReadSearchCall('Bash', { command: 'head -5 a' }));
  assert.ok(!isReadSearchCall('Bash', { command: 'npm test' }));
  for (const t of ['Edit', 'Write', 'Agent', 'ToolSearch', 'PowerShell', 'mcp__machine__read_work']) assert.ok(!isReadSearchCall(t, {}), t);
});

const post = (tool_name: string, tool_input: unknown = {}, extra: Partial<{ agent_id: string; prompt_id: string }> = {}): HookInput =>
  ({ hook_event_name: 'PostToolUse', session_id: 's', transcript_path: 't', cwd: '.', tool_name, tool_input, tool_response: '', tool_use_id: 'u', prompt_id: 'p1', ...extra }) as HookInput;
const run = async (h: ReturnType<typeof readChainHook>, input: HookInput) => {
  const out = (await h(input, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { additionalContext?: string } };
  return out.hookSpecificOutput?.additionalContext;
};

test('the hook: the fifth read in a row adds the line, once per chain', async () => {
  assert.equal(READ_CHAIN_LENGTH, 5);
  const h = readChainHook();
  const seen: (string | undefined)[] = [];
  for (const t of ['Read', 'Grep', 'Glob', 'Read']) seen.push(await run(h, post(t)));
  seen.push(await run(h, post('Bash', { command: 'sed -n 1,40p a.ts' })));
  for (let i = 0; i < 6; i++) seen.push(await run(h, post('Read')));
  assert.deepEqual(seen.map((s) => (s ? 'nudge' : '-')), ['-', '-', '-', '-', 'nudge', '-', '-', '-', '-', '-', '-'], 'once per chain, on the fifth');
  assert.equal(seen[4], READ_CHAIN_NUDGE);
  assert.match(READ_CHAIN_NUDGE, /^five reads in a row: hand the rest of this search to ff-agents:Explore or scout and keep the conclusion \(CLAUDE\.md, Delegation policy\)$/);
});

test('the hook: any other call resets the count; four reads, an edit and four reads add nothing', async () => {
  const h = readChainHook();
  const seen: (string | undefined)[] = [];
  for (const t of ['Read', 'Read', 'Grep', 'Read', 'Edit', 'Read', 'Read', 'Read', 'Read']) seen.push(await run(h, post(t)));
  seen.push(await run(h, post('Bash', { command: 'npm test' })));
  for (let i = 0; i < 4; i++) seen.push(await run(h, post('Glob')));
  assert.ok(seen.every((s) => s === undefined));
  // After a reset a new chain gets the line again.
  assert.equal(await run(h, post('Read')), READ_CHAIN_NUDGE);
});

test("the hook: a subagent's calls neither count nor reset; a new prompt starts again", async () => {
  const h = readChainHook();
  for (let i = 0; i < 3; i++) await run(h, post('Read'));
  for (let i = 0; i < 10; i++) assert.equal(await run(h, post(i % 2 ? 'Read' : 'Edit', {}, { agent_id: 'explore-1' })), undefined, 'a subagent reads on its own');
  await run(h, post('Read'));
  assert.equal(await run(h, post('Read')), READ_CHAIN_NUDGE, "the subagent's edits did not reset the main thread's chain");
  const g = readChainHook();
  for (let i = 0; i < 4; i++) await run(g, post('Read'));
  assert.equal(await run(g, post('Read', {}, { prompt_id: 'p2' })), undefined, 'a new prompt is a new chain');
  assert.equal(await run(g, post('PreToolUse' as never)), undefined);
});

test('readChainPercent: 100 by default (rolled out, w2014); config sets it; 0 is off; over 100 is all', () => {
  assert.equal(READ_CHAIN_DEFAULT_PERCENT, 100);
  assert.equal(readChainPercent({}), 100);
  assert.equal(readChainPercent(worker(20)), 20);
  assert.equal(readChainPercent(worker(0)), 0);
  assert.equal(readChainPercent(worker(250)), 100);
  assert.equal(normalizeSetting('worker.readChainPilotPercent', '0'), 0);
  assert.throws(() => normalizeSetting('worker.readChainPilotPercent', 101), /whole number from 0 to 100/);
});

test('the arm: a stable half of session ids, drawn apart from the compaction and terse-prose pilots', () => {
  const half = ids.filter((id) => inReadChainPilot(id, worker(50)));
  assert.ok(half.length > 900 && half.length < 1100, `${half.length} of 2000 at 50%`);
  assert.deepEqual(ids.filter((id) => inReadChainPilot(id, worker(50))), half, 'the same session always answers the same');
  assert.equal(ids.filter((id) => inReadChainPilot(id, worker(0))).length, 0);
  // Overlap with each other pilot as chance says (a quarter of the sessions), so each one's effect reads apart.
  for (const [name, other] of [['early', (id: string) => inEarlyCompactPilot(id, { worker: { earlyCompactPilotPercent: 50 } } as Config)], ['terse', (id: string) => inTerseProsePilot(id, {})], ['compact', (id: string) => inPilot(id, 50)]] as const) {
    const both = half.filter(other).length;
    assert.ok(both > 400 && both < 600, `${both} sessions in both the read-chain and the ${name} pilot`);
  }
});

test('withReadChainMark: the mark ends a pilot prompt only', () => {
  const inside = ids.find((id) => inReadChainPilot(id, worker(50)))!;
  const outside = ids.find((id) => !inReadChainPilot(id, worker(50)))!;
  assert.equal(withReadChainMark('BRIEF', outside, worker(50)), 'BRIEF');
  assert.ok(withReadChainMark('BRIEF', inside, worker(50)).startsWith(`BRIEF\n\n${READ_CHAIN_MARK}\n`));
  assert.ok(withReadChainMark('BRIEF', inside, worker(50)).length < 'BRIEF'.length + 150, 'the mark is read on every call of a pilot session');
});

test('buildOptions: a PostToolUse hook only when the spec asks for the nudge', () => {
  const spec: LaunchSpec = { cwd: '.', settingSources: [], append: '', strictMcp: true, guard: { id: 'slotX', ownPath: '.', protectedPaths: [] } } as unknown as LaunchSpec;
  assert.equal(buildOptions(spec, {}, {}).hooks?.PostToolUse, undefined);
  const on = buildOptions({ ...spec, readChainNudge: true }, {}, {}).hooks?.PostToolUse;
  assert.equal(on?.length, 1);
  assert.equal(on?.[0].matcher, undefined, 'every tool, so any other call resets the count');
});
