import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OWNER_ONLY_KEYS, SETTABLE_KEYS, checkReviewers, normalizeSetting, setAppConfig, toggleNightly } from './appConfig.ts';
import { githubFromVault } from './githubTokens.ts';
import { FFBOX_HASH_FILE, ffboxTokenHash } from './configMigration.ts';
import { tokenSha256 } from './providerProtocol.ts';
import { autoCompactSettings } from './autoCompact.ts';
import { machineActivityPause, type Config } from './config.ts';
import { FILINGS_PER_MESSAGE, timerFilings } from './orchestrators.ts';

const setup = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  // As PowerShell writes it: a byte order mark, other keys that must survive untouched.
  fs.writeFileSync(file, '﻿' + JSON.stringify({ port: 8790, limits: { maxUnity: 3 }, voice: { device: 'auto' } }, null, 2));
  const cfg = { ownerName: undefined, voice: { vocabulary: [], ttsVoice: 'af_heart', device: 'auto' } } as unknown as Config;
  return { file, cfg };
};

test('set_app_config: writes the key, keeps the rest and the old file, applies it live', (t) => {
  const { file, cfg } = setup(t);
  assert.deepEqual(setAppConfig(file, cfg, 'ownerName', '  Sam   Lee '), { before: undefined, after: 'Sam Lee' });
  assert.equal(cfg.ownerName, 'Sam Lee');
  setAppConfig(file, cfg, 'voice.vocabulary', 'Belt, Splitter, , Belt');
  assert.deepEqual(cfg.voice.vocabulary, ['Belt', 'Splitter']);
  setAppConfig(file, cfg, 'voice.ttsVoice', 'bm_george');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { port: 8790, limits: { maxUnity: 3 }, voice: { device: 'auto', vocabulary: ['Belt', 'Splitter'], ttsVoice: 'bm_george' }, ownerName: 'Sam Lee' });
  assert.ok(fs.existsSync(file + '.prev'));
  // null removes it again: back to the default.
  assert.deepEqual(setAppConfig(file, cfg, 'voice.ttsVoice', null), { before: 'bm_george', after: undefined });
  assert.equal(cfg.voice.ttsVoice, 'af_heart');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).voice.ttsVoice, undefined);
});

test('set_app_config: only the allowlisted keys, only sane values', (t) => {
  const { file, cfg } = setup(t);
  for (const key of ['protectedPaths', 'worker.permissionMode', 'limits.minFreeGB', 'claudeEnv', 'host']) {
    assert.throws(() => setAppConfig(file, cfg, key as never, 'x'), /cannot be changed/);
  }
  assert.throws(() => normalizeSetting('ownerName', 'a'.repeat(61)));
  assert.throws(() => normalizeSetting('ownerName', 'x ${process.env.X}'));
  assert.throws(() => normalizeSetting('ownerName', 42));
  assert.throws(() => normalizeSetting('voice.ttsVoice', '../../evil'));
  assert.throws(() => normalizeSetting('voice.vocabulary', Array.from({ length: 61 }, (_, i) => `w${i}`)));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').slice(1)).port, 8790, 'refused changes leave the file alone');
});

test('set_app_config: the public commit identity', (t) => {
  const { file, cfg } = setup(t);
  setAppConfig(file, cfg, 'publicGitIdentity.email', ' 12345+someone@users.noreply.github.com ');
  setAppConfig(file, cfg, 'publicGitIdentity.name', 'Some Team');
  assert.deepEqual(cfg.publicGitIdentity, { email: '12345+someone@users.noreply.github.com', name: 'Some Team' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).publicGitIdentity, { email: '12345+someone@users.noreply.github.com', name: 'Some Team' });
  assert.throws(() => normalizeSetting('publicGitIdentity.email', 'not an email'));
  assert.throws(() => normalizeSetting('publicGitIdentity.name', 'a "quoted" name'));
});

// The host guard's paths are Windows paths (drive letters, a Dev Drive .vhdx), judged as Windows paths on any OS
// (appConfig.ts `P`), so this runs everywhere (w910: it was Windows-only).
test('set_app_config: host guard housekeeping, with age rules kept away from anything that matters', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, protectedPaths: ['C:/live/game'], sandboxRoot: 'F:/ffsb', standingRoot: 'F:/ffsb/_agents', dataDir: 'C:/app/data', repo: { basePath: 'C:/ffsb/_base' }, hostGuard: { devDriveVhdx: '', cleanup: { ageRules: [] } } } as unknown as Config;
  setAppConfig(file, full, 'hostGuard.devDriveVhdx', 'C:/ffsb-devdrive.vhdx');
  assert.throws(() => setAppConfig(file, full, 'hostGuard.compactWhenReclaimGB' as never, '60'), /not|allowed|unknown/i, 'compaction is manual only');
  setAppConfig(file, full, 'hostGuard.cleanup.ageRules', '[{"path":"C:/Users/u/AppData/LocalLow/Studio/game/DeterminismAudit","olderThanDays":14}]');
  assert.equal(full.hostGuard.devDriveVhdx, 'C:/ffsb-devdrive.vhdx');
  assert.deepEqual(full.hostGuard.cleanup.ageRules, [{ path: 'C:/Users/u/AppData/LocalLow/Studio/game/DeterminismAudit', olderThanDays: 14 }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hostGuard.cleanup.ageRules[0].olderThanDays, 14);
  for (const bad of [
    [{ path: 'C:/', olderThanDays: 30 }],
    [{ path: os.homedir(), olderThanDays: 30 }],
    [{ path: 'F:/ffsb/sb1', olderThanDays: 30 }],
    [{ path: 'C:/live', olderThanDays: 30 }],
    [{ path: 'relative/dir', olderThanDays: 30 }],
    [{ path: 'C:/Users/u/old-builds', olderThanDays: 1 }],
  ]) {
    assert.throws(() => normalizeSetting('hostGuard.cleanup.ageRules', bad, full), Error, JSON.stringify(bad));
  }
  assert.throws(() => normalizeSetting('hostGuard.devDriveVhdx', 'C:/not-a-disk.txt'));
});

