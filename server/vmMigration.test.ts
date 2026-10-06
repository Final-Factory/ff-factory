// The migration's rewrites (server/vmMigration.ts, w499): BEAST's config.json and state.json as the VM's portal runs
// them, the conversations it resumes, and the resumable copy's manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, windowsPathsOffWindows } from './config.ts';
import {
  claudeProjectFolder,
  cleanOutsideWatch,
  countDiffs,
  countsOf,
  historyPlan,
  manifestDiff,
  parseManifest,
  rewriteConfig,
  rewriteState,
  skipOnCopy,
  windowsPathsIn,
} from './vmMigration.ts';
import type { Machine } from '../shared/types.ts';

const FAKE_TOKEN = 'not-a-real-token-for-the-test';

/** A config.json like BEAST's (2026-10-05): Windows paths, the host's token, FFBox, intake, machine settings. */
function beastConfig(over: Record<string, unknown> = {}) {
  return {
    port: 8790,
    host: '0.0.0.0',
    trustProxy: true,
    publicUrl: 'https://beast.tailedfcad.ts.net',
    ownerName: 'Ben',
    dataDir: 'data',
    sandboxRoot: 'F:/ffsb',
    repo: { url: 'https://github.com/Final-Factory/FinalFactory.git', basePath: 'C:/ffsb/_base', referenceRepo: 'C:/Users/rydin/nevergames/FinalFactory', librarySeed: 'F:/ffsb/_seed/Library', librarySeedGB: 40 },
    unity: { editorPath: 'C:/Program Files/Unity/Hub/Editor/6000.3/Editor/Unity.exe', idleStopMinutes: 90, mcpServer: { command: 'uvx', args: ['mcp-for-unity'] } },
    protectedPaths: ['C:/Users/rydin/nevergames/FinalFactory', 'C:/ff-sandboxes'],
    limits: { maxSessions: 8, maxSandboxes: 8, maxUnity: 2, minFreeGB: 30 },
    hostDiskPaths: ['C:/', 'F:/'],
    voice: { enabled: true },
    hostGuard: { pollSeconds: 60, devDriveVhdx: 'C:/devdrive.vhdx' },
    claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
    claudeAccounts: { workers: 'token', standing: 'token' },
    providers: { ffbox: { enabled: true, tokenSha256: 'a'.repeat(64) } },
    intake: { reviewers: ['ben', 'lothsahn'] },
    machines: { keepAgentsOnRestart: true, cleanup: { everyMinutes: 60 } },
    max: { ffboxConfigDir: 'C:/Users/rydin/.ffbox', eventsFile: 'C:/ff-sandboxes/data/max-events.jsonl' },
    orchestrator: { model: 'opus', memoryRoot: 'C:/ff-sandboxes/data/orchestrator-memory' },
    ...over,
  };
}

/** The VM's own config.json: the template plus what the guest install and fffctl configure set. */
function vmConfig() {
  const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy', 'vm', 'guest', 'config.vm.example.json'), 'utf8'));
  return { ...t, ownerName: 'Lothsahn', publicUrl: 'https://fff.tailedfcad.ts.net', claudeTokenFile: '/srv/fff/secrets/claude-oauth-token', claudeAccounts: { orchestrator: 'tokenfile', dispatcher: 'tokenfile' } };
}

test('vmMigration: the folder Claude Code keeps a cwd\'s conversations in', () => {
  // Measured on BEAST: these are the folder names under %USERPROFILE%\.claude\projects.
  assert.equal(claudeProjectFolder('C:\\ffsb\\_base'), 'C--ffsb--base');
  assert.equal(claudeProjectFolder('F:\\ffsb\\shader-blackhole'), 'F--ffsb-shader-blackhole');
  assert.equal(claudeProjectFolder('C:/ffsb/_base'), 'C--ffsb--base', 'either slash');
  assert.equal(claudeProjectFolder('/srv/fff/base'), '-srv-fff-base');
  assert.equal(claudeProjectFolder('/srv/fff/agents/triager'), '-srv-fff-agents-triager');
});

