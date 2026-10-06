import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, SENDER_RULE, VOICE_DEFAULTS, checkConnectorConfig, claudeAiConnectorsFor, connectorEnv, loadConfig, ownerLine, windowsPathsOffWindows } from './config.ts';
import { gitIsClean, gitRemotes } from './guard.ts';
import { appVersion, formatVersion, readSha, readVersion } from './version.ts';

/** config.json loading, the app version, and the guard's two real git lookups. */

function withConfig(t: { after: (fn: () => void) => void }, raw: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
  const before = process.env.FFSB_CONFIG;
  process.env.FFSB_CONFIG = file;
  t.after(() => {
    if (before === undefined) delete process.env.FFSB_CONFIG;
    else process.env.FFSB_CONFIG = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const minimal = (dir: string) => ({
  sandboxRoot: path.join(dir, 'sb'),
  repo: { url: 'https://example.test/game.git', basePath: path.join(dir, 'base') },
  unity: { editorPath: 'C:/Unity/{version}/Editor/Unity.exe' },
});

test('loadConfig: defaults fill what the file leaves out, nested objects merge', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { ...minimal(dir), dataDir: path.join(dir, 'data'), limits: { maxUnity: 1 }, unity: { editorPath: 'x', watchdog: { stallMinutes: 5 } }, voice: { model: 'small.en' } });
  const cfg = loadConfig();
  assert.equal(cfg.port, 8790);
  assert.deepEqual(cfg.limits, { maxUnity: 1, maxSessions: 6, maxSandboxes: 4, minFreeGB: 100, minFreeRamGB: 10 });
  assert.equal(cfg.unity.idleStopMinutes, 120);
  assert.equal(cfg.hostGuard.warnFreeGB, 80);
  assert.ok(cfg.hostGuard.cleanup.tempPatterns.includes('edge-shot-*'));
  assert.equal(cfg.unity.watchdog.stallMinutes, 5);
  assert.equal(cfg.unity.watchdog.autoDismiss, true);
  assert.deepEqual(cfg.unity.extraArgs, []);
  assert.equal(cfg.voice.model, 'small.en');
  assert.equal(cfg.voice.tts, VOICE_DEFAULTS.tts);
  assert.equal(cfg.voice.toolsDir, path.join(dir, 'data', 'tools', 'whisper'));
  assert.equal(cfg.standingRoot, path.join(path.resolve(dir, 'sb'), '_agents'));
  assert.equal(cfg.orchestrator.notifyOnWorkerEvents, true);
});

test('loadConfig: required keys, and standing agents kept out of the app and its data', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { repo: minimal(dir).repo, unity: minimal(dir).unity });
  assert.throws(() => loadConfig(), /missing "sandboxRoot"/);
});

test('loadConfig: the portal-only mode (hostSandboxes false) needs only the base clone; the switch is a boolean (w464)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { hostSandboxes: false, dataDir: path.join(dir, 'data'), repo: minimal(dir).repo, standingRoot: path.join(dir, 'agents') });
  const cfg = loadConfig();
  assert.equal(cfg.hostSandboxes, false);
  assert.equal(cfg.sandboxRoot, path.join(dir, 'data', 'sandboxes'), 'a default no sandbox is ever made in');
  withConfig(t, { hostSandboxes: false, dataDir: path.join(dir, 'data'), standingRoot: path.join(dir, 'agents') });
  assert.throws(() => loadConfig(), /missing "repo"/, 'the orchestrators still read the base clone');
  withConfig(t, { ...minimal(dir), hostSandboxes: 'no' });
  assert.throws(() => loadConfig(), /config hostSandboxes is true or false/);
});

test('loadConfig: a standingRoot inside the app folder is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withConfig(t, { ...minimal(dir), dataDir: path.join(dir, 'data'), standingRoot: path.join(ROOT, 'agents') });
  assert.throws(() => loadConfig(), /must not be inside/);
});

test('loadConfig: no file says how to make one', (t) => {
  const before = process.env.FFSB_CONFIG;
  process.env.FFSB_CONFIG = path.join(os.tmpdir(), 'ffsb-no-such-config.json');
  t.after(() => (before === undefined ? delete process.env.FFSB_CONFIG : (process.env.FFSB_CONFIG = before)));
  assert.throws(() => loadConfig(), /Copy config.example.json/);
});

test('ownerLine: names who runs the portal, never as the sender; whose a message is comes from its own first line (w389)', () => {
  assert.equal(ownerLine({}), `\n${SENDER_RULE}\n`);
  assert.equal(ownerLine({ ownerName: '  ' }), `\n${SENDER_RULE}\n`);
  const l = ownerLine({ ownerName: ' Ben\n Ryding ' });
  assert.match(l, /^\nThe person who runs this portal is Ben Ryding; others use it too, so that does not make Ben Ryding the sender of a message\./);
  assert.match(l, /write "unconfirmed" and ask; never write a name/);
  assert.doesNotMatch(l, /The user \(the person who runs this portal\)/);
});