test("app config (w510): the portal's own pool limits and the standing account are no longer settable", (t) => {
  const { file, cfg } = setup(t);
  const before = fs.readFileSync(file, 'utf8');
  for (const key of ['limits.maxUnity', 'limits.maxSandboxes', 'limits.maxSessions', 'claudeAccounts.standing']) {
    assert.ok(!(SETTABLE_KEYS as readonly string[]).includes(key), key);
    assert.throws(() => setAppConfig(file, cfg as unknown as Config, key as never, '2'), Error, key);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is left alone');
});

test('app config: attachments.maxMB and attachments.retentionDays, live, bounded (docs/attachments.md)', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg } as unknown as Config;
  setAppConfig(file, full, 'attachments.maxMB', 500);
  setAppConfig(file, full, 'attachments.retentionDays', '14');
  assert.deepEqual(full.attachments, { maxMB: 500, retentionDays: 14 }, 'applies at once');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).attachments, { maxMB: 500, retentionDays: 14 });
  for (const bad of ['0', '4097', '1.5', 'big']) assert.throws(() => setAppConfig(file, full, 'attachments.maxMB', bad), /1 to 4096/, bad);
  for (const bad of ['0', '3651', 'forever']) assert.throws(() => setAppConfig(file, full, 'attachments.retentionDays', bad), /1 to 3650/, bad);
  setAppConfig(file, full, 'attachments.maxMB', null);
  assert.deepEqual(full.attachments, { retentionDays: 14 }, 'null: back to the default (200 MB)');
});

test('app config: orchestrator.compactAtTokens and compactAtTurnUsd (w535), live, bounded, 0 is off', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true } } as unknown as Config;
  setAppConfig(file, full, 'orchestrator.compactAtTokens', '300000');
  setAppConfig(file, full, 'orchestrator.compactAtTurnUsd', 0.75);
  assert.deepEqual(full.orchestrator, { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true, compactAtTokens: 300_000, compactAtTurnUsd: 0.75 }, 'applies at once, the rest kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orchestrator, { compactAtTokens: 300_000, compactAtTurnUsd: 0.75 });
  setAppConfig(file, full, 'orchestrator.compactAtTokens', 0);
  assert.equal(full.orchestrator.compactAtTokens, 0, '0 turns it off');
  for (const bad of ['49999', '900001', '1.5', 'lots']) assert.throws(() => setAppConfig(file, full, 'orchestrator.compactAtTokens', bad), /0 \(off\) or a whole number of tokens from 50,000 to 900,000/, bad);
  for (const bad of ['0.01', '51', 'cheap']) assert.throws(() => setAppConfig(file, full, 'orchestrator.compactAtTurnUsd', bad), /0 \(off\) or a cost in USD from 0.05 to 50/, bad);
  setAppConfig(file, full, 'orchestrator.compactAtTurnUsd', null);
  assert.equal(full.orchestrator.compactAtTurnUsd, undefined, 'null: back to the default ($1)');
});

test('app config: orchestrator.compactIdleSeconds and compactHardAtTokens (w1538), live, bounded, null back to the default', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true, compactAtTokens: 80_000 } } as unknown as Config;
  setAppConfig(file, full, 'orchestrator.compactIdleSeconds', '90');
  setAppConfig(file, full, 'orchestrator.compactHardAtTokens', 150_000);
  assert.deepEqual(full.orchestrator, { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true, compactAtTokens: 80_000, compactIdleSeconds: 90, compactHardAtTokens: 150_000 }, 'applies at once, the rest kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orchestrator, { compactIdleSeconds: 90, compactHardAtTokens: 150_000 });
  assert.deepEqual(autoCompactSettings(full), { atTokens: 80_000, atTurnUsd: 1, idleSeconds: 90, hardAtTokens: 150_000 }, 'the compactor reads them at its next check');
  setAppConfig(file, full, 'orchestrator.compactIdleSeconds', 0);
  assert.equal(full.orchestrator.compactIdleSeconds, 0, '0: compact at once');
  setAppConfig(file, full, 'orchestrator.compactHardAtTokens', 0);
  assert.equal(full.orchestrator.compactHardAtTokens, 0, '0: never a quiet wait');
  for (const bad of ['-1', '3601', '1.5', 'soon']) assert.throws(() => setAppConfig(file, full, 'orchestrator.compactIdleSeconds', bad), /0 \(compact at once\) or a whole number of seconds up to 3,600/, bad);
  for (const bad of ['49999', '900001', '1.5', 'lots']) assert.throws(() => setAppConfig(file, full, 'orchestrator.compactHardAtTokens', bad), /orchestrator.compactHardAtTokens is 0 \(off\) or a whole number of tokens from 50,000 to 900,000/, bad);
  setAppConfig(file, full, 'orchestrator.compactIdleSeconds', null);
  setAppConfig(file, full, 'orchestrator.compactHardAtTokens', null);
  assert.deepEqual(autoCompactSettings(full), { atTokens: 80_000, atTurnUsd: 1, idleSeconds: 120, hardAtTokens: 100_000 }, 'null: back to the defaults');
});