test('vmMigration: BEAST\'s config with the VM\'s paths and server settings, portal-only, its people, tokens and machine settings kept', () => {
  const beast = beastConfig();
  const before = JSON.stringify(beast);
  const r = rewriteConfig(beast, vmConfig(), { publicUrl: 'https://fff.tailedfcad.ts.net', beastId: 'beast' });
  assert.equal(JSON.stringify(beast), before, 'the input is not changed');
  const c = r.config as ReturnType<typeof beastConfig> & Record<string, unknown>;
  const vm = vmConfig();
  for (const k of ['port', 'host', 'trustProxy', 'dataDir', 'sandboxRoot', 'standingRoot', 'unity', 'protectedPaths', 'hostDiskPaths', 'review', 'voice', 'hostGuard'] as const) {
    assert.deepEqual(c[k], vm[k], k);
  }
  assert.equal(c.publicUrl, 'https://fff.tailedfcad.ts.net');
  assert.equal(c.hostSandboxes, false, 'the portal-only mode');
  assert.deepEqual(c.repo, { url: 'https://github.com/Final-Factory/FinalFactory.git', basePath: '/srv/fff/base' }, 'no host-sandbox seeding');
  assert.equal(c.ownerName, 'Ben', "BEAST's");
  assert.deepEqual(c.limits, { maxSessions: 8, maxSandboxes: 1, maxUnity: 1, minFreeGB: 10, minFreeRamGB: 0 });
  assert.equal(c.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN, "workers' token moves with it (design 5.3)");
  assert.equal(c.claudeTokenFile, '/srv/fff/secrets/claude-oauth-token');
  assert.deepEqual(c.claudeAccounts, { workers: 'token', standing: 'token', orchestrator: 'tokenfile', dispatcher: 'tokenfile' });
  assert.deepEqual(c.providers, beast.providers);
  assert.deepEqual(c.intake, beast.intake);
  assert.deepEqual(c.machines, { keepAgentsOnRestart: true, cleanup: { everyMinutes: 60 }, useHostClaudeEnv: { beast: true } }, "BEAST's workers kept on this token");
  assert.deepEqual(c.max, {}, "Max's paths on BEAST dropped");
  assert.deepEqual(c.orchestrator, { model: 'opus' });
  assert.deepEqual(r.windowsPaths, []);
  assert.deepEqual(windowsPathsIn(c), []);
  assert.deepEqual(windowsPathsOffWindows(c as never, 'linux'), [], 'loadConfig on Linux takes it');
  assert.ok(r.notes.some((n) => /useHostClaudeEnv for beast: true/.test(n)));
  assert.ok(!JSON.stringify(r.notes).includes(FAKE_TOKEN), 'no secret in the notes');
});

test('vmMigration: BEAST\'s workers keep their account however it was set (design 5.3), and a D5 note', () => {
  const run = (over: Record<string, unknown>) => rewriteConfig(beastConfig(over), vmConfig(), { publicUrl: 'https://fff.x.ts.net', beastId: 'beast' });
  assert.deepEqual((run({ claudeAccounts: { workers: 'login' } }).config.machines as Record<string, unknown>).useHostClaudeEnv, { beast: false }, 'login: its own stored login');
  assert.deepEqual((run({ machines: { useHostClaudeEnv: false } }).config.machines as Record<string, unknown>).useHostClaudeEnv, { '*': false, beast: true }, 'the others keep false; BEAST as before (token)');
  assert.deepEqual((run({ machines: { useHostClaudeEnv: { beast: false, m5: true } } }).config.machines as Record<string, unknown>).useHostClaudeEnv, { beast: false, m5: true }, 'named already: left alone');
  assert.ok(run({ claudeAccounts: { standing: 'login' } }).notes.some((n) => /D5/.test(n)));
  const noToken = rewriteConfig(beastConfig(), { ...vmConfig(), claudeTokenFile: undefined }, { publicUrl: 'https://fff.x.ts.net', beastId: 'beast' });
  assert.deepEqual(noToken.config.claudeAccounts, { workers: 'token', standing: 'token' });
  assert.ok(noToken.notes.some((n) => /no claudeTokenFile/.test(n)));
  const odd = rewriteConfig(beastConfig({ someNewKey: 'D:/x' }), vmConfig(), { publicUrl: 'https://fff.x.ts.net', beastId: 'beast' });
  assert.deepEqual(odd.windowsPaths, [{ key: 'someNewKey', value: 'D:/x' }], 'reported, for the report');
});

