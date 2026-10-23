import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineRollout, ROLLOUT_FILE, VERIFIED_FILE, changedSettings, installerSummary, timedRunText, toolsLine, toolsResult, type RolloutHost, type RolloutMachine } from './machineRollout.ts';
import { workerToolsRemote, workerUpdateRemote } from './opsWorker.ts';
import type { BenchState, Requester } from '../shared/types.ts';
import type { LinkUpdateReport } from './machineProtocol.ts';

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
  /** What a run of the installer does: its exit code and output, and what the machine looks like afterwards. */
  run: (remote: string) => { code: number; out?: string; after?: { online: boolean; daemon?: string }; adopt?: string[] };
  /** What a run of the installer's tools form does (w1476); default: published, ff-agents 1.29.19 -> 1.29.20. */
  tools?: (remote: string) => { code: number; out?: string; throws?: string };
  /** w1596: its daemon updates over its own link: what its update job reports (or throws), and the machine afterwards. */
  linkRun?: (form: 'update' | 'tools', commit: string) => { report?: Partial<LinkUpdateReport>; throws?: string; after?: { online: boolean; daemon?: string } };
}

/** What `worker.ts tools` prints (server/agentTools.ts), shortened to the lines the rollout reads. */
const toolsOut = (before = 'ff-agents 1.29.19, ff-speckit 1.0.2, ff-discord not installed', after = 'ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord not installed', extra = '') =>
  `Agent tools before: ${before}\nAgent tools latest: final-factory-agents a8449abd8457: ff-agents 1.29.20, ff-speckit 1.0.2, ff-discord 1.17.7\n` +
  `  == Claude Code ==\n${extra}Agent tools after: ${after}\nAgent tools published: every installed plugin is on master.`;
const isTools = (remote: string) => / -Tools -Root | -- --tools --root /.test(remote);

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
    linkUpdate: async (id, form, commit) => {
      linkCalls.push({ id, form, commit });
      const r = find(id).linkRun!(form, commit);
      if (r.after) Object.assign(find(id), r.after);
      if (r.throws) throw new Error(r.throws);
      return { id: 'j', form, commit, ok: true, exit: 0, log: '', at: '', ...r.report };
    },
    tell: (to, text) => told.push({ to, text }),
    requesterOf: () => o.requester,
    timedRun: (id) => find(id).timed,
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
  assert.equal(w.toolCalls[0].remote, workerToolsRemote({ root: 'C:\\ffw', platform: 'win32' }));
  assert.match(w.toolCalls[0].remote, / -Tools -Root C:\\ffw"$/);
  assert.match(w.toolCalls[1].remote, /-- --tools --root \/Users\/Shared\/ffw-m5$/);
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
  assert.deepEqual(w.toolCalls.map((c) => [c.target, c.remote]), [['Lothsahn@loth2800', workerToolsRemote({ root: 'D:\\ffw', platform: 'win32' })]]);
  assert.match(w.told[0].text, /Agent tools: ff-agents 1\.29\.19 → 1\.29\.20/);
  assert.doesNotMatch(w.told[0].text, /WARNING/, 'made over ssh: nothing left to warn of');

  // Not an administrator's account (the ssh run warns too), and a Mac or a PC with no ssh target: the warning stays.
  const plain = mac('pc', { platform: 'win32', root: 'D:\\ffw', target: 'ben@pc', linkRun: linkTools, tools: () => ({ code: 0, out: `${toolsOut()}\n${missing}` }) });
  const noSsh = mac('coosego', { platform: 'win32', root: 'D:\\ffw', target: 'not an ssh target', linkRun: linkTools });
  const w2 = world([plain, noSsh], { requester: LOTH });
  w2.verify();
  await w2.make().tick();
  assert.deepEqual(w2.toolCalls.map((c) => c.target), ['ben@pc'], 'no ssh where there is no target');
  assert.equal(w2.told[0].text.split('Windows Firewall: no allow rule').length - 1, 2, 'both still warn');
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