test('version: package.json and the checkout, with an override for builds without .git', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(readVersion(), pkg.version);
  assert.equal(appVersion().version, pkg.version);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readVersion(dir), '0.0.0'); // no package.json
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  assert.equal(readVersion(dir), '0.0.0'); // no version in it

  const before = process.env.FFSB_GIT_SHA;
  t.after(() => (before === undefined ? delete process.env.FFSB_GIT_SHA : (process.env.FFSB_GIT_SHA = before)));
  delete process.env.FFSB_GIT_SHA;
  assert.equal(readSha(dir), undefined); // not a git checkout
  assert.match(readSha() ?? '', /^[0-9a-f]{7,}$/); // this one is
  process.env.FFSB_GIT_SHA = '0123456789abcdef0123';
  assert.equal(readSha(dir), '0123456789ab');

  assert.equal(formatVersion({ version: '0.1.0', sha: 'abc1234' }), 'v0.1.0 (abc1234)');
  assert.equal(formatVersion({ version: '0.1.0' }), 'v0.1.0');
  assert.equal(formatVersion(undefined), 'unknown version');
});

test('guard git lookups: a clean tree, a dirty one, not a repo; push remotes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffsb-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(gitIsClean(dir), false); // not a repo: unknown counts as not clean
  assert.equal(gitRemotes(dir), undefined);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q');
  assert.equal(gitIsClean(dir), true);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  assert.equal(gitIsClean(dir), false);
  git('remote', 'add', 'origin', 'https://example.test/game.git');
  git('remote', 'set-url', '--push', 'origin', 'git@example.test:game.git');
  git('remote', 'add', 'fork', 'https://example.test/fork.git');
  assert.deepEqual(
    [...gitRemotes(dir)!.entries()].sort(),
    [
      ['fork', 'https://example.test/fork.git'],
      ['origin', 'git@example.test:game.git'],
    ],
  );
});

test('w467: Windows paths in config are refused off Windows (path.resolve("C:/ffsb") on Linux is <cwd>/C:/ffsb)', () => {
  const vm = { sandboxRoot: '/srv/fff/sandboxes', dataDir: '/srv/fff/data', standingRoot: '/srv/fff/agents', repo: { url: 'x', basePath: '/srv/fff/base' }, review: { root: '/srv/fff/review' }, protectedPaths: [], hostDiskPaths: ['/srv/fff'] };
  assert.deepEqual(windowsPathsOffWindows(vm, 'linux'), []);
  const beast = { ...vm, sandboxRoot: 'F:/ffsb', repo: { url: 'x', basePath: 'C:\\ffsb\\_base' }, review: { root: 'F:/ffsb/_review' }, protectedPaths: ['/srv/x', 'C:/Users/rydin/nevergames'], hostDiskPaths: ['F:'] };
  assert.deepEqual(windowsPathsOffWindows(beast, 'linux'), ['sandboxRoot "F:/ffsb"', 'repo.basePath "C:\\ffsb\\_base"', 'review.root "F:/ffsb/_review"', 'protectedPaths[1] "C:/Users/rydin/nevergames"', 'hostDiskPaths[0] "F:"']);
  assert.deepEqual(windowsPathsOffWindows(beast, 'win32'), [], 'on Windows they are right');
});

test('w516: claude.ai connectors are off for the orchestrators and the dispatcher by default, on for workers and standing agents, set per role', () => {
  assert.deepEqual(['orchestrator', 'dispatcher', 'workers', 'standing'].map((r) => claudeAiConnectorsFor({}, r as 'workers')), [false, false, true, true]);
  const cfg = { claudeAiConnectors: { dispatcher: true, workers: false } };
  assert.deepEqual(['orchestrator', 'dispatcher', 'workers', 'standing'].map((r) => claudeAiConnectorsFor(cfg, r as 'workers')), [false, true, false, true]);
  assert.deepEqual(connectorEnv(cfg, 'workers'), { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  assert.deepEqual(connectorEnv(cfg, 'standing'), {});
  assert.doesNotThrow(() => checkConnectorConfig(cfg));
  assert.throws(() => checkConnectorConfig({ claudeAiConnectors: { worker: false } as never }), /claudeAiConnectors\.worker: no such role/);
  assert.throws(() => checkConnectorConfig({ claudeAiConnectors: { dispatcher: 'off' } as never }), /claudeAiConnectors\.dispatcher is true or false/);
  assert.throws(() => checkConnectorConfig({ claudeAiConnectors: false as never }), /is an object/);
});
