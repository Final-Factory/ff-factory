import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineRollout, ROLLOUT_FILE, VERIFIED_FILE, changedSettings, installerSummary, timedRunText, toolsLine, toolsResult, type RolloutHost, type RolloutMachine } from './machineRollout.ts';
import { workerToolsRemote, workerUpdateRemote } from './opsWorker.ts';
import type { BenchState, Requester } from '../shared/types.ts';
import type { LinkUpdateReport } from './machineProtocol.ts';
import { UpdateNotReached } from './machineLink.ts';

/** The rollout after a verified portal deploy (w887, docs/ops-worker.md "After a verified deploy"). */

const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const NEW = 'c5a93e060aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface FakeMachine extends RolloutMachine {
  online: boolean;
  daemon: string;
  /** Whether its daemon has said hello on this connection (default: yes once online). */
  hello?: boolean;
  agents: { id: string; title: string }[];
  /** w1861: the timed run its daemon says holds its bench queue now, if any. */
  timed?: string;
  /** w4421: its disk as the portal last read it (machines.diskRoom). */
  disk?: { freeBytes: number; warnGB: number };
  /** What a run of the installer does: its exit code and output, and what the machine looks like afterwards. */
  run: (remote: string) => { code: number; out?: string; after?: { online: boolean; daemon?: string }; adopt?: string[] };
  /** What a run of the installer's tools form does (w1476); default: published, ff-agents 1.29.19 -> 1.29.20. */
  tools?: (remote: string) => { code: number; out?: string; throws?: string };
  /** w1596: its daemon updates over its own link: what its update job reports (or throws), and the machine afterwards. */
  /** w1918: why its connected daemon does not update over its link (server/machines.ts linkProblem). */
  linkProblem?: string;
  /** w4674: its install joined with -NoSsh (server/machines.ts noSshProblem). */
  noSsh?: boolean;
  linkRun?: (form: 'update' | 'tools', commit: string) => { report?: Partial<LinkUpdateReport>; throws?: string; notReached?: boolean; after?: { online: boolean; daemon?: string } };
}

/** What `worker.ts tools` prints (server/agentTools.ts), shortened to the lines the rollout reads. */
const toolsOut = (before = 'ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed', after = 'ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord not installed', extra = '') =>
  `Agent tools before: ${before}\nAgent tools latest: final-factory-agents a8449abd8457: ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord 1.17.7\n` +
  `  == Claude Code ==\n${extra}Agent tools after: ${after}\nAgent tools published: every installed plugin is on master.`;
const isTools = (remote: string) => / -Tools -Ref \S+ -Root | -- --tools --ref \S+ --root /.test(remote);

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

