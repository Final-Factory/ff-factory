import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChecksRead, checkTimedSleep } from './waitGuard.ts';
import { sandboxGuard } from './guard.ts';

// w2015: w2008's spend report counted 56 `gh pr checks` calls and about 110 pure timed sleep loops in 5 days of beast's
// worker transcripts (cmds.py). Its brief B quotes the loop verbatim: `until [ $SECONDS -ge $t ]; do sleep 30; done`, the
// first fixture below; the rest are the other spellings of the same two waits, and the waits that must stay allowed.

const LONG = { timeoutMs: 600_000 };

test('gh pr checks and statusCheckRollup are refused, naming ff-pr status and blocked_on ci:', () => {
  for (const cmd of [
    'gh pr checks 1392 --repo Final-Factory/FinalFactory',
    'gh pr checks 643',
    'gh pr checks 643 --watch',
    'gh -R Final-Factory/ff-factory pr checks 643',
    'gh pr view 1392 --json statusCheckRollup',
    'gh pr view 1392 --repo Final-Factory/FinalFactory --json state,mergeable,statusCheckRollup --jq .statusCheckRollup',
    'gh pr view 643 --json headRefOid,statusCheckRollup | head -40',
    'cd "$TMPDIR/ff" && gh pr checks 643 2>&1 | tail -5',
    'bash -c "gh pr checks 12"',
  ]) {
    const r = checkChecksRead(cmd);
    assert.ok(r, cmd);
    assert.match(r!, /a fine-grained token cannot read checks: use ff-pr status, or blocked_on ci:<repo>#<n>/);
  }
  for (const cmd of ['gh run list --commit abc --json status,conclusion', 'gh run view 123 --log-failed | tail -80', 'gh pr view 643 --json state,mergeable', 'ff-pr status', 'git commit -m "no more gh pr checks"', 'grep -n statusCheckRollup server/*.ts'])
    assert.equal(checkChecksRead(cmd), undefined, cmd);
});

test('a pure timed sleep loop of over 180 s is refused, naming wake_me and blocked_on', () => {
  for (const [cmd, opts] of [
    ['until [ $SECONDS -ge $t ]; do sleep 30; done', LONG],
    ['t=$((SECONDS+900)); until [ $SECONDS -ge $t ]; do sleep 30; done', LONG],
    ['end=$(( $(date +%s) + 540 )); while [ $(date +%s) -lt $end ]; do sleep 60; done; echo done', LONG],
    ['while [[ $SECONDS -lt 600 ]]; do sleep 20; done', LONG],
    ['for i in $(seq 1 20); do sleep 30; done', LONG],
    ['for i in {1..10}; do sleep 60; echo tick $i; done', LONG],
    ['while true; do sleep 30; done', { background: true }],
    ['sleep 300', LONG],
    ['sleep 5m', LONG],
    ['until [ $SECONDS -ge $t ]; do sleep 30; done', { background: true }],
    ['bash -c "until [ \\$SECONDS -ge 900 ]; do sleep 30; done"', LONG],
    ['Start-Sleep -Seconds 600', LONG],
  ] as const) {
    const r = checkTimedSleep(cmd, opts);
    assert.ok(r, cmd);
    assert.match(r!, /use wake_me, or blocked_on for CI/);
  }
});

test('a sleep that cannot pass 180 s, or that sits beside real work, is allowed', () => {
  for (const [cmd, opts] of [
    // The call itself ends first: the Bash tool's default 120 s, or a short timeout.
    ['until [ $SECONDS -ge $t ]; do sleep 30; done', {}],
    ['until [ $SECONDS -ge $t ]; do sleep 30; done', { timeoutMs: 170_000 }],
    // Its own numbers cap it.
    ['sleep 90', LONG],
    ['t=$((SECONDS+120)); until [ $SECONDS -ge $t ]; do sleep 30; done', LONG],
    ['for i in 1 2 3; do sleep 30; done', LONG],
    // A loop that tests what it waits for: real work.
    ['until gh run list --commit abc --json status -q ".[].status" | grep -q completed; do sleep 20; done', LONG],
    ['until [ -f "$TMPDIR/build/done.txt" ]; do sleep 20; done', LONG],
    ['while ! curl -s localhost:8080/health; do sleep 5; done', LONG],
    // A build retry: a sleep beside real work.
    ['for i in 1 2 3; do unity-slot run -- ./build.sh && break; sleep 60; done', LONG],
    ['sleep 200; git -C "$TMPDIR/x" push', LONG],
    ['python scripts/bench/bench_queue.py timed --what x --minutes 20', { background: true }],
    ['for f in *.log; do sleep 30; done', LONG],
    ['until [ $SECONDS -ge $t ]; do gh run view 1 --json status; sleep 30; done', LONG],
  ] as const)
    assert.equal(checkTimedSleep(cmd, opts), undefined, cmd);
});

test('the sandbox guard refuses both in Bash and passes the rest', async () => {
  const guard = sandboxGuard({ sandboxId: 'slot2', sandboxPath: '/home/ff/ffw/sandboxes/slot2', protectedPaths: [] });
  const ask = async (command: string, extra: Record<string, unknown> = {}) =>
    ((await guard({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...extra }, session_id: 's', transcript_path: '', cwd: '/home/ff/ffw/sandboxes/slot2', tool_use_id: 't' } as never, 't', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  assert.equal((await ask('gh pr checks 643'))?.permissionDecision, 'deny');
  assert.equal((await ask('until [ $SECONDS -ge $t ]; do sleep 30; done', { timeout: 600000 }))?.permissionDecision, 'deny');
  assert.equal((await ask('until [ $SECONDS -ge $t ]; do sleep 30; done', { run_in_background: true }))?.permissionDecision, 'deny');
  assert.notEqual((await ask('until [ $SECONDS -ge $t ]; do sleep 30; done'))?.permissionDecision, 'deny');
  assert.notEqual((await ask('gh run list --commit abc'))?.permissionDecision, 'deny');
});