const machine = (id: string, over: Partial<Machine> = {}): Machine =>
  ({ id, host: id, purpose: 'unused', status: 'ready', repoPath: `D:/${id}`, home: 'C:/Users/x', portalUrl: 'https://beast.tailedfcad.ts.net', maxSessions: 2, online: false, sessionIds: [], createdAt: '', ...over }) as Machine;

test('vmMigration: BEAST\'s own machine becomes one reached over ssh with its sandboxes and daemon settings; every machine dials the VM', () => {
  const state = {
    sandboxes: [],
    sessions: [],
    machines: [
      machine('beast', { local: true, host: 'localhost', portalUrl: 'http://127.0.0.1:8790', sandboxRoot: 'F:/ffsb', sandboxes: [{ id: 'shader-blackhole', path: 'F:/ffsb/shader-blackhole' }] as never }),
      machine('lothdesktop', { sandboxRoot: 'D:/ffsb' }),
      machine('m5'),
    ],
    standingAgents: [
      { id: 'triager', name: 'Triager', folder: 'F:/ffsb/_agents/triager' },
      { id: 'desk', name: 'Desk', folder: 'D:/ffsb/_agents/desk', machineId: 'lothdesktop' },
    ],
  };
  const r = rewriteState(state, { beastId: 'beast', sshHost: 'rydin@beast', publicUrl: 'https://fff.tailedfcad.ts.net', beastConfig: beastConfig(), standingRoot: '/srv/fff/agents' });
  const [beast, loth, m5] = r.state.machines as Machine[];
  assert.equal(beast.local, undefined);
  assert.equal(beast.host, 'rydin@beast');
  assert.equal(beast.portalUrl, 'https://fff.tailedfcad.ts.net');
  assert.deepEqual(beast.sandboxes, state.machines[0].sandboxes, 'its sandboxes stay its own');
  assert.equal(beast.sandboxRoot, 'F:/ffsb');
  assert.deepEqual(beast.daemonExtras, { unityMcpServer: { command: 'uvx', args: ['mcp-for-unity'] }, sandboxIdleStopMinutes: 90, hostGuard: beast.daemonExtras!.hostGuard }, 'what its daemon had as the local one');
  assert.equal(beast.daemonExtras!.hostGuard!.pollSeconds, 60, 'its drive guard stays on BEAST (w466)');
  assert.deepEqual([loth.portalUrl, m5.portalUrl], ['https://fff.tailedfcad.ts.net', 'https://fff.tailedfcad.ts.net']);
  assert.equal(loth.repoPath, 'D:/lothdesktop', 'machine paths are on the machine: untouched');
  const [triager, desk] = r.state.standingAgents as { folder: string }[];
  assert.equal(triager.folder, '/srv/fff/agents/triager');
  assert.equal(desk.folder, 'D:/ffsb/_agents/desk');
  assert.equal((state.machines[0] as Machine).local, true, 'the input is not changed');
  assert.throws(() => rewriteState(state, { beastId: 'beast', sshHost: 'rydin@beast', publicUrl: 'http://127.0.0.1:8790', beastConfig: beastConfig(), standingRoot: '/srv/fff/agents' }), /loopback/);
  assert.ok(rewriteState({ sessions: [], sandboxes: [], machines: [machine('m5')] }, { beastId: 'beast', sshHost: 'b', publicUrl: 'https://f.x', beastConfig: beastConfig(), standingRoot: '/a' }).notes.some((n) => /no machine "beast"/.test(n)));
});

