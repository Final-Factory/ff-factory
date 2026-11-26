import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Daemon, type Probes } from '../machine/daemon.ts';
import { MEDIUM_CHILDREN, lowTargets, openChildren } from '../machine/lowIntegrity.ts';
import { MEDIUM_AGENT_VAR, mediumCargoHomeDir, mediumTempRoot, planMediumFolders, workerWritable } from '../machine/mediumFolders.ts';
import { LOCKED_CHILDREN } from '../machine/writeLock.ts';
import { DEFAULT_CLEANUP, cleanupRules, hostCleanupEnv, sessionTempDir, sessionTempEnv } from './cleanup.ts';
import { READ_ONLY_IN_ROOT } from './workerFence.ts';

// w5862 (w5838's planting audit): Medium agents' TMP and CARGO_HOME sat in folders the worker fences let workers write
// (<root>/tmp and <root>/cache/cargo, labelled Low on Windows), so a fenced worker could plant a script, DLL or cargo
// config.toml that a Medium agent then runs outside the fence.

const inside = (child: string, parent: string) => {
  const r = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
};

function install(t: { after: (f: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'medium-folders-'));
  for (const c of ['tmp', 'cache', 'tools', 'sandboxes', 'home', 'repo', 'daemon', 'secrets', 'claude-medium', 'cache-medium']) fs.mkdirSync(path.join(root, c), { recursive: true });
  fs.mkdirSync(path.join(root, 'cache', 'cargo'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('w5862: with the switch on, Medium agents get a temp root and a cargo home outside every folder the fences give workers', (t) => {
  const root = install(t);
  const tempRoot = path.join(root, 'tmp');
  const m = planMediumFolders({ root, fenced: true, mode: 'on', tempRoot, cargoHome: path.join(root, 'cache', 'cargo'), extra: [tempRoot, path.join(root, 'sandboxes')] });
  assert.equal(m.tempRoot, mediumTempRoot(root));
  assert.equal(m.cargoHome, mediumCargoHomeDir(root));
  assert.ok(fs.existsSync(m.tempRoot!) && fs.existsSync(m.cargoHome!), 'both are made');
  assert.ok(!m.lines.some((l) => l.startsWith('WARNING')), m.lines.join('\n'));
  // What Windows labels Low, listed after the new folders exist (the daemon's next start lists the root again).
  const children = fs.readdirSync(root, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
  const low = lowTargets({ root, appDir: path.join(root, 'daemon'), children, extra: [tempRoot, path.join(root, 'sandboxes')] });
  const env = sessionTempEnv(m.tempRoot!, 'abc-123');
  for (const p of [m.tempRoot!, m.cargoHome!, env.TMP, env.TEMP, env.TMPDIR]) {
    for (const d of [...low.dirs, ...low.files]) assert.ok(!inside(p, d), `${p} is inside the Low target ${d}`);
    assert.ok(!workerWritable(p, root, [tempRoot]), `${p} is a folder workers write`);
  }
  // Landlock and Seatbelt open only openChildren: neither new folder's root child is one.
  const open = openChildren(root, [tempRoot, path.join(root, 'sandboxes')]);
  for (const c of ['tmp-medium', 'cache-medium']) assert.ok(!open.includes(c), `${c} is opened to workers: ${open}`);
  // Kept Medium on Windows, read-only under Landlock and Seatbelt.
  for (const list of [MEDIUM_CHILDREN, [...LOCKED_CHILDREN], READ_ONLY_IN_ROOT.subpaths]) assert.ok(list.includes('tmp-medium'), String(list));
});

test('w5862: today the exposure is only logged (warn-only first): one WARNING names both folders, nothing moves', (t) => {
  const root = install(t);
  for (const mode of [undefined, 'warn']) {
    const m = planMediumFolders({ root, fenced: true, mode, tempRoot: path.join(root, 'tmp'), cargoHome: path.join(root, 'cache', 'cargo'), mkdir: () => assert.fail('nothing is made') });
    assert.equal(m.tempRoot, undefined);
    assert.equal(m.cargoHome, undefined);
    assert.equal(m.lines.length, 1);
    assert.match(m.lines[0], /^WARNING medium agent folders: .*TMP\/TEMP root .*tmp and CARGO_HOME .*cargo are in folders workers write; .*"mediumAgentFolders": "on"/);
  }
});

test('w5862: no fence, no root, or folders no worker writes: nothing is said or moved', (t) => {
  const root = install(t);
  const none = { lines: [] };
  assert.deepEqual(planMediumFolders({ root, fenced: false, mode: 'on', tempRoot: path.join(root, 'tmp'), cargoHome: path.join(root, 'cache', 'cargo') }), none);
  assert.deepEqual(planMediumFolders({ fenced: true, mode: 'on', tempRoot: path.join(root, 'tmp') }), none);
  // The system temp folder and the person's ~/.cargo, outside the root and no extra: workers cannot write them.
  const outside = path.join(os.tmpdir(), 'not-the-root');
  assert.deepEqual(planMediumFolders({ root, fenced: true, mode: 'on', tempRoot: outside, cargoHome: path.join(outside, '.cargo') }), none);
  // A cargo home in a root child only Medium writes (LothDesktop's tools/cargo is not one: tools' children are Low).
  assert.ok(!workerWritable(path.join(root, 'cache-medium', 'cargo'), root));
  assert.ok(workerWritable(path.join(root, 'tools', 'cargo'), root));
});

test('w5862: a temp folder the config puts outside the root is exposed too: the fences open it as an extra', (t) => {
  const root = install(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'medium-folders-temp-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const m = planMediumFolders({ root, fenced: true, mode: 'on', tempRoot: elsewhere, extra: [elsewhere] });
  assert.equal(m.tempRoot, mediumTempRoot(root));
  assert.equal(m.cargoHome, undefined, 'no CARGO_HOME given');
});

test("w5862: a folder that cannot be made keeps today's with a WARNING; the other still moves (recovery needs nobody)", (t) => {
  const root = install(t);
  const m = planMediumFolders({
    root,
    fenced: true,
    mode: 'on',
    tempRoot: path.join(root, 'tmp'),
    cargoHome: path.join(root, 'cache', 'cargo'),
    mkdir: (d) => {
      if (d === mediumTempRoot(root)) throw new Error('EACCES: permission denied');
      fs.mkdirSync(d, { recursive: true });
    },
  });
  assert.equal(m.tempRoot, undefined);
  assert.equal(m.cargoHome, mediumCargoHomeDir(root));
  assert.ok(m.lines.some((l) => /^WARNING medium agent folders: could not make .*tmp-medium \(EACCES.*keep TMP\/TEMP root/.test(l)), m.lines.join('\n'));
});

test('w5869 (F3): a folder a fence opens whole (workerIntegrityAllow, writeLockExtra, transcripts) counts as one workers write', (t) => {
  const root = install(t);
  const allow = path.join(os.tmpdir(), 'medium-folders-allowed');
  assert.ok(workerWritable(path.join(allow, 'cargo'), root, [], [allow]), 'outside the root');
  assert.ok(workerWritable(path.join(root, 'transcripts', 'x'), root, [], [path.join(root, 'transcripts')]), 'a root child');
  assert.ok(!workerWritable(path.join(root, 'cache-medium', 'cargo'), root, [], [path.join(root, 'transcripts')]));
  // A CARGO_HOME there is exposed (warned, then moved); a target there is refused with a WARNING.
  const warn = planMediumFolders({ root, fenced: true, tempRoot: path.join(os.tmpdir(), 'not-the-root'), cargoHome: path.join(allow, 'cargo'), opened: [allow] });
  assert.match(warn.lines[0] ?? '', /^WARNING .*CARGO_HOME .*medium-folders-allowed/);
  const blocked = planMediumFolders({ root, fenced: true, mode: 'on', tempRoot: path.join(root, 'tmp'), opened: [path.join(root, 'tmp-medium')], mkdir: () => assert.fail('nothing is made') });
  assert.equal(blocked.tempRoot, undefined);
  assert.match(blocked.lines[0] ?? '', /^WARNING medium agent folders: .*tmp-medium is in a folder workers write/);
});

test("w5869 (F2): the age-based clean-up rules cover Medium agents' temp root too", () => {
  const medium = path.join(os.tmpdir(), 'ffw', 'tmp-medium');
  const rules = cleanupRules({ ...hostCleanupEnv(path.join(os.tmpdir(), 'ffw', 'tmp')), mediumTemp: medium }, DEFAULT_CLEANUP);
  const ids = rules.filter((r) => r.dir === medium).map((r) => r.id);
  for (const id of ['agent-temp', 'temp-old']) assert.ok(ids.includes(id), `${id}: ${ids}`);
});

const PROBES: Probes = {
  stats: async () => ({}) as Awaited<ReturnType<Probes['stats']>>,
  usage: async () => ({ account: { email: 'someone@example.com', plan: 'Claude Max' }, reply: { subscription_type: 'max', rate_limits_available: false } }) as Awaited<ReturnType<Probes['usage']>>,
};
type Inside = { agentTempEnv(id: string, sandbox: boolean): Record<string, string>; sessionTemp(id: string): string; sessionTemps(id: string): string[] };

for (const mode of ['on', 'warn'] as const) {
  test(`w5862: a launch's env with mediumAgentFolders "${mode}": Medium ${mode === 'on' ? 'moves' : 'stays'}, a sandbox agent keeps the workers' folders`, (t) => {
    const root = install(t);
    const tempDir = path.join(root, 'tmp');
    const workerCargo = path.join(root, 'cache', 'cargo');
    const was = process.env.CARGO_HOME;
    process.env.CARGO_HOME = workerCargo;
    t.after(() => (was === undefined ? delete process.env.CARGO_HOME : (process.env.CARGO_HOME = was)));
    // Every OS's fence key, so the test means the same on the Windows, Linux and macOS runners.
    const d = new Daemon(
      { portalUrl: 'http://127.0.0.1:1', id: 'mx', token: 't', repoPath: path.join(root, 'repo'), appDir: path.join(root, 'daemon'), root, tempDir, maxEventsFile: null, workerIntegrity: 'low', writeLock: true, workerFence: 'seatbelt', mediumAgentFolders: mode },
      () => {
        throw new Error('no sessions here');
      },
      PROBES,
    );
    t.after(() => d.shutdown());
    const i = d as unknown as Inside;
    const medium = i.agentTempEnv('med-1', false);
    const sandbox = i.agentTempEnv('sb-1', true);
    assert.equal(sandbox.TMP, sessionTempDir(tempDir, 'sb-1'));
    assert.equal(sandbox.CARGO_HOME, undefined, 'a sandbox agent inherits the workers\' cargo home');
    if (mode === 'on') {
      for (const k of ['TMP', 'TEMP', 'TMPDIR']) assert.equal(medium[k], sessionTempDir(mediumTempRoot(root), 'med-1'), k);
      assert.equal(medium.CARGO_HOME, mediumCargoHomeDir(root));
      for (const p of [medium.TMP, medium.CARGO_HOME]) assert.ok(!workerWritable(p, root, [tempDir]), p);
      // Its folder is found again for clean-up and grants after a restart (no spec then): by the folder that exists.
      assert.equal(i.sessionTemp('med-1'), sessionTempDir(mediumTempRoot(root), 'med-1'));
      assert.equal(i.sessionTemp('sb-1'), sessionTempDir(tempDir, 'sb-1'));
      assert.deepEqual(i.sessionTemps('x'), [sessionTempDir(tempDir, 'x'), sessionTempDir(mediumTempRoot(root), 'x')]);
      // w5869 (w5871's F1): a Medium agent started before the switch went on (or whose own folder could not be made) runs
      // in the shared root: sessionTemp gives that folder, not a tmp-medium one that does not exist, so timed_run,
      // publish_attachment and the sweeper still find it. A sandbox session gets the shared one even if a tmp-medium one exists.
      const entries = (d as unknown as { entries: Map<string, unknown> }).entries;
      entries.set('old-1', { spec: { sandbox: undefined } });
      entries.set('sb-2', { spec: { sandbox: 'slot1' } });
      fs.mkdirSync(sessionTempDir(tempDir, 'old-1'), { recursive: true });
      fs.mkdirSync(sessionTempDir(mediumTempRoot(root), 'sb-2'), { recursive: true });
      assert.equal(i.sessionTemp('old-1'), sessionTempDir(tempDir, 'old-1'));
      assert.equal(i.sessionTemp('sb-2'), sessionTempDir(tempDir, 'sb-2'));
      fs.mkdirSync(sessionTempDir(mediumTempRoot(root), 'old-1'), { recursive: true });
      assert.equal(i.sessionTemp('old-1'), sessionTempDir(mediumTempRoot(root), 'old-1'), 'once its own folder exists, that one');
      // Out before d.shutdown (an after hook registered first), which stops every entry's session.
      entries.delete('old-1');
      entries.delete('sb-2');
    } else {
      assert.equal(medium.TMP, sessionTempDir(tempDir, 'med-1'));
      assert.equal(medium.CARGO_HOME, undefined);
      assert.ok(!fs.existsSync(mediumTempRoot(root)), 'warn makes nothing');
    }
  });
}

// w5946 F5: ffu-slot refuses a Medium agent ("on") only once its own temp folder (mediumAgentFolders) is outside the workers' too.
for (const [mode, folders, said] of [['on', undefined, 'warn'], ['on', 'on', 'on'], ['warn', 'on', 'warn']] as const) {
  test(`w5870: a launch's env with mediumAgentCaches "${mode}" and mediumAgentFolders ${folders ?? 'unset'}: Medium agents ${mode === 'on' ? 'get cache-medium' : 'keep the workers\' caches'} and ffu-slot says "${said}", a sandbox agent gets neither`, (t) => {
    const root = install(t);
    const tempDir = path.join(root, 'tmp');
    const d = new Daemon(
      { portalUrl: 'http://127.0.0.1:1', id: 'mx', token: 't', repoPath: path.join(root, 'repo'), appDir: path.join(root, 'daemon'), root, tempDir, maxEventsFile: null, workerIntegrity: 'low', writeLock: true, workerFence: 'seatbelt', mediumAgentCaches: mode, ...(folders ? { mediumAgentFolders: folders } : {}) },
      () => {
        throw new Error('no sessions here');
      },
      PROBES,
    );
    t.after(() => d.shutdown());
    const i = d as unknown as Inside;
    const medium = i.agentTempEnv('med-1', false);
    const sandbox = i.agentTempEnv('sb-1', true);
    assert.equal(medium[MEDIUM_AGENT_VAR], said);
    assert.equal(sandbox[MEDIUM_AGENT_VAR], undefined);
    assert.equal(sandbox.DOTNET_CLI_HOME, undefined, 'a sandbox agent inherits the workers\' caches');
    if (mode === 'on') {
      assert.equal(medium.DOTNET_CLI_HOME, path.join(root, 'cache-medium', 'dotnet'));
      assert.ok(!workerWritable(medium.PIP_CACHE_DIR, root, [tempDir]));
    } else assert.equal(medium.DOTNET_CLI_HOME, undefined);
  });
}
