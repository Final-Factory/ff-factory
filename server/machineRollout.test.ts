import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineRollout, ROLLOUT_FILE, VERIFIED_FILE, changedSettings, installerSummary, type RolloutHost, type RolloutMachine } from './machineRollout.ts';
import { workerUpdateRemote } from './opsWorker.ts';
import type { Requester } from '../shared/types.ts';

/** The rollout after a verified portal deploy (w887, docs/ops-worker.md "After a verified deploy"). */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const NEW = 'c5a93e060aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface FakeMachine extends RolloutMachine {
  online: boolean;
  daemon: string;
  agents: { id: string; title: string }[];
  /** What a run of the installer does: its exit code and output, and what the machine looks like afterwards. */
  run: (remote: string) => { code: number; out?: string; after?: { online: boolean; daemon?: string }; adopt?: string[] };
}

const mac = (id: string, over: Partial<FakeMachine> = {}): FakeMachine => ({
  id,
  root: `/Users/Shared/ffw-${id}`,
  platform: 'darwin',
  target: `ben@${id}`,
  online: true,
  daemon: OLD.slice(0, 7),
  agents: [],
  run: () => ({ code: 0, out: `Before: daemon ${OLD.slice(0, 7)}\nAfter: daemon ${NEW.slice(0, 7)} (was ${OLD.slice(0, 7)}).\nSettings: none changed (every setting carried).\nThe portal sees ${id} online running ${NEW.slice(0, 7)}.`, after: { online: true, daemon: NEW.slice(0, 7) } }),
  ...over,
});

function world(machines: FakeMachine[], o: { requester?: Requester; enabled?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'));
  let clock = Date.parse('2026-10-10T18:00:00Z');
  const calls: { target: string; remote: string }[] = [];
  const told: { to: Requester | undefined; text: string }[] = [];
  let helloAt = 0;
  let adopted: Set<string> | undefined;
  const find = (id: string) => machines.find((m) => m.id === id)!;
  const host: RolloutHost = {
    machines: () => machines,
    online: (id) => find(id).online,
    daemon: (id) => (find(id).online ? find(id).daemon : undefined),
    outdated: () => undefined,
    agents: (id) => find(id).agents,
    liveAtHello: (_id, since) => (helloAt >= since ? adopted : undefined),
    ssh: async (target, remote) => {
      calls.push({ target, remote });
      const m = machines.find((x) => x.target === target)!;
      const r = m.run(remote);
      if (r.after) Object.assign(m, r.after);
      if (r.adopt) {
        adopted = new Set(r.adopt);
        helloAt = clock;
      }
      return { code: r.code, stdout: r.out ?? '', stderr: '' };
    },
    tell: (to, text) => told.push({ to, text }),
    requesterOf: () => o.requester,
  };
  const make = () =>
    new MachineRollout({ host, dataDir: dir, enabled: () => o.enabled !== false, now: () => clock, sleep: async (ms) => void (clock += ms), limits: { settleMs: 10_000, graceMs: 10 * 60_000 } });
  const verify = (sha = NEW, at = clock) => fs.writeFileSync(path.join(dir, VERIFIED_FILE), JSON.stringify({ sha, previous: OLD, at: new Date(at).toISOString() }));
  return { dir, calls, told, make, verify, advance: (ms: number) => void (clock += ms), setHello: (ids: string[]) => ((adopted = new Set(ids)), (helloAt = clock + 1)), find };
}

test('a verified deploy updates every online machine with the installer, naming no setting, and reports once to whoever asked', async () => {
  const w = world([mac('beast', { platform: 'win32', root: 'C:\\ffw', target: 'rydin@beast' }), mac('m5')], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.equal(w.calls.length, 2);
  const beast = w.calls.find((c) => c.target === 'rydin@beast')!;
  assert.equal(beast.remote, workerUpdateRemote({ root: 'C:\\ffw', platform: 'win32' }));
  assert.match(beast.remote, /-Update -Root C:\\ffw"$/);
  const m5 = w.calls.find((c) => c.target === 'ben@m5')!;
  assert.match(m5.remote, /-- --update --root \/Users\/Shared\/ffw-m5$/);
  for (const c of w.calls) assert.doesNotMatch(c.remote, /max-sandboxes|max-agents|max-unity|MaxSandboxes|MaxAgents|MaxUnity/i, 'the limits are not touched');
  assert.equal(w.told.length, 1, 'one message');
  assert.equal(w.told[0].to?.userId, 'lothsahn');
  assert.match(w.told[0].text, /Portal c5a93e060 \(was 1111111aa\) deployed and verified/);
  assert.match(w.told[0].text, /- beast: updated\. 1111111 → c5a93e0\. Limits unchanged\./);
  assert.match(w.told[0].text, /- m5: updated\./);
  assert.match(w.told[0].text, /After: daemon c5a93e0 \(was 1111111\)/, 'the installer output summary');
  await r.tick();
  assert.equal(w.calls.length, 2, 'not again');
  assert.equal(w.told.length, 1);
});

test('a deploy by hand (nobody asked through the ops worker) reports to the dispatcher', async () => {
  const w = world([mac('m5')]);
  w.verify();
  await w.make().tick();
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].to, undefined);
});

test('no marker, no update: a rolled-back deploy writes none', async () => {
  const w = world([mac('m5'), mac('beast')], { requester: LOTH });
  const r = w.make();
  await r.tick();
  await r.tick();
  assert.equal(w.calls.length, 0);
  assert.equal(w.told.length, 0);
  assert.equal(r.state.sha, undefined);
});

test('the kill switch and a dry run: nothing runs, and the marker waits', async () => {
  const w = world([mac('m5')], { enabled: false });
  w.verify();
  await w.make().tick();
  assert.equal(w.calls.length, 0);
  assert.ok(fs.existsSync(path.join(w.dir, VERIFIED_FILE)), 'taken when it is on again');
});

test('a stale marker is retired without a rollout', async () => {
  const w = world([mac('m5')]);
  w.verify(NEW, Date.parse('2026-10-01T00:00:00Z'));
  await w.make().tick();
  assert.equal(w.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(w.dir, VERIFIED_FILE)));
});

