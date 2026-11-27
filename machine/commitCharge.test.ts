// w6411: the commit-charge check (machine/commitCharge.ts), with BEAST's numbers of 2026-11-27 (w6409): warn-only, a
// failed read falls back to RAM only, "off" says nothing, and the commit figure goes beside RAM in the wait messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommitCheck, GB, commitVerdict, commitWords, type CommitCheckMode } from './commitCharge.ts';
import { parseWinCommit } from '../server/system.ts';
import { blockReason } from '../server/hostHealth.ts';
import { assess } from './unitySlots.ts';
import { poolSettingsOf } from '../server/machines.ts';
import type { HostStats } from '../shared/types.ts';

const LIMIT = 127.8 * GB; // BEAST: 64 GB RAM plus a 64 GB page file
const at = (committedGB: number): NonNullable<HostStats['commit']> => ({ committedBytes: committedGB * GB, limitBytes: LIMIT, at: 0 });

test('w6411: BEAST at 57.6 of 127.8 GB committed admits an editor beside its two ffu test jobs; at 123 it refuses', () => {
  const low = commitVerdict(at(57.6), { editors: 1, ciJobs: 2 });
  assert.equal(low.short, false, `room ${low.roomGB} GB against ${low.wantGB} GB`);
  const high = commitVerdict(at(123), { editors: 1, ciJobs: 2 });
  assert.equal(high.short, true);
  assert.equal(high.roomGB.toFixed(1), '4.8');
  // With no CI job running, 123 GB still leaves too little for one editor and the reserve.
  assert.equal(commitVerdict(at(123), { editors: 1, ciJobs: 0 }).short, true);
  // A four-slot grant beside two jobs wants 10 x 4 + 4 + 16 = 60 GB, inside the 70.2 GB 57.6 GB leaves.
  assert.equal(commitVerdict(at(57.6), { editors: 4, ciJobs: 2 }).short, false);
  assert.equal(commitVerdict(at(95), { editors: 1, ciJobs: 2 }).short, false, '32.8 GB of room covers 10 + 4 + 2 x 8');
  assert.equal(commitVerdict(at(95), { editors: 1, ciJobs: 3 }).short, true, 'a third CI job tips it over (38 GB)');
  assert.equal(commitWords(at(123)), 'commit 123.0 of 127.8 GB');
});

function check(o: { commit?: NonNullable<HostStats['commit']>; jobs?: number; mode?: CommitCheckMode } = {}) {
  const lines: string[] = [];
  let now = 1_000_000;
  const c = new CommitCheck({ read: () => o.commit, ciJobs: () => o.jobs, mode: () => o.mode ?? 'warn', log: (l) => lines.push(l), now: () => now });
  return { c, lines, tick: (ms: number) => void (now += ms) };
}

test('w6411: warn-only: it logs what it would refuse, once a minute per kind of start, and refuses nothing', () => {
  const w = check({ commit: at(123), jobs: 2 });
  const why = w.c.check('an editor start');
  assert.match(why ?? '', /commit 123\.0 of 127\.8 GB: 4\.8 GB of room, under the 30 GB an editor start wants/);
  assert.match(why ?? '', /2 CI jobs running x 8 GB/);
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0], /^commit check \(warn-only, nothing refused\): would refuse an editor start: /);
  w.c.check('an editor start');
  assert.equal(w.lines.length, 1, 'a retry within the minute says nothing more');
  w.c.check('a unity-slot grant to "build" (sandbox:slot1)', 2);
  w.c.check('a unity-slot grant to "tests" (sandbox:slot2)', 1);
  assert.equal(w.lines.length, 2, 'grants are one kind of start, whatever the label');
  w.tick(60_000);
  w.c.check('an editor start');
  assert.equal(w.lines.length, 3);
});

test('w6411: a start with room logs the commit line; a failed read falls back to RAM only; "off" says nothing', () => {
  const ok = check({ commit: at(57.6), jobs: 2 });
  assert.equal(ok.c.check('an editor start'), undefined);
  assert.match(ok.lines[0], /^commit check: an editor start admitted, commit 57\.6 of 127\.8 GB \(70\.2 GB of room, 30 GB wanted, 2 CI jobs running\)$/);
  const unread = check({ commit: undefined, jobs: 2 });
  assert.equal(unread.c.check('an editor start'), undefined);
  assert.equal(unread.c.words(), undefined);
  assert.deepEqual(unread.lines, []);
  const off = check({ commit: at(127.8), jobs: 2, mode: 'off' });
  assert.equal(off.c.check('an editor start'), undefined);
  assert.deepEqual(off.lines, []);
  const noJobs = check({ commit: at(123) });
  assert.match(noJobs.c.check('an editor start') ?? '', /CI jobs unknown/);
});

test('w6411: the Windows read parses CommittedBytes and CommitLimit, and refuses what is not two sane numbers', () => {
  assert.deepEqual(parseWinCommit('76814340096 137209610240\r\n', 5), { committedBytes: 76814340096, limitBytes: 137209610240, at: 5 });
  assert.equal(parseWinCommit(''), undefined);
  assert.equal(parseWinCommit('Get-CimInstance : Invalid class'), undefined);
  assert.equal(parseWinCommit('5 0'), undefined);
  assert.equal(parseWinCommit('300 100'), undefined);
});

test("w6411: the commit figure goes beside RAM in the editor's RAM refusal and in a unity-slot wait on RAM", () => {
  const h = { sandboxRoot: 'ok' as const, level: 'ok' as const, disks: [] };
  assert.equal(
    blockReason(h, 'editor', { freeGB: 3, minFreeRamGB: 10 }, { commit: 'commit 123.0 of 127.8 GB' }),
    'only 3.0 GB of RAM is free (commit 123.0 of 127.8 GB) and an editor needs about 10 GB (limits.minFreeRamGB); stop an editor first',
  );
  assert.match(blockReason(h, 'editor', { freeGB: 3, minFreeRamGB: 10 }) ?? '', /^only 3\.0 GB of RAM is free and an editor/);
  const a = assess({
    platform: 'win32',
    procs: [],
    requests: [{ id: 'r1', holder: 'sandbox:slot1', label: 'build', count: 1, pid: 1, createdAt: 0 }],
    places: [],
    limit: 2,
    now: 1,
    ramPct: 90,
    ramWords: 'commit 123.0 of 127.8 GB',
  });
  assert.match(a.waiting[0]?.why ?? '', /^RAM 90% used \(commit 123\.0 of 127\.8 GB\); new Unity launches wait below 85%$/);
});

test('w6411: commit_check "off" goes to the daemon in the pool settings; warn and unset send nothing', () => {
  assert.equal(poolSettingsOf({ sandboxRoot: '/s', commitCheck: 'off' })?.commitCheck, 'off');
  assert.equal(poolSettingsOf({ sandboxRoot: '/s', commitCheck: 'warn' })?.commitCheck, undefined);
  assert.equal(poolSettingsOf({ sandboxRoot: '/s' })?.commitCheck, undefined);
});
