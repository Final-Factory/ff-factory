import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { benchLockDir, foreignTimedHold } from '../machine/benchLock.ts';
import { checkBenchBusyLaunch, sandboxGuard } from './guard.ts';

/**
 * w1750 (lothsahn, 2026-10-22: "Why is the game player running if the worker has an exclusive lock on beast?"): while
 * another worker's timed run holds a machine's bench lock, a player started by its slot path or an ffmpeg screen grab is
 * refused with the holder and the end of its hold; the holder's own session passes; a dead or overdue holder does not
 * block. The game repo's player_slots.py and bench_queue.py gate cover the scripted launches
 * (scripts/tests/test_bench_player_gate.py); this is the shell guard's half.
 */
function queue(t: { after: (f: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1750-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const qdir = path.join(root, 'tmp', 'bench.queue');
  const add = (name: string, info: Record<string, unknown>, grantedTs?: number) => {
    fs.mkdirSync(path.join(qdir, name), { recursive: true });
    fs.writeFileSync(path.join(qdir, name, 'info.json'), JSON.stringify({ ticket: name, mode: 'exclusive', pid: 4242, max_min: 60, ...info }));
    if (grantedTs !== undefined) fs.writeFileSync(path.join(qdir, name, 'granted'), JSON.stringify({ at: 'x', ts: grantedTs }));
  };
  return { root, qdir, add };
}

const T0 = Date.parse('2026-10-22T13:04:00Z');
const live = () => true;
const dead = () => false;

test('w1750: foreignTimedHold names the worker and the end of its hold, passes its own session, and ignores dead, overdue, waiting and shared tickets', (t) => {
  const q = queue(t);
  const now = T0 + 16 * 60_000;
  assert.equal(foreignTimedHold(q.root, 'eb9aea37', now, live), undefined, 'an empty queue');
  q.add('t00000001', { session: 'ab2f0f54', host: 'beast', sandbox: 'slot1', requests: ['w1739'], what: 'cpu budget ffa-ab2f0f54-w1739-LifeSave' }, T0 / 1000);
  const msg = foreignTimedHold(q.root, 'eb9aea37', now, live);
  assert.equal(msg, 'bench lock held by worker ab2f0f54 (w1739, beast/slot1, "cpu budget ffa-ab2f0f54-w1739-LifeSave"), until 14:04Z at the latest (held since 13:04Z)');
  assert.equal(foreignTimedHold(q.root, 'ab2f0f54', now, live), undefined, "the holder's own launches pass");
  assert.equal(foreignTimedHold(q.root, 'eb9aea37', now, dead), undefined, 'a dead holder (its helper gone) never blocks');
  assert.equal(foreignTimedHold(q.root, 'eb9aea37', T0 + 61 * 60_000, live), undefined, 'past its 60-minute bound');
  fs.writeFileSync(path.join(q.qdir, 't00000001', 'revoked'), JSON.stringify({ at: 'x', why: 'over the bound' }));
  assert.equal(foreignTimedHold(q.root, 'eb9aea37', now, live), undefined, 'a revoked hold');
  q.add('t00000002', { session: 'cc', mode: 'shared' }, T0 / 1000);
  q.add('t00000003', { session: 'dd' });
  assert.equal(foreignTimedHold(q.root, 'eb9aea37', now, live), undefined, 'a shared hold and a waiting timed ticket do not block players');
  assert.equal(foreignTimedHold(undefined, 'eb9aea37', now, live), undefined, 'no worker root');
});

test('w1750: an old-style lock with a live owner blocks players too', (t) => {
  const q = queue(t);
  const dir = benchLockDir(q.root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner'), 'beast pid 4121 worker 13:04:10 probe A round 2 (/f/ffw/sandboxes/slot4)\n');
  assert.match(foreignTimedHold(q.root, 'eb9aea37', Date.now(), live) ?? '', /^bench lock held by an old-style lock: beast pid 4121/);
});

// Built from parts so this file's own text never reads as a player launch to a shell guard.
const EXE = ['finalfactory', 'exe'].join('.');
const SLOT = `F:/ffw/players/slot2-0/player/${EXE}`;

test('w1750: checkBenchBusyLaunch refuses a slot player and an ffmpeg screen grab while held, and nothing else', () => {
  let reads = 0;
  const held = () => {
    reads++;
    return 'bench lock held by worker ab2f0f54 (w1739), until 14:04Z at the latest (held since 13:04Z)';
  };
  for (const cmd of [
    `${SLOT} -ffAgentControl &`,
    `cd /f/ffw && "${SLOT.replace(/\//g, '\\')}" -screen-width 1920`,
    `Start-Process ${SLOT.replace(/\//g, '\\')}`,
    'ffmpeg -y -f gdigrab -framerate 60 -i title="Final Factory" out.mp4',
    'ffmpeg -f lavfi -i ddagrab=output_idx=0:framerate=60 -c:v h264_nvenc clip.mp4',
    'timeout 30 ffmpeg.exe -f x11grab -i :99 a.mp4',
  ]) {
    const why = checkBenchBusyLaunch(cmd, held);
    assert.match(why ?? '', /^Refused \(w1750\): bench lock held by worker ab2f0f54 \(w1739\), until 14:04Z/, cmd);
  }
  reads = 0;
  for (const cmd of [
    `python scripts/nightly/player_slots.py launch --detach F:/b/player/${EXE} -- -ffAgentControl`,
    'ffmpeg -i clip.mp4 -c:v libx264 out.mp4',
    `sha256sum ${SLOT}`,
    'git status',
  ]) assert.equal(checkBenchBusyLaunch(cmd, held), undefined, cmd);
  assert.equal(reads, 0, 'the lock is read only for a command that would start a player or a grab');
  assert.equal(checkBenchBusyLaunch(SLOT, () => undefined), undefined, 'free: it starts');
});

test('w1750: the sandbox guard refuses a slot player launch while benchBusy says another worker holds the lock', async () => {
  let busy: string | undefined = 'bench lock held by worker ab2f0f54 (w1739), until 14:04Z at the latest (held since 13:04Z)';
  const hook = sandboxGuard({ sandboxId: 'slot2', sandboxPath: '/f/ffw/sandboxes/slot2', protectedPaths: [], benchBusy: () => busy });
  const ask = (command: string) =>
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/f/ffw/sandboxes/slot2', session_id: 's', transcript_path: '' } as never, undefined, { signal: new AbortController().signal });
  const refused = (await ask(`${SLOT} -ffAgentControl`)) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(refused.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(refused.hookSpecificOutput?.permissionDecisionReason ?? '', /bench lock held by worker ab2f0f54/);
  busy = undefined;
  const allowed = (await ask(`${SLOT} -ffAgentControl`)) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.notEqual(allowed.hookSpecificOutput?.permissionDecision, 'deny', 'the lock given back: it starts');
});
