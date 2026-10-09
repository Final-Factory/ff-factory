// The migration's rewrites (server/vmMigration.ts, w499): BEAST's config.json and state.json as the VM's portal runs
// them, the conversations it resumes, and the resumable copy's manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, windowsPathsOffWindows, withoutRetiredKeys } from './config.ts';
import {
  batchPlan,
  claudeProjectFolder,
  cleanOutsideWatch,
  countDiffs,
  ffboxRelinkSteps,
  countsOf,
  expandSpec,
  historyPlan,
  indexSpec,
  manifestDiff,
  manifestDir,
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
    assert.deepEqual(c[k], withoutRetiredKeys(vm)[k], k);
  }
  assert.equal(c.publicUrl, 'https://fff.tailedfcad.ts.net');
  // w510: no portal-only switch any more, nor any key of the portal's own sandbox pool (config RETIRED_CONFIG_KEYS).
  for (const k of ['hostSandboxes', 'librarySeed', 'librarySeedGB', 'librarySeedCopy']) assert.equal(c[k], undefined, k);
  assert.ok(r.notes.some((n) => /left out, as nothing reads them any more \(w510\): .*claudeAccounts\.standing, claudeAccounts\.workers/.test(n)), r.notes.join('; '));
  assert.deepEqual(c.repo, { url: 'https://github.com/Final-Factory/FinalFactory.git', basePath: '/srv/fff/base' }, 'no host-sandbox seeding');
  assert.equal(c.ownerName, 'Ben', "BEAST's");
  assert.deepEqual(c.limits, { minFreeRamGB: 0 }, "the VM's own; the pool's limits are gone (w510)");
  assert.equal(c.claudeEnv?.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN, "workers' token moves with it (design 5.3)");
  assert.equal(c.claudeTokenFile, '/srv/fff/secrets/claude-oauth-token');
  assert.deepEqual(c.claudeAccounts, { orchestrator: 'tokenfile', dispatcher: 'tokenfile' }, 'no standing or workers account (w510, w755)');
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

test('vmMigration: BEAST\'s workers keep their account however it was set (design 5.3)', () => {
  const run = (over: Record<string, unknown>) => rewriteConfig(beastConfig(over), vmConfig(), { publicUrl: 'https://fff.x.ts.net', beastId: 'beast' });
  assert.deepEqual((run({ claudeAccounts: { workers: 'login' } }).config.machines as Record<string, unknown>).useHostClaudeEnv, { beast: false }, 'login: its own stored login');
  assert.deepEqual((run({ machines: { useHostClaudeEnv: false } }).config.machines as Record<string, unknown>).useHostClaudeEnv, { '*': false, beast: true }, 'the others keep false; BEAST as before (token)');
  assert.deepEqual((run({ machines: { useHostClaudeEnv: { beast: false, m5: true } } }).config.machines as Record<string, unknown>).useHostClaudeEnv, { beast: false, m5: true }, 'named already: left alone');
  const noToken = rewriteConfig(beastConfig(), { ...vmConfig(), claudeTokenFile: undefined }, { publicUrl: 'https://fff.x.ts.net', beastId: 'beast' });
  assert.deepEqual(noToken.config.claudeAccounts, {}, 'the retired workers key is not carried over (w755)');
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

test('vmMigration (w508): files are named to BEAST by their line in its list, in a few bytes, and copied in bounded batches', () => {
  const text = '10\t1\tconfig.json\n20\t2\tdata/a\nbad line\n5\t1\t../escape\n30\t3\tdata/b\n#dir\t/tmp/fff-migrate-1\n';
  const m = parseManifest(text);
  assert.deepEqual(m.map((e) => [e.path, e.index]), [['config.json', 0], ['data/a', 1], ['data/b', 4]], 'every file line counts, a refused one too; a # note does not');
  assert.equal(manifestDir(text), '/tmp/fff-migrate-1');
  assert.equal(manifestDir('10\t1\tx\n'), undefined);
  assert.equal(indexSpec([5, 1, 2, 3, 9, 10, 3]), '1-3,5,9-10');
  assert.equal(indexSpec([]), '');
  assert.deepEqual(expandSpec('1-3,5,9-10'), [1, 2, 3, 5, 9, 10]);
  assert.deepEqual(expandSpec(''), []);
  assert.throws(() => expandSpec('1-x'), /not an index range/);
  const lines = Array.from({ length: 4001 }, (_, i) => i);
  assert.ok(indexSpec(lines.filter((i) => i % 2 === 0)).length < 32 * 1024, 'even 2,000 scattered lines stay far under what BEAST takes on stdin');
  const files = [10, 50, 300, 20, 20, 20, 20].map((size, index) => ({ path: `f${index}`, size, mtime: 0, index }));
  assert.deepEqual(batchPlan(files, { maxFiles: 3, maxBytes: 100 }).map((b) => b.map((e) => e.path)), [['f0', 'f1'], ['f2'], ['f3', 'f4', 'f5'], ['f6']], 'a larger file alone; at most 3 files or 100 bytes');
  assert.deepEqual(batchPlan([...files].reverse(), { maxFiles: 10, maxBytes: 1000 })[0].map((e) => e.index), [0, 1, 2, 3, 4, 5, 6], "in BEAST's order");
  assert.deepEqual(batchPlan([], { maxFiles: 3, maxBytes: 100 }), []);
});

test('vmMigration: the cut-over tells Lothsahn the exact FFBox commands that move its connector to the new portal (w537)', () => {
  const lines = ffboxRelinkSteps('https://beast.tailedfcad.ts.net/', 'https://fff.tailedfcad.ts.net');
  const text = lines.join('\n');
  assert.match(text, /still dials https:\/\/beast\.tailedfcad\.ts\.net\./);
  assert.ok(text.includes(`sed -i 's|"url": "https://beast.tailedfcad.ts.net"|"url": "https://fff.tailedfcad.ts.net"|' ~/.config/ffbox/config.json`), text);
  assert.ok(text.includes(`cd "$(cat ~/.config/ffbox/checkout)" && sh scripts/06-services.sh --check`), text);
  assert.match(text, /fffconnector\.service, and no other/);
  assert.ok(text.includes('sudo sh scripts/06-services.sh --install'), text);
  assert.ok(text.includes('journalctl -u fffconnector -n 5 --no-pager'), text);
  // Without BEAST's old URL: no sed that could match nothing; the key and the value to set.
  const blind = ffboxRelinkSteps(undefined, 'https://fff.tailedfcad.ts.net').join('\n');
  assert.ok(!blind.includes('sed -i'), blind);
  assert.ok(blind.includes('set "url" in the "fff" block of ~/.config/ffbox/config.json to "https://fff.tailedfcad.ts.net"'), blind);
});
