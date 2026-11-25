import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupLines, backupStatusLines } from './backupStatus.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const ok = { at: '2026-11-25T11:15:03Z', result: 'ok', why: 'sent and checked', verified: 'sha256', name: 'fff-fff-20261125T111503Z.tar.gz.age', size: 52_428_800, sha256: 'ab' };
const drill = { at: '2026-11-20T10:00:00Z', result: 'ok', source: 'newest', checks: ['unpacked 10 files'], problems: [] };

test('no files (not the portal VM): no lines', () => {
  assert.deepEqual(backupLines(undefined, undefined, NOW), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  assert.deepEqual(backupStatusLines(dir, NOW), []);
  fs.rmSync(dir, { recursive: true });
});

test('a checked backup and a recent drill', () => {
  assert.deepEqual(backupLines(ok, drill, NOW), [
    'Backup: ok at 2026-11-25T11:15:03Z (fff-fff-20261125T111503Z.tar.gz.age, 50 MB, upload checked by sha256).',
    'Restore drill: ok at 2026-11-20T10:00:00Z (newest).',
  ]);
});

test('a failed upload check is a PROBLEM with its reason', () => {
  const lines = backupLines({ ...ok, result: 'failed', why: 'upload check: the target holds 10 bytes for x, sent 20; removed the partial copy' }, drill, NOW);
  assert.match(lines[0], /^PROBLEM: the portal's last backup FAILED at .*: upload check: the target holds 10 bytes/);
});

test('a stale backup, a size-only check, a missing and an old drill', () => {
  assert.ok(backupLines({ ...ok, at: '2026-11-23T11:15:00Z' }, drill, NOW).some((l) => l.startsWith('WARNING: the portal\'s last backup record is from 2026-11-23')));
  assert.ok(backupLines({ ...ok, verified: 'size' }, drill, NOW).some((l) => l.includes('checked by size only')));
  assert.ok(backupLines(ok, undefined, NOW).includes('Restore drill: never run (monthly; docs/portal-on-ffbox-host.md, 2.2).'));
  assert.ok(backupLines(ok, { ...drill, at: '2026-10-01T00:00:00Z' }, NOW).includes('Restore drill: DUE (monthly; the last is over 31 days old).'));
});

test('a failed drill lists its problems; backups off says so and asks for no drill', () => {
  const lines = backupLines(ok, { ...drill, result: 'failed', problems: ['data/vault.json is not in the backup'] }, NOW);
  assert.ok(lines.includes('PROBLEM: the last restore drill FAILED at 2026-11-20T10:00:00Z (newest): data/vault.json is not in the backup.'));
  assert.deepEqual(backupLines({ at: '2026-11-25T11:15:00Z', result: 'off', why: 'BACKUP_SSH_TARGET is empty in /etc/fff/fff.conf' }, undefined, NOW), [
    'Backups: off (BACKUP_SSH_TARGET is empty in /etc/fff/fff.conf).',
  ]);
});

test('files on disk are read; a half-written one is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify(ok));
  fs.writeFileSync(path.join(dir, 'backup-drill.json'), '{"at": "2026-');
  const lines = backupStatusLines(dir, NOW);
  assert.equal(lines[0], 'Backup: ok at 2026-11-25T11:15:03Z (fff-fff-20261125T111503Z.tar.gz.age, 50 MB, upload checked by sha256).');
  assert.equal(lines[1], 'Restore drill: never run (monthly; docs/portal-on-ffbox-host.md, 2.2).');
  fs.rmSync(dir, { recursive: true });
});