test('an offline machine is deferred, named in the report, and updated when it comes online, with a follow-up', async () => {
  const w = world([mac('m5'), mac('biscuit', { online: false })], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@m5']);
  assert.equal(w.told.length, 0, 'it waits for the machines that are only reconnecting to the new portal');
  w.advance(11 * 60_000);
  await r.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /- biscuit: waiting: offline\. It is updated when it next comes online\./);
  assert.match(w.told[0].text, /- m5: updated\./);
  assert.equal(w.calls.length, 1, 'nothing was run on the offline machine');
  w.find('biscuit').online = true;
  await r.tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@m5', 'ben@biscuit']);
  assert.equal(w.told.length, 2);
  assert.match(w.told[1].text, /Follow-up for portal c5a93e060/);
  assert.match(w.told[1].text, /- biscuit: updated\./);
  assert.doesNotMatch(w.told[1].text, /- m5/);
  // A portal restart keeps what was done.
  const again = w.make();
  await again.tick();
  assert.equal(w.calls.length, 2);
  assert.equal(w.told.length, 2);
});

test('a machine whose daemon already runs the deployed commit is not touched', async () => {
  const w = world([mac('m5', { daemon: NEW.slice(0, 9) }), mac('beast')]);
  w.verify();
  await w.make().tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@beast']);
  assert.match(w.told[0].text, /- m5: already on the deployed commit/);
});