test('app config: the orchestrators’ loop guards (w571), live, 1 to 100', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true } } as unknown as Config;
  setAppConfig(file, full, 'orchestrator.messagesPerPerson', '20');
  setAppConfig(file, full, 'orchestrator.filingsPerMessage', 5);
  setAppConfig(file, full, 'orchestrator.followUpsPerMessage', 4);
  assert.deepEqual(full.orchestrator, { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true, messagesPerPerson: 20, filingsPerMessage: 5, followUpsPerMessage: 4 }, 'applies at once, the rest kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orchestrator, { messagesPerPerson: 20, filingsPerMessage: 5, followUpsPerMessage: 4 });
  for (const key of ['orchestrator.messagesPerPerson', 'orchestrator.filingsPerMessage', 'orchestrator.followUpsPerMessage'] as const)
    for (const bad of ['0', '101', '2.5', 'many']) assert.throws(() => setAppConfig(file, full, key, bad), /is a whole number from 1 to 100/, `${key} ${bad}`);
  setAppConfig(file, full, 'orchestrator.messagesPerPerson', null);
  assert.equal(full.orchestrator.messagesPerPerson, undefined, 'null: back to the default (10)');
});

test("app config: orchestrator.timerFilingsPerMessage (w1867), per person, live, 1 to 100, the owner's only; a person not named has the filings limit", (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, orchestrator: { model: 'opus', effort: 'medium', notifyOnWorkerEvents: true } } as unknown as Config;
  const users = ['ben', 'lothsahn'];
  assert.ok(OWNER_ONLY_KEYS.has('orchestrator.timerFilingsPerMessage'));
  assert.equal(timerFilings(full, 'lothsahn'), FILINGS_PER_MESSAGE, 'not set: the filings limit');
  setAppConfig(file, full, 'orchestrator.timerFilingsPerMessage', '{ "Lothsahn": 100 }', { users });
  assert.deepEqual(full.orchestrator.timerFilingsPerMessage, { lothsahn: 100 }, 'applies at once, the login in lower case');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orchestrator, { timerFilingsPerMessage: { lothsahn: 100 } });
  assert.deepEqual([timerFilings(full, 'lothsahn'), timerFilings(full, 'Lothsahn'), timerFilings(full, 'ben')], [100, 100, FILINGS_PER_MESSAGE]);
  setAppConfig(file, full, 'orchestrator.filingsPerMessage', 7);
  assert.equal(timerFilings(full, 'ben'), 7, 'Ben, not named, follows the filings limit');
  assert.throws(() => setAppConfig(file, full, 'orchestrator.timerFilingsPerMessage', { nobody: 5 }, { users }), /no login "nobody"; the logins are ben, lothsahn/);
  for (const bad of [0, 101, 2.5, 'many']) assert.throws(() => setAppConfig(file, full, 'orchestrator.timerFilingsPerMessage', { lothsahn: bad }, { users }), /orchestrator\.timerFilingsPerMessage\.lothsahn is a whole number from 1 to 100/, String(bad));
  assert.throws(() => setAppConfig(file, full, 'orchestrator.timerFilingsPerMessage', 100, { users }), /is an object/);
  setAppConfig(file, full, 'orchestrator.timerFilingsPerMessage', null, { users });
  assert.equal(full.orchestrator.timerFilingsPerMessage, undefined, 'null: removed');
  assert.equal(timerFilings(full, 'lothsahn'), 7);
});

test('app config: usagePollMinutes, live, 5 to 240 minutes, default 15', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg, usagePollMinutes: 15 } as unknown as Config;
  setAppConfig(file, full, 'usagePollMinutes', 30);
  assert.equal(full.usagePollMinutes, 30, 'applies at once');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).usagePollMinutes, 30);
  for (const bad of ['4', '241', '7.5', 'often']) assert.throws(() => setAppConfig(file, full, 'usagePollMinutes', bad), /5 to 240/, bad);
  setAppConfig(file, full, 'usagePollMinutes', null);
  assert.equal(full.usagePollMinutes, 15, 'null: back to the default');
});

test('app config: publicUrl (the portal address machines and the outside watchdog use)', (t) => {
  const { file, cfg } = setup(t);
  const full = { ...cfg } as unknown as Config;
  setAppConfig(file, full, 'publicUrl', 'https://beast.tailedfcad.ts.net/');
  assert.equal(full.publicUrl, 'https://beast.tailedfcad.ts.net', 'applies at once, without the trailing slash');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).publicUrl, 'https://beast.tailedfcad.ts.net');
  for (const bad of ['beast.tailedfcad.ts.net', 'https://beast.tailedfcad.ts.net/api', 'ftp://x']) assert.throws(() => setAppConfig(file, full, 'publicUrl', bad), /base URL/, bad);
});