test('vmMigration: the conversations to carry over are the orchestrators\' and this host\'s standing agents\', under their new folders', () => {
  const s = (id: string, kind: string, over: Record<string, unknown> = {}) => ({ id, kind, title: id, sdkSessionId: `sdk-${id}`, ...over });
  const state = {
    orchestratorId: 'disp',
    sessions: [
      s('disp', 'orchestrator'),
      s('ben', 'orchestrator'),
      s('w1', 'worker'),
      s('st1', 'standing', { standingId: 'triager' }),
      s('st2', 'standing', { standingId: 'desk' }),
      s('nohist', 'orchestrator', { sdkSessionId: undefined }),
      s('odd', 'orchestrator', { sdkSessionId: '../../etc' }),
      s('remote', 'worker', { machineId: 'm5' }),
    ],
    standingAgents: [
      { id: 'triager', folder: 'F:\\ffsb\\_agents\\triager' },
      { id: 'desk', folder: 'D:/x', machineId: 'lothdesktop' },
    ],
  };
  const plan = historyPlan(state, { beastBase: 'C:\\ffsb\\_base', vmBase: '/srv/fff/base', vmStandingRoot: '/srv/fff/agents' });
  assert.deepEqual(
    plan.map((m) => [m.sessionId, m.kind, m.sdkSessionId, m.fromFolder, m.toFolder]),
    [
      ['disp', 'orchestrator', 'sdk-disp', 'C--ffsb--base', '-srv-fff-base'],
      ['ben', 'orchestrator', 'sdk-ben', 'C--ffsb--base', '-srv-fff-base'],
      ['st1', 'standing', 'sdk-st1', 'F--ffsb--agents-triager', '-srv-fff-agents-triager'],
    ],
  );
});

test('vmMigration: the outside watch forgets BEAST\'s adapter; counts and their differences', () => {
  assert.deepEqual(cleanOutsideWatch({ topic: 'ffsb-abc', mac: 'aa:bb', ip: '192.168.1.5', broadcast: '192.168.1.255', collectedAt: 'x' }), { topic: 'ffsb-abc' });
  const c = countsOf({ sessions: [{ kind: 'orchestrator' }, { kind: 'worker' }], sandboxes: [], machines: [{}], standingAgents: [{}] }, { items: [{}, {}, {}] }, 7);
  assert.deepEqual(c, { sessions: 2, orchestrators: 1, sandboxes: 0, machines: 1, standingAgents: 1, workItems: 3, transcripts: 7 });
  assert.deepEqual(countDiffs(c, { ...c, sessions: 3 }), ['sessions: 2 vs 3']);
});

test('vmMigration: the manifest is read safely, and the copy fetches only what changed and removes what went', () => {
  const m = parseManifest('10\t1000\tconfig.json\r\n20\t2000\tdata\\state.json\nbad line\n5\t1\t../escape\n5\t1\t/abs\n30\t3000\tdata/transcripts/a.jsonl\n');
  assert.deepEqual(m.map((e) => e.path), ['config.json', 'data/state.json', 'data/transcripts/a.jsonl'], 'backslashes become slashes; .. and absolute paths are refused');
  const have = [{ path: 'config.json', size: 10, mtime: 1000 }, { path: 'data/state.json', size: 20, mtime: 1999 }, { path: 'data/old.json', size: 1, mtime: 1 }];
  const d = manifestDiff(m, have);
  assert.deepEqual(d.fetch.map((e) => e.path), ['data/state.json', 'data/transcripts/a.jsonl']);
  assert.deepEqual(d.remove, ['data/old.json']);
  for (const skip of ['data/tools/whisper/model.bin', 'data/supervisor.pid', 'data/supervisor.log', 'data/restart.request', 'data/drain.done', 'data/relocate.result.json']) assert.equal(skipOnCopy(skip), true, skip);
  for (const keep of ['data/state.json', 'data/resume.json', 'data/transcripts/x.jsonl', 'config.json', 'data/toolsets.json']) assert.equal(skipOnCopy(keep), false, keep);
});
