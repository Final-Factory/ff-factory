// w4674: a worker install that joined with -NoSsh (the worker join, w1596) has no sshd, so the portal, the rollout and the
// ops worker plan no ssh to it, and say which route does apply: an update over its daemon's link, or a local worker there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.ts';
import { SessionManager, setQueryForTesting } from './sessions.ts';
import { MachineManager, adoptLayout } from './machines.ts';
import { OPS_ID, OPS_PATHS, OpsWorker, opsGuard, sshTargetsOf } from './opsWorker.ts';
import { installHasSsh, installSshOf } from '../machine/installSsh.ts';
import { fakeQuery } from '../e2e/fakeAgent.ts';
import type { Config } from './config.ts';
import type { Machine, SessionInfo } from '../shared/types.ts';

const REASON = /lothlaptop has no portal ssh: its worker install joined with -NoSsh \(w1596\), so no sshd answers on its port 22, by design\. Use the route that applies: an update over its daemon's link .*or a local worker in one of lothlaptop's sandboxes .*Not sent over ssh/;

function world(t: { after: (fn: () => unknown) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w4674-'));
  const cfg = { dataDir: dir, limits: { maxSessions: 6 }, repo: { url: 'x' }, worker: { effort: 'high' } } as unknown as Config;
  const store = new Store(dir);
  const sessions = new SessionManager(cfg, store);
  const mm = new MachineManager(cfg, store, sessions);
  const layout = (root: string, ssh?: boolean) => ({ root, appDir: path.join(root, 'daemon'), repoPath: path.join(root, 'repo'), sandboxes: null, ...(ssh === undefined ? {} : { ssh }) });
  for (const [id, ssh] of [['lothlaptop', false], ['m3', true]] as const) {
    const { machine } = mm.register({ id, host: id === 'm3' ? 'm3' : 'lothlaptop', ...(id === 'lothlaptop' ? { ssh: { user: 'lothsahn', host: 'lothlaptop', hostKeys: [], at: '' } } : {}), purpose: 'x', status: 'ready', repoPath: dir, home: dir, portalUrl: 'http://127.0.0.1:1' });
    adoptLayout(machine, layout(id === 'm3' ? '/Users/ben/ffw' : 'V:\\ffw', ssh));
    store.putMachine(machine);
  }
  t.after(async () => {
    store.flush();
    await store.saved();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, sessions, mm, layout };
}

test('w4674: the daemon reads its ssh from root.json, and the hello sets or clears the record (an older daemon leaves it)', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-w4674-root-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const write = (outside?: { kind: string; name: string }[]) => fs.writeFileSync(path.join(tmp, 'root.json'), JSON.stringify({ service: 'x', ...(outside ? { outside } : {}) }));
  write([{ kind: 'task', name: 'FF Factory daemon' }]);
  assert.equal(installHasSsh(tmp), false, 'a -NoSsh join authorizes no key');
  write([{ kind: 'authorized-key', name: 'C:\\ProgramData\\ssh\\administrators_authorized_keys' }]);
  assert.equal(installHasSsh(tmp), true);
  write();
  assert.deepEqual(installSshOf(tmp), {}, 'root.json with no outside list says nothing');
  fs.rmSync(path.join(tmp, 'root.json'));
  assert.deepEqual(installSshOf(tmp), {}, 'missing: says nothing');

  const m = { id: 'x', root: 'V:\\ffw' } as Machine;
  const layout = { root: 'V:\\ffw', appDir: 'V:\\ffw\\daemon', repoPath: 'V:\\ffw\\repo' };
  adoptLayout(m, { ...layout, ssh: false });
  assert.equal(m.noSsh, true);
  adoptLayout(m, layout);
  assert.equal(m.noSsh, true, 'an older daemon, or an unreadable root.json, keeps what the record knew');
  adoptLayout(m, { ...layout, ssh: true });
  assert.equal(m.noSsh, undefined, 'an install updated with ssh clears it');
});

test('w4674: an ssh plan for a -NoSsh machine is refused up front, with the link update or a local worker named', (t) => {
  const { mm } = world(t);
  // Offline (the case the rollout never ssh'd but machine_update and the ops worker did): the reason, which names both routes.
  assert.match(mm.sshProblem('lothlaptop') ?? '', REASON);
  assert.match(mm.sshProblem('lothlaptop') ?? '', /its daemon is offline now; it updates over its link once it connects again/);
  assert.equal(mm.sshProblem('m3'), undefined, 'an install with ssh: planned as before');
  // As the ops worker types it: the id, the alias, the user@host its record names, any case.
  for (const target of ['lothlaptop', 'LothLaptop', 'lothsahn@lothlaptop']) assert.match(mm.sshTargetProblem(target) ?? '', REASON, target);
  for (const target of ['m3', 'benryding@m3', 'beast']) assert.equal(mm.sshTargetProblem(target), undefined, target);
});

test("w4674: machine_update of a -NoSsh machine whose daemon is offline sends no ssh job: it throws the reason", (t) => {
  setQueryForTesting(fakeQuery({ stepMs: 1 }) as never);
  const { dir, store, sessions, mm } = world(t);
  const ops = new OpsWorker({
    sessions,
    store,
    options: () => ({}),
    tellOrchestrator: () => undefined,
    personTurn: () => false,
    file: path.join(dir, 'ops-worker.json'),
    workProblem: () => undefined,
    machine: (id) => ({ id, root: 'V:\\ffw', platform: 'win32', target: 'lothsahn@lothlaptop' }),
    ownRequestProblem: () => undefined,
    // As server/agents.ts wires them.
    linkUpdate: (id) => (mm.canLink(id) ? mm.linkUpdate(id) : undefined),
    linkProblem: (id) => mm.sshProblem(id),
  });
  t.after(() => ops.close());
  const ben = { id: 'be', kind: 'orchestrator', orchestratorRole: 'personal', requestedBy: { userId: 'ben', displayName: 'Ben' } } as SessionInfo;
  assert.throws(() => ops.machineInstall(ben, { machine: 'lothlaptop', workId: 'w4517' }), (e: Error) => REASON.test(e.message) && /Nothing was run$/.test(e.message));
  assert.equal(store.readTranscript(OPS_ID, 20).filter((e) => e.kind === 'user').length, 0, 'no ssh job for the ops worker');
});

test('w4674: the ops worker\'s guard refuses ssh, scp and sftp to a -NoSsh machine, in a command or a scratch script it runs', async (t) => {
  const { mm } = world(t);
  assert.deepEqual(sshTargetsOf("ssh -o ConnectTimeout=5 -p 22 lothsahn@lothlaptop 'hostname'"), ['lothsahn@lothlaptop']);
  assert.deepEqual(sshTargetsOf('scp ./check.ps1 lothlaptop:/tmp/ && sftp -b batch.txt m5'), ['lothlaptop', 'm5']);
  assert.deepEqual(sshTargetsOf("ssh m3 'ping -c1 lothlaptop'"), ['m3'], "a machine's name in a remote command is not a target");
  assert.deepEqual(sshTargetsOf("ssh m3 'ssh lothlaptop hostname'"), ['m3', 'lothlaptop'], 'a hop through m3 fails the same way');

  const scripts: Record<string, string> = { [`${OPS_PATHS.scratch}/w4517-dedup.sh`]: "#!/bin/bash\nssh lothlaptop 'powershell -File dedup.ps1'\n" };
  const read = { platform: 'linux' as const, home: OPS_PATHS.home, cwd: OPS_PATHS.scratch, fsx: { realpath: () => undefined } };
  const logged: string[] = [];
  const hook = opsGuard((l) => logged.push(l), read, (abs) => scripts[abs], (target) => mm.sshTargetProblem(target));
  const bash = async (command: string) =>
    (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  for (const cmd of ["ssh lothlaptop 'Get-DedupStatus'", 'ssh -o BatchMode=yes Lothsahn@LothLaptop hostname', 'scp ./x.ps1 lothlaptop:C:/Temp/', 'bash w4517-dedup.sh']) {
    const r = await bash(cmd);
    assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny', cmd);
    assert.match(r.hookSpecificOutput!.permissionDecisionReason!, REASON, cmd);
  }
  assert.match(logged.join('\n'), /REFUSED Bash: ssh lothlaptop 'Get-DedupStatus'/);
  for (const cmd of ['ssh m3 uptime', "ssh m3 'ping -c1 lothlaptop'", 'scp ./x.sh m5:/tmp/']) assert.deepEqual(await bash(cmd), {}, cmd);
});