test('checkReviewers: logins that exist, in their own spelling, deduplicated; the rest refused', () => {
  const users = ['Ben', 'lothsahn'];
  assert.deepEqual(checkReviewers(['ben', 'LOTHSAHN', 'Ben'], users), ['Ben', 'lothsahn']);
  assert.deepEqual(checkReviewers('ben, lothsahn', users), ['Ben', 'lothsahn']);
  assert.deepEqual(checkReviewers('["lothsahn"]', users), ['lothsahn']);
  assert.throws(() => checkReviewers(['ben', 'max'], users), /no login "max"; the logins are Ben, lothsahn/);
  assert.throws(() => checkReviewers([], users), /at least one/);
  assert.throws(() => checkReviewers(Array.from({ length: 21 }, () => 'ben'), users), /at most 20/);
  assert.throws(() => checkReviewers(['ben'], []), /no login "ben"; the logins are \(none\)/);
  assert.equal(normalizeSetting('intake.reviewers', null, undefined, users), undefined);
});

test('set_app_config: intake.reviewers is written under intake and applied live', (t) => {
  const { file, cfg } = setup(t);
  assert.deepEqual(setAppConfig(file, cfg, 'intake.reviewers', ['lothsahn'], { users: ['ben', 'lothsahn'] }), { before: undefined, after: ['lothsahn'] });
  assert.deepEqual(cfg.intake?.reviewers, ['lothsahn']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).intake, { reviewers: ['lothsahn'] });
  assert.throws(() => setAppConfig(file, cfg, 'intake.reviewers', ['ghost'], { users: ['ben'] }), /no login "ghost"/);
});

test('set_app_config: placement.prefer and placement.avoid (w428), live, cleared with null', (t) => {
  const { file, cfg } = setup(t);
  assert.deepEqual(setAppConfig(file, cfg, 'placement.prefer', 'lothdesktop, M5 ,m3,m5'), { before: undefined, after: ['lothdesktop', 'm5', 'm3'] });
  assert.deepEqual(cfg.placement?.prefer, ['lothdesktop', 'm5', 'm3']);
  assert.deepEqual(setAppConfig(file, cfg, 'placement.avoid', { BEAST: 'BEAST unstable, 2026-10-05' }).after, { beast: 'BEAST unstable, 2026-10-05' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).placement, { prefer: ['lothdesktop', 'm5', 'm3'], avoid: { beast: 'BEAST unstable, 2026-10-05' } });
  // w510: the portal holds no sandboxes, so "this host" ("host") is no place for work; name its daemon instead.
  for (const host of ['host', 'this host']) assert.throws(() => setAppConfig(file, cfg, 'placement.prefer', [host, 'lothdesktop']), /no place for work any more \(w510\)/, host);
  assert.throws(() => setAppConfig(file, cfg, 'placement.avoid', { 'this host': 'x' }), /no place for work/);
  assert.deepEqual(setAppConfig(file, cfg, 'placement.prefer', ['beast', 'lothdesktop']).after, ['beast', 'lothdesktop']);
  assert.throws(() => setAppConfig(file, cfg, 'placement.prefer', ['loth desktop']), /not a machine id/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.avoid', { beast: '' }), /say why/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.avoid', ['beast']), /is an object/);
  // Once BEAST is fixed: null clears, and the rest of the block stays.
  setAppConfig(file, cfg, 'placement.avoid', null);
  assert.deepEqual(cfg.placement, { prefer: ['beast', 'lothdesktop'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).placement, { prefer: ['beast', 'lothdesktop'] });
});

test('set_app_config: placement.live (w1600) is a list like placement.prefer; null clears it back to beast', (t) => {
  const { file, cfg } = setup(t);
  setAppConfig(file, cfg, 'placement.prefer', 'm5, lothdesktop');
  assert.deepEqual(setAppConfig(file, cfg, 'placement.live', 'BEAST, lothdesktop'), { before: undefined, after: ['beast', 'lothdesktop'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).placement, { prefer: ['m5', 'lothdesktop'], live: ['beast', 'lothdesktop'] });
  assert.throws(() => setAppConfig(file, cfg, 'placement.live', ['loth desktop']), /placement\.live: "loth desktop" is not a machine id/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.live', 5), /placement\.live is a list of computers/);
  setAppConfig(file, cfg, 'placement.live', null);
  assert.deepEqual(cfg.placement, { prefer: ['m5', 'lothdesktop'] });
});

test('set_app_config: placement.build (w1606) is a list like placement.live; null clears it back to beast', (t) => {
  const { file, cfg } = setup(t);
  assert.deepEqual(setAppConfig(file, cfg, 'placement.build', 'BEAST'), { before: undefined, after: ['beast'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).placement, { build: ['beast'] });
  assert.throws(() => setAppConfig(file, cfg, 'placement.build', 5), /placement\.build is a list of computers/);
  setAppConfig(file, cfg, 'placement.build', null);
  assert.deepEqual(cfg.placement, {});
});

test('set_app_config: machines.githubFromVault switches one machine alone, true and false still set them all (w737, w1078: it was claudeFromVault, now the GitHub one)', (t) => {
  const { file, cfg } = setup(t);
  const on = (id: string) => githubFromVault(cfg, id);
  const saved = () => JSON.parse(fs.readFileSync(file, 'utf8')).machines?.githubFromVault;
  // One machine: the others (BEAST, m3, m5, biscuit) stay off, and a machine nobody named is off.
  assert.deepEqual(setAppConfig(file, cfg, 'machines.githubFromVault', true, { machine: 'lothdesktop' }), { before: undefined, after: { lothdesktop: true } });
  assert.deepEqual(saved(), { lothdesktop: true });
  assert.deepEqual([on('lothdesktop'), on('beast'), on('m3'), on('m5'), on('biscuit')], [true, false, false, false, false]);
  // A second machine joins; the first stays.
  setAppConfig(file, cfg, 'machines.githubFromVault', true, { machine: 'm3' });
  assert.deepEqual(saved(), { lothdesktop: true, m3: true });
  // Taking one out leaves the other.
  setAppConfig(file, cfg, 'machines.githubFromVault', false, { machine: 'm3' });
  assert.deepEqual([on('lothdesktop'), on('m3')], [true, false]);
  // Without a machine the value is every machine not named (the "*" entry): the named one keeps its own.
  setAppConfig(file, cfg, 'machines.githubFromVault', false);
  assert.deepEqual(saved(), { lothdesktop: true, m3: false, '*': false });
  assert.deepEqual([on('lothdesktop'), on('m5')], [true, false]);
  // Starting from the plain global value, as before w737.
  const fresh = setup(t);
  setAppConfig(fresh.file, fresh.cfg, 'machines.githubFromVault', true);
  assert.equal(JSON.parse(fs.readFileSync(fresh.file, 'utf8')).machines.githubFromVault, true);
  assert.equal(githubFromVault(fresh.cfg, 'm5'), true);
  setAppConfig(fresh.file, fresh.cfg, 'machines.githubFromVault', false, { machine: 'beast' });
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh.file, 'utf8')).machines.githubFromVault, { '*': true, beast: false });
  // A value that is not true or false, and a machine id that is not one, are refused.
  assert.throws(() => setAppConfig(file, cfg, 'machines.githubFromVault', 'maybe', { machine: 'm5' }), /machines\.githubFromVault is true/);
  assert.throws(() => setAppConfig(file, cfg, 'machines.githubFromVault', true, { machine: 'loth desktop' }), /machine id/);
});