test("a machine that is not a worker root install, or the portal's own host, is skipped with the reason", async () => {
  const w = world([mac('old', { root: undefined }), mac('portal', { local: true }), mac('m5')]);
  w.verify();
  await w.make().tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@m5']);
  assert.match(w.told[0].text, /- old: skipped: not a worker root install/);
  assert.match(w.told[0].text, /- portal: skipped: the portal's own host/);
});

test('one machine failing is reported and the rest carry on; its old daemon keeps working', async () => {
  const w = world(
    [
      mac('beast', { run: () => ({ code: 2, out: 'Not updating: 1 problem(s); the daemon was not touched and still runs 1111111:\n- git-lfs is missing' }) }),
      mac('m5'),
      mac('m3'),
    ],
    { requester: LOTH },
  );
  w.verify();
  await w.make().tick();
  assert.deepEqual(w.calls.map((c) => c.target).sort(), ['ben@beast', 'ben@m3', 'ben@m5'], 'a failure did not stop the rest');
  assert.equal(w.told.length, 1);
  const t = w.told[0].text;
  assert.match(t, /- beast: FAILED: the installer exited 2; the daemon is online \(1111111\) and keeps working/);
  assert.match(t, /- git-lfs is missing/);
  assert.match(t, /- m5: updated\./);
  assert.match(t, /- m3: updated\./);
  assert.equal(w.calls.filter((c) => c.target === 'ben@beast').length, 1, 'an online daemon is not touched again');
});

test('a failed run that leaves the machine offline is put back on the commit it ran before', async () => {
  let n = 0;
  const w = world([
    mac('m5', {
      run: (remote) => {
        n++;
        return n === 1
          ? { code: 1, out: 'FAILED: the install did not put ff-factory in place', after: { online: false } }
          : { code: 0, out: 'After: daemon 1111111', after: { online: true, daemon: OLD.slice(0, 7) } };
      },
    }),
  ]);
  w.verify();
  await w.make().tick();
  assert.equal(w.calls.length, 2);
  assert.match(w.calls[1].remote, /--daemon-ref 1111111$/, 'the installer at the commit it ran before');
  assert.match(w.told[0].text, /- m5: FAILED: .*the daemon was offline, so the installer put it back on 1111111\./);
  assert.match(w.told[0].text, /Rollback: ok/);
});

test('a machine that stays offline after the failure and the rollback is called out as needing a person', async () => {
  const w = world([mac('m5', { run: () => ({ code: 1, out: 'FAILED', after: { online: false } }) })]);
  w.verify();
  await w.make().tick();
  assert.equal(w.calls.length, 2);
  assert.match(w.told[0].text, /m5: FAILED: .*OFFLINE and could not be put back: it needs a person/);
  assert.match(w.told[0].text, /Rollback: failed/);
});

test('the machine was not cut off mid-turn work: agents adopted across the update are counted, those that ended are named', async () => {
  const agents = [
    { id: 'a1', title: 'w1: mid-turn build' },
    { id: 'a2', title: 'w2: idle' },
    { id: 'a3', title: 'w3: lost with the daemon' },
  ];
  const w = world([mac('beast', { agents, run: () => ({ code: 0, out: 'After: ok', after: { online: true, daemon: NEW.slice(0, 7) }, adopt: ['a1', 'a2'] }) }), mac('m5', { agents: [{ id: 'b1', title: 'w9' }], run: () => ({ code: 0, out: 'After: ok', after: { online: true, daemon: NEW.slice(0, 7) }, adopt: ['b1'] }) })]);
  w.verify();
  await w.make().tick();
  const t = w.told[0].text;
  assert.match(t, /beast: updated\..*AGENTS THAT ENDED \(1 of 3\): a3 "w3: lost with the daemon"/);
  assert.match(t, /m5: updated\..*Agents: 1 of 1 adopted by the new daemon, none ended\./);
  // Nothing was drained or waited for: both ran at once, with agents alive.
  assert.equal(w.calls.length, 2);
});

test("an update whose daemon says no hello afterwards says the adoption is unchecked, and does not claim they ended", async () => {
  const w = world([mac('m5', { agents: [{ id: 'b1', title: 'w9' }] })]);
  w.verify();
  await w.make().tick();
  assert.match(w.told[0].text, /1 agent\(s\) were alive before; the daemon has not said hello since, so whether they were adopted is unchecked/);
  assert.doesNotMatch(w.told[0].text, /AGENTS THAT ENDED/);
});

test('settings the installer changed although none was asked for are flagged', async () => {
  const w = world([mac('m5', { run: () => ({ code: 0, out: 'Settings changed (daemon.json; everything else carried):\n  ~ maxSandboxes: 3 -> 2\nThe portal sees m5 online', after: { online: true, daemon: NEW.slice(0, 7) } }) })]);
  w.verify();
  await w.make().tick();
  assert.match(w.told[0].text, /SETTINGS CHANGED although none was asked for: ~ maxSandboxes: 3 -> 2/);
});

test('a second verified deploy starts a fresh rollout; the same one is not run twice', async () => {
  const w = world([mac('m5')]);
  const r = w.make();
  w.verify();
  await r.tick();
  w.verify(); // the same commit again
  await r.tick();
  assert.equal(w.calls.length, 1);
  w.find('m5').daemon = NEW.slice(0, 7);
  w.verify('d'.repeat(40));
  await r.tick();
  assert.equal(w.calls.length, 2);
  assert.equal(w.told.length, 2);
});

test('the installer summary keeps the lines that matter, and the settings it changed are found', () => {
  const out = 'FF Factory worker update of /x\nBefore: daemon a; the portal sees it online.\nChecking prerequisites...\nAfter: daemon b (was a).\nSettings: none changed (every setting carried).\nCredential: the machine\'s own, reused.\nThe portal sees m5 online running b, the commit installed, not outdated.\n';
  assert.deepEqual(installerSummary(out), ['Before: daemon a; the portal sees it online.', 'After: daemon b (was a).', 'Settings: none changed (every setting carried).', "Credential: the machine's own, reused.", 'The portal sees m5 online running b, the commit installed, not outdated.']);
  assert.deepEqual(installerSummary('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(changedSettings('Settings changed:\n  ~ maxUnity: 2 -> 3\n'), ['~ maxUnity: 2 -> 3']);
  assert.deepEqual(changedSettings(out), []);
});

test('the state survives a restart: a run cut off by it is looked at again', async () => {
  const w = world([mac('m5')]);
  fs.writeFileSync(path.join(w.dir, ROLLOUT_FILE), JSON.stringify({ sha: NEW, verifiedAt: '2026-10-10T18:00:00.000Z', machines: { m5: { status: 'updating' } } }));
  const r = w.make();
  assert.equal(r.state.machines.m5.status, 'pending');
  await r.tick();
  assert.equal(w.calls.length, 1);
});
