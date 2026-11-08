// w3731: a bench ticket's command started detached (nohup, setsid, disown, start /b, a trailing &) outlives the worker's
// tracked Bash task, so the portal cannot see that its work still runs; the shell guard refuses it and names
// run_in_background. Tested through the whole guard, as a worker's tool call meets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxGuard } from './guard.ts';

const make = () => sandboxGuard({ sandboxId: 'sb1', sandboxPath: 'C:/ffsb/sb1', protectedPaths: [], prBase: () => undefined, evidence: () => undefined });

const decide = async (tool_name: string, command: string, extra: Record<string, unknown> = {}) => {
  const input = { hook_event_name: 'PreToolUse', tool_name, tool_input: { command, ...extra }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '' };
  const r = (await make()(input as never, 'x', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return { decision: r.hookSpecificOutput?.permissionDecision ?? 'allow', reason: r.hookSpecificOutput?.permissionDecisionReason ?? '' };
};

const TIMED = 'python scripts/bench/bench_queue.py timed --what "probe A/B" --minutes 20';

test('w3731: a bench ticket command behind nohup, setsid, disown, start /b or a trailing & is refused, naming run_in_background', async () => {
  for (const cmd of [
    `nohup ${TIMED} > "$TMPDIR/t.log" 2>&1 &`,
    `nohup ${TIMED}`,
    `setsid ${TIMED} > "$TMPDIR/t.log" 2>&1`,
    `setsid -f ${TIMED}`,
    `${TIMED} > "$TMPDIR/t.log" 2>&1 & disown`,
    `${TIMED} &`,
    `(${TIMED} &)`,
    `cd scripts/bench && nohup python bench_queue.py timed --what x --minutes 5 &`,
    'FF_X=1 nohup python3 scripts/bench/bench_queue.py --acquire --what x',
    'nohup python scripts/bench/bench_queue.py run --mode exclusive --what x -- bash leg.sh &',
    'bash -c "nohup python scripts/bench/bench_queue.py timed --what x --minutes 5 &"',
    'nohup bash scripts/bench/probe_ab_win.sh 1920 &',
    'screen -dm python scripts/bench/bench_queue.py timed --what x --minutes 5',
    'tmux new-session -d "python scripts/bench/bench_queue.py timed --what x --minutes 5"',
  ]) {
    const r = await decide('Bash', cmd);
    assert.equal(r.decision, 'deny', cmd);
    assert.match(r.reason, /w3731/, cmd);
    assert.match(r.reason, /run_in_background/, cmd);
  }
  for (const cmd of [
    `Start-Process -NoNewWindow python -ArgumentList "scripts/bench/bench_queue.py timed --what x --minutes 5"`,
    `start /b python scripts\\bench\\bench_queue.py timed --what x --minutes 5`,
    `cmd /c start /b python scripts/bench/bench_queue.py timed --what x --minutes 5`,
    `Start-Job { python scripts/bench/bench_queue.py timed --what x --minutes 5 }`,
  ]) assert.equal((await decide('PowerShell', cmd)).decision, 'deny', cmd);
});

test('w3731: the same bench commands run plainly (or with the Bash tool run_in_background) pass', async () => {
  for (const cmd of [
    TIMED,
    'python scripts/bench/bench_queue.py timed --release',
    'nohup python scripts/bench/bench_queue.py timed --release &',
    'python scripts/bench/bench_queue.py status',
    'nohup python scripts/bench/bench_queue.py status > s.log &',
    `${TIMED} && echo granted`,
    'python scripts/bench/bench_queue.py run --mode shared --what build -- bash build.sh',
  ]) assert.equal((await decide('Bash', cmd, { run_in_background: true })).decision, 'allow', cmd);
  assert.equal((await decide('PowerShell', `& python scripts/bench/bench_queue.py timed --what x --minutes 5`)).decision, 'allow');
});

test('w3731: nohup, setsid, disown and & without a bench ticket command still pass', async () => {
  for (const cmd of [
    'nohup python scripts/nightly/player_slots.py launch --quit-after 300 > p.log 2>&1 &',
    'setsid ffmpeg -i in.mp4 out.webm',
    'npm run dev & disown',
    'sleep 1 & wait',
    'nohup grep -rn bench_queue.py scripts > hits.txt &',
    'cat scripts/bench/bench_queue.py | grep timed &',
  ]) assert.equal((await decide('Bash', cmd)).decision, 'allow', cmd);
  assert.equal((await decide('PowerShell', 'Start-Process notepad')).decision, 'allow');
});