function world(machines: FakeMachine[], o: { requester?: Requester; enabled?: boolean; tools?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'));
  let clock = Date.parse('2026-10-10T18:00:00Z');
  const calls: { target: string; remote: string }[] = [];
  /** The agent tools runs (w1476), apart from the daemon updates in calls. */
  const toolCalls: { target: string; remote: string; at: number }[] = [];
  const told: { to: Requester | undefined; text: string }[] = [];
  /** The updates over the daemons' links (w1596). */
  const linkCalls: { id: string; form: string; commit: string }[] = [];
  let helloAt = 0;
  let adopted: Set<string> | undefined;
  const find = (id: string) => machines.find((m) => m.id === id)!;
  const host: RolloutHost = {
    machines: () => machines,
    online: (id) => find(id).online,
    hello: (id) => find(id).online && find(id).hello !== false,
    daemon: (id) => (find(id).online && find(id).hello !== false ? find(id).daemon || undefined : undefined),
    outdated: () => undefined,
    agents: (id) => find(id).agents,
    liveAtHello: (_id, since) => (helloAt >= since ? adopted : undefined),
    ssh: async (target, remote) => {
      const m = machines.find((x) => x.target === target)!;
      if (isTools(remote)) {
        toolCalls.push({ target, remote, at: calls.length });
        const t = m.tools ? m.tools(remote) : { code: 0, out: toolsOut() };
        if (t.throws) throw new Error(t.throws);
        return { code: t.code, stdout: t.out ?? '', stderr: '' };
      }
      calls.push({ target, remote });
      const r = m.run(remote);
      if (r.after) Object.assign(m, r.after);
      if (r.adopt) {
        adopted = new Set(r.adopt);
        helloAt = clock;
      }
      return { code: r.code, stdout: r.out ?? '', stderr: '' };
    },
    link: (id) => find(id).online && !!find(id).linkRun,
    linkProblem: (id) => (find(id).online && !find(id).linkRun ? find(id).linkProblem : undefined),
    noSsh: (id) => !!find(id).noSsh,
    linkUpdate: async (id, form, commit) => {
      linkCalls.push({ id, form, commit });
      const r = find(id).linkRun!(form, commit);
      if (r.after) Object.assign(find(id), r.after);
      if (r.throws) throw r.notReached ? new UpdateNotReached(r.throws) : new Error(r.throws);
      return { id: 'j', form, commit, ok: true, exit: 0, log: '', at: '', ...r.report };
    },
    tell: (to, text) => told.push({ to, text }),
    requesterOf: () => o.requester,
    timedRun: (id) => find(id).timed,
    diskRoom: (id) => find(id).disk,
  };
  const make = () =>
    new MachineRollout({ host, dataDir: dir, enabled: () => o.enabled !== false, tools: () => o.tools !== false, now: () => clock, sleep: async (ms) => void (clock += ms), limits: { settleMs: 10_000, graceMs: 10 * 60_000 } });
  const verify = (sha = NEW, at = clock) => fs.writeFileSync(path.join(dir, VERIFIED_FILE), JSON.stringify({ sha, previous: OLD, at: new Date(at).toISOString() }));
  return { dir, calls, toolCalls, told, linkCalls, make, verify, advance: (ms: number) => void (clock += ms), setHello: (ids: string[]) => ((adopted = new Set(ids)), (helloAt = clock + 1)), find };
}

test('a verified deploy updates every online machine with the installer, naming no setting, and reports once to whoever asked', async () => {
  const w = world([mac('beast', { platform: 'win32', root: 'C:\\ffw', target: 'rydin@beast' }), mac('m5')], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.equal(w.calls.length, 2);
  const beast = w.calls.find((c) => c.target === 'rydin@beast')!;
  assert.equal(beast.remote, workerUpdateRemote({ root: 'C:\\ffw', platform: 'win32' }, NEW));
  assert.match(beast.remote, /-Update -Ref [0-9a-f]{40} -Root C:\\ffw"$/);
  const m5 = w.calls.find((c) => c.target === 'ben@m5')!;
  assert.match(m5.remote, /-- --update --ref [0-9a-f]{40} --root \/Users\/Shared\/ffw-m5$/);
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

test('w1918: a connected daemon that offered no update over its link is not sent to ssh: it fails with the reason', async () => {
  const laptop = mac('lothlaptop', { platform: 'win32', root: 'V:/ffw', target: 'lothsahn@lothlaptop', linkProblem: "lothlaptop's daemon is connected but did not offer updates over its link" });
  const w = world([laptop], { requester: LOTH });
  w.verify();
  await w.make().tick();
  assert.deepEqual(w.calls, [], 'no ssh run');
  assert.deepEqual(w.toolCalls, [], 'no tools run over ssh either');
  assert.match(w.told[0].text, /- lothlaptop: FAILED.*did not offer updates over its link/);
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
  // A portal restart keeps what was done (its stop writes what the background save had not yet).
  r.close();
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

test("w970: a machine connected but with no hello yet is waited for, not read as an unknown commit and skipped", async () => {
  const w = world([mac('beast', { hello: false }), mac('m5')], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@m5'], 'beast is not touched yet');
  assert.equal(r.state.machines.beast.status, 'pending');
  assert.match(r.state.machines.beast.note ?? '', /has not said hello yet/);
  assert.equal(w.told.length, 0, 'the report waits for it');
  // Its hello arrives (it runs the old commit): the next pass updates it.
  w.find('beast').hello = true;
  await r.tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@m5', 'ben@beast']);
  assert.equal(r.state.machines.beast.status, 'ok');
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /- beast: updated\./);
  assert.doesNotMatch(w.told[0].text, /nothing to do/);
});

test('w970: a machine that never says hello is listed as waiting after the grace period, never as current', async () => {
  const w = world([mac('beast', { hello: false })]);
  const r = w.make();
  w.verify();
  await r.tick();
  w.advance(11 * 60_000);
  await r.tick();
  assert.equal(w.calls.length, 0);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /- beast: waiting: connected, but its daemon has not said hello yet/);
  assert.doesNotMatch(w.told[0].text, /nothing to do/);
});

test('w970: a daemon whose hello carries no commit counts as outdated and is updated', async () => {
  const w = world([mac('beast', { daemon: '' })]);
  w.verify();
  await w.make().tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@beast']);
  assert.match(w.told[0].text, /- beast: updated\./);
  assert.doesNotMatch(w.told[0].text, /nothing to do/);
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
  // A grow asked of the Dev Drive goes to devdrive.json, which "Settings" never diffs: the summary says it (w1947).
  const grow = 'Before: daemon a.\nDev Drive: 80 GB now, 98 GB asked: the daemon grows it in place once no agent or editor is in a sandbox.\nDev Drive: reused V: (ReFS, Dev Drive, up to 80 GB).\nAfter: daemon b (was a).\nSettings: none changed (every setting carried).\n';
  assert.deepEqual(installerSummary(grow), ['Before: daemon a.', 'Dev Drive: 80 GB now, 98 GB asked: the daemon grows it in place once no agent or editor is in a sandbox.', 'Dev Drive: reused V: (ReFS, Dev Drive, up to 80 GB).', 'After: daemon b (was a).', 'Settings: none changed (every setting carried).']);
  assert.deepEqual(changedSettings('Settings changed:\n  ~ maxUnity: 2 -> 3\n'), ['~ maxUnity: 2 -> 3']);
  assert.deepEqual(changedSettings(out), []);
});

// ---------------------------------------------------------------- the agent tools (w1476)

test('w1476: after its daemon step every worker root machine gets the latest agent tools, a current one too, and the report gives each plugin before and after', async () => {
  const w = world([mac('beast', { platform: 'win32', root: 'C:\\ffw', target: 'rydin@beast' }), mac('m5', { daemon: NEW.slice(0, 9) })], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['rydin@beast'], 'm5 is current: no daemon update');
  assert.deepEqual(w.toolCalls.map((c) => c.target), ['rydin@beast', 'ben@m5'], 'both get the tools');
  assert.equal(w.toolCalls[0].at, 1, "beast's tools ran after its daemon update");
  assert.equal(w.toolCalls[0].remote, workerToolsRemote({ root: 'C:\\ffw', platform: 'win32' }, NEW));
  assert.match(w.toolCalls[0].remote, / -Tools -Ref [0-9a-f]{40} -Root C:\\ffw"$/);
  assert.match(w.toolCalls[1].remote, /-- --tools --ref [0-9a-f]{40} --root \/Users\/Shared\/ffw-m5$/);
  assert.equal(w.told.length, 1, 'still one report');
  const t = w.told[0].text;
  assert.match(t, /updated the machines' daemons and published the latest agent tools \(final-factory-agents\) on them by itself/);
  assert.match(t, /- beast: updated\. .*Agent tools: ff-agents 1\.29\.19 → 1\.29\.20, ff-speckit 1\.0\.2, ff-discord not installed \(final-factory-agents a8449abd8\); every installed plugin on master\./);
  assert.match(t, /- m5: already on the deployed commit \(c5a93e060\); its daemon was left alone\. Agent tools: ff-agents 1\.29\.19 → 1\.29\.20/);
  assert.equal(r.state.machines.beast.tools?.status, 'ok');
  assert.equal(r.state.machines.beast.tools?.after?.['ff-agents'], '1.29.20');
  await r.tick();
  assert.equal(w.toolCalls.length, 2, 'once per rollout');
});

test('w1476: a tools failure on one machine is reported, the others carry on, and nothing is rolled back', async () => {
  const w = world(
    [
      mac('beast', { tools: () => ({ code: 1, out: toolsOut(undefined, 'ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed', 'FAILED: registerAgents.sh exited 1: claude CLI not on PATH\n') }) }),
      mac('m3', { tools: () => ({ code: 3, out: 'Agent tools before: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord 1.17.7\nNOT PUBLISHED: /ffw/tools/final-factory-agents has uncommitted changes (2 paths); nothing in it was overwritten.\nAgent tools after: ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord 1.17.7 (unchanged)' }) }),
      mac('biscuit', { tools: () => ({ code: 0, out: '', throws: 'ssh: connect to host biscuit port 22: Connection timed out' }) }),
      mac('m5'),
    ],
    { requester: LOTH },
  );
  const r = w.make();
  w.verify();
  await r.tick();
  assert.equal(w.toolCalls.length, 4, 'every machine was tried');
  assert.equal(w.calls.length, 4, 'one daemon update each: no rollback, no second run');
  for (const id of ['beast', 'm3', 'biscuit', 'm5']) assert.equal(r.state.machines[id].status, 'ok', `${id}'s daemon outcome is its own`);
  const t = w.told[0].text;
  assert.match(t, /- beast: updated\..* Agent tools FAILED: registerAgents\.sh exited 1: claude CLI not on PATH\. ff-agents 1\.29\.19, ff-speckit/);
  assert.match(t, /\n {4}tools: FAILED: registerAgents\.sh exited 1/);
  assert.match(t, /- m3: updated\..* Agent tools NOT PUBLISHED: \/ffw\/tools\/final-factory-agents has uncommitted changes \(2 paths\); nothing in it was overwritten\. ff-agents 1\.29\.19, ff-speckit 1\.0\.2, ff-discord 1\.17\.7\./);
  assert.match(t, /- biscuit: updated\..* Agent tools FAILED: ssh: connect to host biscuit port 22: Connection timed out\. plugin versions unknown\./);
  assert.match(t, /- m5: updated\..* Agent tools: ff-agents 1\.29\.19 → 1\.29\.20/);
  assert.match(t, /unless a line above says FAILED, NOT PUBLISHED or OFFLINE/);
});

test('w1476: machines that are skipped get no tools; an offline one gets them when it comes back, in its follow-up; one left offline by a failed update is skipped', async () => {
  const w = world([mac('old', { root: undefined }), mac('portal', { local: true }), mac('biscuit', { online: false }), mac('m3', { run: () => ({ code: 1, out: 'FAILED', after: { online: false } }) }), mac('m5')], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.deepEqual(w.toolCalls.map((c) => c.target), ['ben@m5']);
  assert.equal(r.state.machines.m3.tools?.status, 'skipped');
  w.advance(11 * 60_000);
  await r.tick();
  assert.match(w.told[0].text, /- m3: FAILED: .*OFFLINE.* Agent tools skipped: the machine is offline after its failed daemon update\./);
  assert.doesNotMatch(w.told[0].text, /- old: .*Agent tools/);
  w.find('biscuit').online = true;
  await r.tick();
  assert.deepEqual(w.toolCalls.map((c) => c.target), ['ben@m5', 'ben@biscuit']);
  assert.match(w.told[1].text, /- biscuit: updated\..* Agent tools: ff-agents 1\.29\.19 → 1\.29\.20/);
});

test('w1476: the switch: publishAgentToolsAfterDeploy false updates the daemons only', async () => {
  const w = world([mac('m5')], { tools: false });
  w.verify();
  await w.make().tick();
  assert.equal(w.calls.length, 1);
  assert.equal(w.toolCalls.length, 0);
  assert.doesNotMatch(w.told[0].text, /agent tools|Agent tools/);
});

test('w1476: a rollout from before never publishes; a publish cut off by a portal restart runs again', async () => {
  const w = world([mac('m5', { daemon: NEW.slice(0, 7) })]);
  fs.writeFileSync(path.join(w.dir, ROLLOUT_FILE), JSON.stringify({ sha: NEW, verifiedAt: '2026-10-10T18:00:00.000Z', reported: true, machines: { m5: { status: 'ok', told: true } } }));
  await w.make().tick();
  assert.equal(w.toolCalls.length, 0, 'its state has no tools flag');
  fs.writeFileSync(path.join(w.dir, ROLLOUT_FILE), JSON.stringify({ sha: NEW, tools: true, verifiedAt: '2026-10-10T18:00:00.000Z', reported: true, machines: { m5: { status: 'ok', told: true, tools: { status: 'publishing' } } } }));
  const r = w.make();
  assert.equal(r.state.machines.m5.tools, undefined);
  await r.tick();
  assert.equal(w.toolCalls.length, 1);
  assert.equal((r.state.machines.m5 as { tools?: { status: string } }).tools?.status, 'ok', 'published again');
});

test('w1476: the tools output is read into before, after and master versions; the line names each plugin', () => {
  const ok = toolsResult(0, `noise\r\n${toolsOut()}\r\n`);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.before, { 'ff-agents': '1.29.19', 'ff-speckit': '1.0.2', 'ff-discord': undefined });
  assert.deepEqual(ok.after, { 'ff-agents': '1.29.20', 'ff-speckit': '1.0.2', 'ff-discord': undefined });
  assert.deepEqual(ok.latest, { 'ff-agents': '1.29.20', 'ff-speckit': '1.0.2', 'ff-discord': '1.17.7' });
  assert.equal(ok.latestSha, 'a8449abd8457');
  assert.equal(ok.note, undefined);
  const no = toolsResult(2, '$ROOT holds no worker install (no root.json)');
  assert.equal(no.status, 'failed');
  assert.equal(no.note, "the installer's tools run exited 2");
  assert.deepEqual(no.summary, ['$ROOT holds no worker install (no root.json)']);
  assert.equal(toolsLine({ status: 'ok', before: { 'ff-discord': '1.17.6' }, after: { 'ff-agents': '1.29.20', 'ff-discord': '1.17.7' } }), ' Agent tools: ff-agents not installed → 1.29.20, ff-speckit not installed, ff-discord 1.17.6 → 1.17.7; every installed plugin on master.');
  assert.equal(toolsLine(undefined), '');
});

test('w1742: a tools run that published but warned (a firewall rule it could not make) says so in the report', () => {
  const warn = 'WARNING: Windows Firewall: no allow rule for V:\\ffw\\tools\\node\\node.exe. This session is not elevated';
  const ok = toolsResult(0, `${toolsOut()}\n${warn}\n`);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.warnings, [warn]);
  assert.ok(toolsLine({ status: 'ok', warnings: ok.warnings }).endsWith(` ${warn}`));
  assert.equal(toolsResult(0, toolsOut()).warnings, undefined);
});

test('the state survives a restart: a run cut off by it is looked at again', async () => {
  const w = world([mac('m5')]);
  fs.writeFileSync(path.join(w.dir, ROLLOUT_FILE), JSON.stringify({ sha: NEW, verifiedAt: '2026-10-10T18:00:00.000Z', machines: { m5: { status: 'updating' } } }));
  const r = w.make();
  assert.equal(r.state.machines.m5.status, 'pending');
  await r.tick();
  assert.equal(w.calls.length, 1);
});

test('w1596: a daemon that updates over its own link is updated there, ssh never used (a PC the portal cannot reach on port 22); its tools too', async () => {
  const log = `Before: daemon ${OLD.slice(0, 7)}\nAfter: daemon ${NEW.slice(0, 7)} (was ${OLD.slice(0, 7)}).\nSettings: none changed (every setting carried).\nThe portal sees coosego online running ${NEW.slice(0, 7)}.`;
  const coosego = mac('coosego', {
    platform: 'win32',
    root: 'D:\\ffw',
    // No ssh to it: its target would be refused as a shell argument, and nothing listens on its port 22.
    target: 'not an ssh target',
    linkRun: (form) => (form === 'tools' ? { report: { log: toolsOut() } } : { report: { log, before: OLD.slice(0, 7), after: NEW.slice(0, 7) }, after: { online: true, daemon: NEW.slice(0, 7) } }),
  });
  const w = world([coosego], { requester: LOTH });
  w.verify();
  await w.make().tick();
  assert.equal(w.calls.length + w.toolCalls.length, 0, 'no ssh');
  assert.deepEqual(w.linkCalls.map((c) => [c.id, c.form, c.commit]), [['coosego', 'update', NEW], ['coosego', 'tools', NEW]]);
  assert.match(w.told[0].text, /- coosego: updated\. 1111111 → c5a93e0\. Limits unchanged\./);
  assert.match(w.told[0].text, /After: daemon c5a93e0/, "the job's installer lines");
  assert.match(w.told[0].text, /Agent tools: ff-agents 1\.29\.19 → 1\.29\.20/);
});

test('w1742: a tools run over the link that finds a firewall rule missing runs again over ssh (elevated there), which makes it', async () => {
  const missing = 'WARNING: Windows Firewall: no allow rule for D:\\ffw\\tools\\node\\node.exe. This session is not elevated; an elevated tools run or update (the portal\'s ssh, ops_worker machine_update) makes them.';
  const linkTools = (form: 'update' | 'tools') =>
    form === 'tools' ? { report: { log: `${toolsOut()}\n${missing}` } } : { report: { log: 'After: daemon c5a93e0', before: OLD.slice(0, 7), after: NEW.slice(0, 7) }, after: { online: true, daemon: NEW.slice(0, 7) } };
  const made = 'Windows Firewall: no allow rule for D:\\ffw\\tools\\node\\node.exe; making the install\'s rules again.\nOK: 13 allow rule(s)';
  const lothdesktop = mac('lothdesktop', { platform: 'win32', root: 'D:\\ffw', target: 'Lothsahn@loth2800', linkRun: linkTools, tools: () => ({ code: 0, out: `${toolsOut()}\n${made}` }) });
  const w = world([lothdesktop], { requester: LOTH });
  w.verify();
  await w.make().tick();
  assert.deepEqual(w.toolCalls.map((c) => [c.target, c.remote]), [['Lothsahn@loth2800', workerToolsRemote({ root: 'D:\\ffw', platform: 'win32' }, NEW)]]);
  assert.match(w.told[0].text, /Agent tools: ff-agents 1\.29\.19 → 1\.29\.20/);
  assert.doesNotMatch(w.told[0].text, /WARNING/, 'made over ssh: nothing left to warn of');

  // Not an administrator's account (the ssh run warns too), and a Mac or a PC with no ssh target: the warning stays.
  const plain = mac('pc', { platform: 'win32', root: 'D:\\ffw', target: 'ben@pc', linkRun: linkTools, tools: () => ({ code: 0, out: `${toolsOut()}\n${missing}` }) });
  const noSsh = mac('coosego', { platform: 'win32', root: 'D:\\ffw', target: 'not an ssh target', linkRun: linkTools });
  // w4674: a PC that joined with -NoSsh has a target that looks fine, and no sshd behind it.
  const joined = mac('lothlaptop', { platform: 'win32', root: 'V:\\ffw', target: 'lothsahn@lothlaptop', noSsh: true, linkRun: linkTools });
  const w2 = world([plain, noSsh, joined], { requester: LOTH });
  w2.verify();
  await w2.make().tick();
  assert.deepEqual(w2.toolCalls.map((c) => c.target), ['ben@pc'], 'no ssh where there is no target, nor to a -NoSsh install');
  assert.equal(w2.told[0].text.split('Windows Firewall: no allow rule').length - 1, 3, 'all still warn');
});

test("w1596: over the link, a new daemon that did not come back is put back by its job; a refusal changes nothing; a job that never reports is handled as an ssh run that failed", async () => {
  const back = mac('m5', { linkRun: () => ({ report: { ok: false, exit: 1, rollback: 'ok', note: 'the new daemon did not come back healthy, so the job put 1111111aa back', log: 'FAILED: the portal does not see m5 online' } }) });
  const w = world([back], { tools: false });
  w.verify();
  await w.make().tick();
  assert.match(w.told[0].text, /- m5: FAILED: its update job \(over the daemon's link\) the new daemon did not come back healthy, so the job put 1111111aa back\..* Rollback: ok\./);
  assert.equal(w.calls.length, 0, 'the job put it back; nothing is rerun over ssh');

  const refused = mac('m3', { linkRun: () => ({ throws: 'm3 refused it: the bundle does not match what the portal said on the link' }) });
  const w2 = world([refused], { tools: false });
  w2.verify();
  await w2.make().tick();
  assert.match(w2.told[0].text, /- m3: FAILED: over its daemon's link: m3 refused it: the bundle does not match .*; nothing was changed, and the daemon keeps working\./);

  const quiet = mac('biscuit', { linkRun: () => ({ throws: 'biscuit did not answer its update job in 25 minute(s)', after: { online: false } }), run: () => ({ code: 0, after: { online: true, daemon: OLD.slice(0, 7) } }) });
  const w3 = world([quiet], { tools: false });
  w3.verify();
  await w3.make().tick();
  assert.equal(w3.calls.length, 1, 'offline after the job went quiet: the installer put it back over ssh, where the portal can reach it');
  assert.match(w3.calls[0].remote, /--daemon-ref 1111111$/);
  assert.match(w3.told[0].text, /Rollback: ok\./);
});

test('w4421: an update a full disk refused is sent again by itself once the disk is back over its warning line, at most 3 times; another refusal never', async () => {
  const GiB = 1024 ** 3;
  // biscuit 2026-11-16 04:08:20Z: the daemon could not write the bundle (machine/selfUpdate.ts downloadBundle).
  const full = "biscuit refused it: could not write /Users/Shared/ffw/daemon/update/bundle.part: ENOSPC: no space left on device, write";
  let tries = 0;
  const m = mac('biscuit', {
    disk: { freeBytes: 3 * GiB, warnGB: 30 },
    linkRun: () => (++tries <= 4 ? { throws: full } : { report: { ok: true }, after: { online: true, daemon: NEW.slice(0, 7) } }),
  });
  const w = world([m], { tools: false });
  w.verify();
  const r = w.make();
  await r.tick();
  assert.equal(w.linkCalls.length, 1);
  assert.match(w.told[0].text, /- biscuit: FAILED: .*ENOSPC.*its disk was full: sent again by itself once the disk is back over its warning line/);

  // Under the line (34 < 30 + 5 GB): not sent again, however many ticks.
  m.disk = { freeBytes: 34 * GiB, warnGB: 30 };
  for (let i = 0; i < 3; i++) await r.tick();
  assert.equal(w.linkCalls.length, 1, 'the disk is still under its warning line + 5 GB');
  // Offline with room: not sent either.
  m.disk = { freeBytes: 40 * GiB, warnGB: 30 };
  m.online = false;
  await r.tick();
  assert.equal(w.linkCalls.length, 1, 'offline');
  m.online = true;

  // Back over the line: sent again, once per refusal, up to the cap of 3 retries.
  await r.tick();
  assert.equal(w.linkCalls.length, 2);
  assert.match(w.told.at(-1)!.text, /biscuit: FAILED: .*ENOSPC/);
  await r.tick();
  await r.tick();
  assert.equal(w.linkCalls.length, 4, 'retries 2 and 3');
  assert.doesNotMatch(w.told.at(-1)!.text, /sent again by itself/, 'the last try says no more retry is coming');
  await r.tick();
  await r.tick();
  assert.equal(w.linkCalls.length, 4, 'no retry past the cap in one rollout');

  // A fresh rollout whose retry succeeds comes back ok and is reported so.
  tries = 3;
  const w2 = world([mac('biscuit', { disk: { freeBytes: 3 * GiB, warnGB: 30 }, linkRun: m.linkRun })], { tools: false });
  w2.verify();
  const r2 = w2.make();
  await r2.tick();
  w2.find('biscuit').disk = { freeBytes: 60 * GiB, warnGB: 30 };
  await r2.tick();
  assert.equal(w2.linkCalls.length, 2);
  assert.match(w2.told.at(-1)!.text, /biscuit: .*(ok|updated)/i);
  assert.equal(w2.find('biscuit').daemon, NEW.slice(0, 7));

  // A refusal that is not a full disk is never sent again, whatever the disk.
  const other = mac('m3', { disk: { freeBytes: 500 * GiB, warnGB: 30 }, linkRun: () => ({ throws: 'm3 refused it: the bundle does not match what the portal said on the link' }) });
  const w3 = world([other], { tools: false });
  w3.verify();
  const r3 = w3.make();
  for (let i = 0; i < 4; i++) await r3.tick();
  assert.equal(w3.linkCalls.length, 1);
  assert.doesNotMatch(w3.told[0].text, /disk was full/);
});

test('w5593: an update or tools run whose bundle download was cut is sent again by itself 5 minutes later, at most 3 times', async () => {
  // BEAST 2026-11-25 08:20:52Z (machine/selfUpdate.ts downloadBundle), over a link relayed at 35 KB/s.
  const cut = "beast refused it: the bundle's download did not finish in 480 s at 13754368 of 29217059 bytes, after 1 attempt(s)";
  let tries = 0;
  const m = mac('beast', { linkRun: (form) => (form === 'tools' ? { throws: cut } : ++tries <= 2 ? { throws: cut } : { report: { ok: true }, after: { online: true, daemon: NEW.slice(0, 7) } }) });
  const w = world([m]);
  w.verify();
  const r = w.make();
  await r.tick();
  assert.deepEqual(w.linkCalls.map((c) => c.form), ['update', 'tools']);
  assert.match(w.told[0].text, /- beast: FAILED: .*did not finish in 480 s.*sent again by itself in 5 min/);

  // Not before 5 minutes, and not while offline.
  w.advance(4 * 60_000);
  await r.tick();
  assert.equal(w.linkCalls.length, 2, 'too soon');
  w.advance(2 * 60_000);
  m.online = false;
  await r.tick();
  assert.equal(w.linkCalls.length, 2, 'offline');
  m.online = true;
  await r.tick();
  assert.deepEqual(w.linkCalls.slice(2).map((c) => c.form), ['update', 'tools'], 'the update, then its tools, again');

  // The third update goes through; its tools are cut once more and sent again on their own, then the cap holds.
  w.advance(6 * 60_000);
  await r.tick();
  assert.deepEqual(w.linkCalls.slice(4).map((c) => c.form), ['update', 'tools']);
  assert.equal(m.daemon, NEW.slice(0, 7));
  w.advance(6 * 60_000);
  await r.tick();
  assert.deepEqual(w.linkCalls.slice(6).map((c) => c.form), ['tools'], 'retry 3: the tools alone');
  for (let i = 0; i < 3; i++) {
    w.advance(6 * 60_000);
    await r.tick();
  }
  assert.equal(w.linkCalls.length, 7, 'three retries used: the tools wait for the next deploy');

  // A refusal that is not a cut download is never sent again.
  const other = mac('m3', { linkRun: () => ({ throws: 'm3 refused it: the bundle does not match what the portal said on the link' }) });
  const w2 = world([other], { tools: false });
  w2.verify();
  const r2 = w2.make();
  for (let i = 0; i < 4; i++) {
    w2.advance(6 * 60_000);
    await r2.tick();
  }
  assert.equal(w2.linkCalls.length, 1);
});

test('w5628: once its 3 resends were cut too, the report says its link stays slow and it waits for the next deploy', async () => {
  const cut = "beast refused it: the bundle's download did not finish in 480 s at 13754368 of 29217059 bytes, after 1 attempt(s)";
  const m = mac('beast', { linkRun: () => ({ throws: cut }) });
  const w = world([m]);
  w.verify();
  const r = w.make();
  await r.tick();
  for (let i = 0; i < 5; i++) {
    w.advance(6 * 60_000);
    await r.tick();
  }
  assert.equal(w.linkCalls.length, 8, 'the first send and 3 resends, each an update and its tools');
  const ranOut = /its 3 resends were cut too: its link to the portal stays slow, so it waits for the next deploy \(needs a look\)/;
  const o = r.state.machines.beast;
  assert.match(o.note!, ranOut);
  assert.match(o.tools!.note!, ranOut);
  assert.doesNotMatch(`${o.note} ${o.tools!.note}`, /sent again by itself/);
  // The follow-up report lifts both notes.
  const last = w.told.at(-1)!.text;
  assert.match(last, new RegExp(`- beast: FAILED: .*did not finish in 480 s.*${ranOut.source}`));
  assert.match(last, new RegExp(`Agent tools FAILED: .*${ranOut.source}`));
});

test('w2005:a machine that went offline before its update reached it is not called failed, nothing is put back over ssh, and it is updated when it comes back', async () => {
  let tries = 0;
  const asleep = mac('m3', {
    agents: [{ id: 'a1', title: 'w1987: repro' }],
    linkRun: () => (++tries === 1 ? { throws: 'm3 did not answer the update over its link in 12 minute(s); it went offline without fetching the update bundle, so nothing on it changed', notReached: true, after: { online: false } } : { after: { online: true, daemon: NEW.slice(0, 7) } }),
    run: () => assert.fail('no ssh: nothing on it changed'),
  });
  const w = world([asleep], { tools: false });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.equal(w.calls.length, 0, 'no rollback over ssh');
  w.advance(11 * 60_000);
  await r.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /- m3: waiting: offline before the update reached it \(over its daemon's link: .*nothing on it changed\)\. It is updated when it next comes online\./);
  assert.doesNotMatch(w.told[0].text, /- m3: FAILED|needs a person/);
  w.find('m3').online = true;
  await r.tick();
  assert.equal(w.linkCalls.length, 2, 'updated over its link once it is back');
  assert.match(w.told[1].text, /- m3: updated\./);
});

test("w1861: a timed run on a machine holds its update and tools back until its bench has been free a while; the report says what it waits for", async () => {
  const w = world([mac('m5', { timed: 'a timed run on m5/slot2 (w1780)' }), mac('biscuit')], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@biscuit'], 'only the machine with no timed run is updated');
  assert.deepEqual(w.toolCalls.map((c) => c.target), ['ben@biscuit']);
  assert.equal(r.state.machines.m5.status, 'pending');
  assert.match(r.state.machines.m5.note!, /held back for a timed run on m5\/slot2 \(w1780\)/);
  // The leg ends: probe_ab.sh takes its next leg's ticket seconds later, so a look in that gap does not update it.
  w.find('m5').timed = undefined;
  w.advance(30_000);
  await r.tick();
  assert.equal(w.calls.length, 1, 'not in the gap between two legs');
  assert.match(r.state.machines.m5.note!, /which let go moments ago/);
  w.find('m5').timed = 'a timed run on m5/slot2 (w1780)';
  w.advance(30_000);
  await r.tick();
  assert.equal(w.calls.length, 1);
  // Past the grace period the report goes out, naming the run m5 waits for; m5 comes in a follow-up.
  w.advance(10 * 60_000);
  await r.tick();
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /- m5: waiting: held back for a timed run on m5\/slot2 \(w1780\): an update beside a timed run spoils its numbers \(w1861\)/);
  assert.doesNotMatch(w.told[0].text, /- m5: .*next comes online/);
  // The run is over: after 90 s of a free bench the update and the tools go ahead.
  w.find('m5').timed = undefined;
  w.advance(30_000);
  await r.tick();
  assert.equal(w.calls.length, 1);
  w.advance(61_000);
  await r.tick();
  assert.deepEqual(w.calls.map((c) => c.target), ['ben@biscuit', 'ben@m5']);
  assert.deepEqual(w.toolCalls.map((c) => c.target), ['ben@biscuit', 'ben@m5']);
  assert.equal(r.state.machines.m5.held, undefined);
  assert.equal(w.told.length, 2);
  assert.match(w.told[1].text, /Follow-up for portal c5a93e060: a machine that was offline or held back now settled\.\n- m5: updated\./);
});

test('w1861: a timed run that never lets go holds the update back 45 minutes at the most', async () => {
  const w = world([mac('m5', { timed: 'a timed run on m5/slot2 (w1780)' })]);
  const r = w.make();
  w.verify();
  await r.tick();
  assert.equal(w.calls.length, 0);
  assert.match(r.state.machines.m5.note!, /by 18:45Z at the latest/);
  w.advance(44 * 60_000);
  await r.tick();
  assert.equal(w.calls.length, 0);
  w.advance(60_000);
  await r.tick();
  assert.equal(w.calls.length, 1, 'past 45 minutes it goes ahead');
  assert.equal(w.toolCalls.length, 1, 'its tools too, in the same pass');
});

test('w1861: a machine already on the commit gets its tools only once a timed run there is over', async () => {
  const w = world([mac('m5', { daemon: NEW.slice(0, 9), timed: 'a timed run on m5/slot2 (w1780)' })]);
  const r = w.make();
  w.verify();
  await r.tick();
  assert.equal(r.state.machines.m5.status, 'current');
  assert.equal(w.toolCalls.length, 0, 'no tools run beside the timed run');
  assert.equal(r.state.machines.m5.held, true);
  w.advance(11 * 60_000);
  await r.tick();
  assert.match(w.told[0].text, /- m5: already on the deployed commit \(c5a93e060\); its daemon was left alone\. Its agent tools wait: held back for a timed run on m5\/slot2/);
  w.find('m5').timed = undefined;
  w.advance(91_000);
  await r.tick();
  assert.equal(w.toolCalls.length, 1);
  assert.equal(r.state.machines.m5.held, undefined);
  assert.equal(r.state.machines.m5.note, undefined);
  assert.match(w.told[1].text, /- m5: already on the deployed commit .*Agent tools: ff-agents 1\.29\.19 → 1\.29\.20/);
});

test("w1861: the timed run is read from the daemon's bench state: exclusive only, fresh stats only", () => {
  const now = Date.parse('2026-10-23T13:20:00Z');
  const glance = { ticket: 't00000042', mode: 'exclusive' as const, what: 'probe on round 6', host: 'm5', sandbox: 'slot2', requests: ['w1780'], session: '0669c6ea' };
  const exclusive: BenchState = { mode: 'exclusive', running: [glance], runningCount: 1, waiting: 0 };
  assert.equal(timedRunText(exclusive, now - 10_000, now), 'a timed run on m5/slot2 (w1780)');
  assert.equal(timedRunText(exclusive, now - 4 * 60_000, now), undefined, 'stale stats say nothing');
  assert.equal(timedRunText({ mode: 'shared', running: [{ ...glance, mode: 'shared' }], runningCount: 1, waiting: 0 }, now, now), undefined, 'shared work never holds an update');
  assert.equal(timedRunText({ mode: 'free', running: [], runningCount: 0, waiting: 0 }, now, now), undefined);
  assert.equal(timedRunText(undefined, now, now), undefined);
  assert.match(timedRunText({ mode: 'exclusive', running: [], runningCount: 0, waiting: 0, legacy: { owner: 'm5 pid 4242 ben probe', since: '' } }, now, now)!, /an old-style timed run \(m5 pid 4242/);
});

test('w2044: a tick saves in the background: no synchronous write per machine, and the file holds the state once idle', async () => {
  const w = world([mac('m5'), mac('beast'), mac('biscuit', { online: false })], { requester: LOTH });
  const r = w.make();
  w.verify();
  await r.tick();
  const file = path.join(w.dir, ROLLOUT_FILE);
  const taken = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(taken.machines, {}, 'the taken deploy is on disk before its marker is retired, written at once');
  await r.idle();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.machines.m5.status, r.state.machines.m5.status);
  assert.equal(saved.machines.biscuit.status, 'pending');
  r.close();
});

test('w5516: every installer the rollout runs is fetched at the verified commit and told to install exactly it, the rollback too', async () => {
  let n = 0;
  const w = world([
    mac('m5', { run: () => (++n === 1 ? { code: 1, out: 'FAILED', after: { online: false } } : { code: 0, out: 'After: daemon 1111111', after: { online: true, daemon: OLD.slice(0, 7) } }) }),
    mac('beast', { platform: 'win32', root: 'C:\\ffw', target: 'rydin@beast' }),
  ]);
  w.verify();
  await w.make().tick();
  const remotes = [...w.calls, ...w.toolCalls].map((c) => c.remote);
  assert.equal(remotes.length, 5, "m5's update and its rollback, beast's update, and the tools on both");
  for (const r of remotes) {
    assert.ok(r.includes(`https://raw.githubusercontent.com/Final-Factory/ff-factory/${NEW}/scripts/worker/install.`), r);
    assert.match(r, new RegExp(`(--ref|-Ref) ${NEW} `), r);
    assert.doesNotMatch(r, /ff-factory\/main\//, r);
  }
  assert.match(w.calls.find((c) => c.target === 'ben@m5' && /--daemon-ref/.test(c.remote))!.remote, new RegExp(`--ref ${NEW} --root .* --daemon-ref 1111111$`), "the rollback names the commit it goes back to, with the verified commit's installer");
});

test('w5516: a daemon that comes back on another commit than the verified one is a failure, named, with nothing put back', async () => {
  const w = world([mac('m5', { run: () => ({ code: 0, out: 'After: ok', after: { online: true, daemon: 'deadbeef1234' } }) }), mac('m3')]);
  w.verify();
  await w.make().tick();
  assert.equal(w.calls.filter((c) => c.target === 'ben@m5').length, 1, 'it is online: nothing is run again');
  assert.match(w.told[0].text, /- m5: FAILED: its daemon came back on deadbeef1234, not on the verified commit c5a93e060aaa/);
  assert.match(w.told[0].text, /- m3: updated\./);
});

test('w5516: over the link too, a daemon on another commit after the update is a failure', async () => {
  const w = world([mac('pc', { linkRun: (form) => (form === 'tools' ? { report: { log: toolsOut() } } : { report: { log: 'After: ok' }, after: { online: true, daemon: 'deadbeef1234' } }) })]);
  w.verify();
  await w.make().tick();
  assert.deepEqual(w.linkCalls.map((c) => [c.form, c.commit]).slice(0, 1), [['update', NEW]], 'the link is sent the verified commit');
  assert.match(w.told[0].text, /- pc: FAILED: its daemon came back on deadbeef1234, not on the verified commit/);
});

test('w5516: a verified commit that is not a full sha updates nothing: no installer can be pinned to it', async () => {
  const w = world([mac('m5')]);
  w.verify(NEW.slice(0, 12));
  await w.make().tick();
  assert.equal(w.calls.length, 0, 'no installer ran');
  assert.match(w.told[0].text, /- m5: FAILED: the verified commit "c5a93e060aaa" is not a full 40-character sha/);
});