test('set_app_config (w1078): the Claude credential keys are gone, refused whatever the value, and the file is left alone', (t) => {
  const { file, cfg } = setup(t);
  const before = fs.readFileSync(file, 'utf8');
  for (const key of ['claudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'userClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN', 'claudeAccounts.orchestrator', 'claudeTokenFile', 'machines.useHostClaudeEnv', 'machines.claudeFromVault']) {
    assert.ok(!(SETTABLE_KEYS as readonly string[]).includes(key), key);
    assert.throws(() => setAppConfig(file, cfg, key as never, 'vault'), /cannot be changed by an agent/, key);
  }
  assert.ok(OWNER_ONLY_KEYS.has('claudeAccounts.dispatcher'));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is left alone');
});

test('set_app_config (w1078): providers.ffbox.token keeps only its hash, in a file of the secrets folder; config.json names the file and never holds the hash', (t) => {
  const { file, cfg } = setup(t);
  const secrets = path.join(path.dirname(file), 'secrets');
  const was = process.env.FFSB_SECRETS_DIR;
  process.env.FFSB_SECRETS_DIR = secrets;
  t.after(() => (was === undefined ? delete process.env.FFSB_SECRETS_DIR : (process.env.FFSB_SECRETS_DIR = was)));
  const token = `ffpv1_${'B'.repeat(39)}Q7q7`;
  const hash = tokenSha256(token);
  const hashFile = path.join(secrets, FFBOX_HASH_FILE);
  const r = setAppConfig(file, cfg, 'providers.ffbox.token', token);
  assert.deepEqual(r, { before: 'not set', after: `set (…${hash.slice(-4)})` });
  assert.equal(fs.readFileSync(hashFile, 'utf8').trim(), hash, 'the hash is in the secrets folder');
  if (process.platform !== 'win32') assert.equal(fs.statSync(hashFile).mode & 0o777, 0o600, 'its owner only');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  assert.equal(saved.providers.ffbox.tokenSha256File, hashFile, 'config.json names the file');
  assert.equal(saved.providers.ffbox.tokenSha256, undefined);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(hash) && !fs.readFileSync(file, 'utf8').includes(token), 'config.json holds neither');
  assert.equal(cfg.providers?.ffbox?.tokenSha256File, hashFile, 'live');
  assert.equal(cfg.providers?.ffbox?.tokenSha256, undefined);
  assert.equal(ffboxTokenHash(cfg), hash, 'the connector reads it from the file');
  // A new token replaces the file only: config.json already names it.
  const text = fs.readFileSync(file, 'utf8');
  const next = `ffpv1_${'C'.repeat(39)}Z9z9`;
  assert.deepEqual(setAppConfig(file, cfg, 'providers.ffbox.token', next), { before: `set (…${hash.slice(-4)})`, after: `set (…${tokenSha256(next).slice(-4)})` });
  assert.equal(fs.readFileSync(file, 'utf8'), text, 'config.json is not rewritten');
  assert.equal(ffboxTokenHash(cfg), tokenSha256(next));
  // null removes the file and the key.
  assert.deepEqual(setAppConfig(file, cfg, 'providers.ffbox.token', null), { before: `set (…${tokenSha256(next).slice(-4)})`, after: 'not set' });
  assert.ok(!fs.existsSync(hashFile));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).providers.ffbox.tokenSha256File, undefined);
  assert.equal(ffboxTokenHash(cfg), undefined);
});

test('set_app_config (w1078): an old inline providers.ffbox.tokenSha256 is read until the first write, which moves it into the file', (t) => {
  const { file, cfg } = setup(t);
  const secrets = path.join(path.dirname(file), 'secrets');
  const was = process.env.FFSB_SECRETS_DIR;
  process.env.FFSB_SECRETS_DIR = secrets;
  t.after(() => (was === undefined ? delete process.env.FFSB_SECRETS_DIR : (process.env.FFSB_SECRETS_DIR = was)));
  const old = tokenSha256(`ffpv1_${'D'.repeat(43)}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  fs.writeFileSync(file, JSON.stringify({ ...raw, providers: { ffbox: { enabled: true, tokenSha256: old } } }));
  cfg.providers = { ffbox: { enabled: true, tokenSha256: old } };
  assert.equal(ffboxTokenHash(cfg), old);
  const fresh = `ffpv1_${'E'.repeat(43)}`;
  assert.equal(setAppConfig(file, cfg, 'providers.ffbox.token', fresh).before, `set (…${old.slice(-4)})`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.providers.ffbox, { enabled: true, tokenSha256File: path.join(secrets, FFBOX_HASH_FILE) }, 'the inline hash is gone from config.json');
  assert.equal(ffboxTokenHash(cfg), tokenSha256(fresh));
});

test('set_app_config intake.nightly.run and .enabled (w864): checked, written, applied live; anyone may set them', (t) => {
  const { file, cfg } = setup(t);
  const users = ['ben', 'lothsahn'];
  setAppConfig(file, cfg, 'intake.nightly.run', { enabled: true, time: '03:00', tz: 'America/New_York', machine: 'lothdesktop', person: 'Lothsahn' }, { users });
  setAppConfig(file, cfg, 'intake.nightly.enabled', 'true', { users });
  assert.deepEqual(cfg.intake?.nightly, { enabled: true, run: { enabled: true, time: '03:00', tz: 'America/New_York', machine: 'lothdesktop', person: 'lothsahn' } });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  assert.deepEqual(raw.intake.nightly.run.person, 'lothsahn');
  assert.equal(raw.port, 8790, 'the rest kept');
  assert.throws(() => normalizeSetting('intake.nightly.run', { enabled: true, time: '3am' }, undefined, users), /HH:MM/);
  assert.throws(() => normalizeSetting('intake.nightly.run', { tz: 'Mars/Olympus' }, undefined, users), /IANA/);
  assert.throws(() => normalizeSetting('intake.nightly.run', { person: 'nobody' }, undefined, users), /is a login/);
  assert.throws(() => normalizeSetting('intake.nightly.run', { key: 'ffsb_x' }, undefined, users), /unknown key/);
  assert.throws(() => normalizeSetting('intake.nightly.enabled', 'yes'), /true or false/);
  assert.equal(OWNER_ONLY_KEYS.has('intake.nightly.run'), false);
});

test('toggleNightly (w903): the Intake tab chips flip the flag through set_app_config\'s path and keep the rest of the run block', (t) => {
  const { file, cfg } = setup(t);
  const users = ['ben', 'lothsahn'];
  const run = { enabled: true, time: '03:00', tz: 'America/New_York', machine: 'lothdesktop', person: 'lothsahn', reportWithinHours: 5 };
  setAppConfig(file, cfg, 'intake.nightly.run', run, { users });
  // The schedule off, then on again: only `enabled` moves, in the file and in the running config.
  assert.deepEqual(toggleNightly(file, cfg, 'run', false, users), { key: 'intake.nightly.run', before: true, after: false });
  assert.deepEqual(cfg.intake?.nightly?.run, { ...run, enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '')).intake.nightly.run, { ...run, enabled: false });
  assert.deepEqual(toggleNightly(file, cfg, 'run', true, users), { key: 'intake.nightly.run', before: false, after: true });
  assert.deepEqual(cfg.intake?.nightly?.run, run);
  // Filing the regressions, which leaves the run block alone.
  assert.deepEqual(toggleNightly(file, cfg, 'enabled', true, users), { key: 'intake.nightly.enabled', before: false, after: true });
  assert.deepEqual(toggleNightly(file, cfg, 'enabled', false, users), { key: 'intake.nightly.enabled', before: true, after: false });
  assert.deepEqual(cfg.intake?.nightly, { enabled: false, run });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '')).port, 8790, 'the rest of config.json kept');
  // No block yet: the schedule is switched on with the defaults (03:00 America/New_York on lothdesktop).
  const fresh = setup(t);
  assert.deepEqual(toggleNightly(fresh.file, fresh.cfg, 'run', true, users), { key: 'intake.nightly.run', before: false, after: true });
  assert.deepEqual(fresh.cfg.intake?.nightly?.run, { enabled: true });
  // Same checks as set_app_config: a login that no longer exists refuses the toggle, and nothing is written.
  const gone = fs.readFileSync(file, 'utf8');
  assert.throws(() => toggleNightly(file, cfg, 'run', false, ['ben']), /is a login/);
  assert.equal(fs.readFileSync(file, 'utf8'), gone);
  assert.throws(() => toggleNightly(file, cfg, 'run', 'yes' as never, users), /true or false/);
  assert.throws(() => toggleNightly(file, cfg, 'other' as never, true, users), /"enabled", "run" or "review"/);
});

test('intake.nightly.review (w905): settable by anyone, checked like the run\'s, toggled from the Intake tab keeping its block', (t) => {
  const { file, cfg } = setup(t);
  const users = ['ben', 'lothsahn'];
  setAppConfig(file, cfg, 'intake.nightly.review', { enabled: false, time: '06:00', tz: 'America/New_York', machine: 'lothdesktop', person: 'lothsahn' }, { users });
  assert.deepEqual(toggleNightly(file, cfg, 'review', true, users), { key: 'intake.nightly.review', before: false, after: true });
  assert.deepEqual(cfg.intake?.nightly?.review, { enabled: true, time: '06:00', tz: 'America/New_York', machine: 'lothdesktop', person: 'lothsahn' });
  assert.throws(() => normalizeSetting('intake.nightly.review', { reportWithinHours: 5 }, undefined, users), /intake\.nightly\.review: unknown key/);
  assert.throws(() => normalizeSetting('intake.nightly.review', { time: '6am' }, undefined, users), /intake\.nightly\.review\.time is HH:MM/);
  assert.equal(OWNER_ONLY_KEYS.has('intake.nightly.review'), false);
  assert.ok(SETTABLE_KEYS.includes('intake.nightly.review'));
});

test('masterBatch.enabled and .autoApprove (w1180): settable by anyone, checked, written, applied live, null back to the default', (t) => {
  const { file, cfg } = setup(t);
  assert.deepEqual(setAppConfig(file, cfg, 'masterBatch.enabled', 'false'), { before: undefined, after: false });
  assert.equal(cfg.masterBatch?.enabled, false, 'the watch reads it at its next look: no restart');
  setAppConfig(file, cfg, 'masterBatch.autoApprove', '{"enabled": true, "maxPerDay": 3}');
  assert.deepEqual(cfg.masterBatch, { enabled: false, autoApprove: { enabled: true, maxPerDay: 3 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).masterBatch, { enabled: false, autoApprove: { enabled: true, maxPerDay: 3 } });
  setAppConfig(file, cfg, 'masterBatch.enabled', null);
  assert.equal(cfg.masterBatch?.enabled, undefined, 'null is the default (on)');
  assert.throws(() => normalizeSetting('masterBatch.enabled', 'yes'), /true or false/);
  assert.throws(() => normalizeSetting('masterBatch.autoApprove', { maxPerDay: 101 }), /whole number from 0 to 100/);
  assert.throws(() => normalizeSetting('masterBatch.autoApprove', { enabled: 'yes' }), /enabled is true or false/);
  assert.throws(() => normalizeSetting('masterBatch.autoApprove', { repo: 'x/y' }), /unknown key/);
  assert.ok(!OWNER_ONLY_KEYS.has('masterBatch.enabled') && !OWNER_ONLY_KEYS.has('masterBatch.autoApprove'));
  assert.ok(SETTABLE_KEYS.includes('masterBatch.enabled') && SETTABLE_KEYS.includes('masterBatch.autoApprove'));
});

test('live.enabled (w1417): an owner turns the live view on and off; checked, written, applied live, null back to off', (t) => {
  const { file, cfg } = setup(t);
  assert.ok(SETTABLE_KEYS.includes('live.enabled'));
  assert.ok(OWNER_ONLY_KEYS.has('live.enabled'), 'it opens a new stream from the machines to the pages: the owner decides');
  assert.deepEqual(setAppConfig(file, cfg, 'live.enabled', true), { before: undefined, after: true });
  assert.equal(cfg.live?.enabled, true, 'the live view reads it at every use: no restart');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).live, { enabled: true });
  assert.deepEqual(setAppConfig(file, cfg, 'live.enabled', 'false'), { before: true, after: false });
  assert.equal(cfg.live?.enabled, false);
  setAppConfig(file, cfg, 'live.enabled', null);
  assert.equal(cfg.live?.enabled, undefined, 'null is the default (off)');
  assert.throws(() => normalizeSetting('live.enabled', 'yes'), /true or false/);
  assert.throws(() => normalizeSetting('live.enabled', 1), /true or false/);
});

test('set_app_config: placement.hold (w1089) keeps a computer off for everything, with who holds it and why; null releases it and leaves the rest', (t) => {
  const { file, cfg } = setup(t);
  setAppConfig(file, cfg, 'placement.avoid', { beast: 'BEAST unstable' });
  assert.deepEqual(setAppConfig(file, cfg, 'placement.hold', { M5: "Ben's testing, 2026-10-12" }).after, { m5: "Ben's testing, 2026-10-12" });
  assert.deepEqual(cfg.placement, { avoid: { beast: 'BEAST unstable' }, hold: { m5: "Ben's testing, 2026-10-12" } });
  assert.throws(() => setAppConfig(file, cfg, 'placement.hold', { m5: '' }), /placement\.hold\.m5: say who holds it and why/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.hold', ['m5']), /placement\.hold is an object/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.hold', { 'this host': 'x' }), /no place for work/);
  setAppConfig(file, cfg, 'placement.hold', null);
  assert.deepEqual(cfg.placement, { avoid: { beast: 'BEAST unstable' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).placement, { avoid: { beast: 'BEAST unstable' } });
});

// w1574, lothsahn: "We want it off on all of the workers currently ... However, I will be adding some new workers soon that
// will want that on."
test('set_app_config: machines.activityPause is off for every machine unless set, per machine, with its idle minutes (w1574)', (t) => {
  const { file, cfg } = setup(t);
  const of = (id: string) => machineActivityPause(cfg, id);
  assert.deepEqual([of('beast'), of('lothdesktop'), of('newpc')], [{ enabled: false, idleMinutes: 90 }, { enabled: false, idleMinutes: 90 }, { enabled: false, idleMinutes: 90 }], 'off and 90 min by default, a new machine included');
  setAppConfig(file, cfg, 'machines.activityPause.enabled', true, { machine: 'newpc' });
  setAppConfig(file, cfg, 'machines.activityPause.idleMinutes', 45, { machine: 'newpc' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).machines.activityPause, { enabled: { newpc: true }, idleMinutes: { newpc: 45 } });
  assert.deepEqual([of('newpc'), of('beast')], [{ enabled: true, idleMinutes: 45 }, { enabled: false, idleMinutes: 90 }], 'one machine on, the rest off');
  setAppConfig(file, cfg, 'machines.activityPause.enabled', false, { machine: 'newpc' });
  assert.equal(of('newpc').enabled, false);
  assert.equal(normalizeSetting('machines.activityPause.enabled', 'true'), true);
  assert.throws(() => setAppConfig(file, cfg, 'machines.activityPause.enabled', 'maybe', { machine: 'm5' }), /machines\.activityPause\.enabled is true/);
  assert.throws(() => setAppConfig(file, cfg, 'machines.activityPause.idleMinutes', 0, { machine: 'm5' }), /from 1 to 1440/);
});

test('autoDeploy.enabled (w1634): settable by anyone, checked, written, applied live, null back to the default (on)', (t) => {
  const { file, cfg } = setup(t);
  assert.deepEqual(setAppConfig(file, cfg, 'autoDeploy.enabled', 'false'), { before: undefined, after: false });
  assert.equal(cfg.autoDeploy?.enabled, false, 'the automatic deploy reads it at its next pass: no restart');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).autoDeploy, { enabled: false });
  setAppConfig(file, cfg, 'autoDeploy.enabled', null);
  assert.equal(cfg.autoDeploy?.enabled, undefined, 'null is the default (on)');
  assert.throws(() => normalizeSetting('autoDeploy.enabled', 'yes'), /true or false/);
  assert.ok(!OWNER_ONLY_KEYS.has('autoDeploy.enabled') && SETTABLE_KEYS.includes('autoDeploy.enabled'));
});

// w1643, lothsahn: "If normal (all work), if high, high and urgent, if urgent, urgent only".
test('set_app_config: placement.minPriority (w1643) sets each computer\'s lowest priority, drops normal (the default), refuses a bad id or level, and null clears it leaving the rest', (t) => {
  const { file, cfg } = setup(t);
  setAppConfig(file, cfg, 'placement.hold', { m5: 'Ben testing' });
  assert.deepEqual(setAppConfig(file, cfg, 'placement.minPriority', { BEAST: 'Urgent', lothdesktop: 'high', m3: 'normal' }).after, { beast: 'urgent', lothdesktop: 'high' });
  assert.deepEqual(cfg.placement, { hold: { m5: 'Ben testing' }, minPriority: { beast: 'urgent', lothdesktop: 'high' } });
  assert.throws(() => setAppConfig(file, cfg, 'placement.minPriority', { beast: 'low' }), /placement\.minPriority\.beast: "low" is not a level; one of normal, high, urgent/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.minPriority', { beast: 2 }), /is not a level/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.minPriority', 'urgent'), /placement\.minPriority is an object: computer id to the lowest priority/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.minPriority', { 'this host': 'high' }), /no place for work/);
  assert.deepEqual(cfg.placement.minPriority, { beast: 'urgent', lothdesktop: 'high' }, 'a refused value changes nothing');
  // Every computer back to normal is the same as clearing it.
  assert.equal(setAppConfig(file, cfg, 'placement.minPriority', { beast: 'normal' }).after, undefined);
  setAppConfig(file, cfg, 'placement.minPriority', { beast: 'high' });
  setAppConfig(file, cfg, 'placement.minPriority', null);
  assert.deepEqual(cfg.placement, { hold: { m5: 'Ben testing' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).placement, { hold: { m5: 'Ben testing' } });
});

test('set_app_config: placement.hold { why, except } (w1863) keeps the reason where every reader takes it and the exceptions beside it; a plain hold or null drops them', (t) => {
  const { file, cfg } = setup(t);
  const why = "lothsahn: w1785 timing runs, \"stop all work on LothDesktop except w1785 until it's done\"";
  assert.deepEqual(setAppConfig(file, cfg, 'placement.hold', { LothDesktop: { why, except: ['W1785'] }, m5: 'Ben testing' }).after, { lothdesktop: { why, except: ['w1785'] }, m5: 'Ben testing' });
  assert.deepEqual(cfg.placement, { hold: { lothdesktop: why, m5: 'Ben testing' }, holdExcept: { lothdesktop: ['w1785'] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).placement.holdExcept, { lothdesktop: ['w1785'] });
  assert.throws(() => setAppConfig(file, cfg, 'placement.hold', { lothdesktop: { why, except: ['PR 2268'] } }), /placement\.hold\.lothdesktop\.except: a list of request ids/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.hold', { lothdesktop: { why: '', except: ['w1785'] } }), /say who holds it and why/);
  assert.throws(() => setAppConfig(file, cfg, 'placement.hold', { lothdesktop: { why, until: 'tomorrow' } }), /only "why" and "except"/);
  setAppConfig(file, cfg, 'placement.hold', { lothdesktop: why });
  assert.deepEqual(cfg.placement, { hold: { lothdesktop: why } }, 'the whole hold is replaced, its exceptions too');
  setAppConfig(file, cfg, 'placement.hold', { lothdesktop: { why, except: 'w1785, w1820' } });
  assert.deepEqual(cfg.placement?.holdExcept, { lothdesktop: ['w1785', 'w1820'] });
  setAppConfig(file, cfg, 'placement.hold', null);
  assert.deepEqual(cfg.placement, {});
});
