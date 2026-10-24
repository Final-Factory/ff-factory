import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { LOG_RETENTION, listArchives, logStamp, maintainLogs, maintenanceLine } from '../machine/logRetention.ts';
import { supervisorScript } from './machineDeployWin.ts';

// w2038: two daemon restarts on beast (08:30Z, 11:10Z) erased its 08:15-08:30Z log; one daemon.log.prev was all it kept.

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fflogs-'));
const MB = 1024 * 1024;
const at = (iso: string) => new Date(iso);

/** What the Windows supervisor does before each start (its stamp format), in TypeScript. */
function supervisorRotate(dir: string, now: Date) {
  for (const f of ['daemon.log', 'daemon.err.log']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) fs.renameSync(p, `${p}.${logStamp(now)}`);
  }
}

test('logs: the stamp is the supervisor\'s yyyyMMdd\'T\'HHmmssfff\'Z\' in UTC', () => {
  assert.equal(logStamp(at('2026-10-24T08:15:00.123Z')), '20261024T081500123Z');
});

test('logs: thirty Windows restarts keep every run, gzip all but the newest, and the text survives', () => {
  const dir = tmpDir();
  let t = Date.parse('2026-10-24T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    supervisorRotate(dir, new Date(t));
    fs.writeFileSync(path.join(dir, 'daemon.log'), `run ${i}\n`);
    t += 20 * 60_000;
    maintainLogs(dir, { now: new Date(t), platform: 'win32' });
  }
  const a = listArchives(dir).filter((x) => x.base === 'daemon.log');
  assert.equal(a.length, 29, 'every closed run is kept (the 30th is still live)');
  assert.ok(a.slice(0, -1).every((x) => x.gz) && !a.at(-1)!.gz, 'older ones gzipped, the newest plain for a quick grep');
  assert.equal(gunzipSync(fs.readFileSync(path.join(dir, a[0].name))).toString(), 'run 0\n');
  assert.equal(fs.readFileSync(path.join(dir, a.at(-1)!.name), 'utf8'), 'run 28\n');
  assert.equal(fs.readFileSync(path.join(dir, 'daemon.log'), 'utf8'), 'run 29\n');
});

test('logs: a .prev an older supervisor left is adopted under its mtime, so the next restart overwrites nothing', () => {
  const dir = tmpDir();
  const prev = path.join(dir, 'daemon.log.prev');
  fs.writeFileSync(prev, 'old run\n');
  const mtime = at('2026-10-24T08:30:49Z');
  fs.utimesSync(prev, mtime, mtime);
  const m = maintainLogs(dir, { now: at('2026-10-24T11:10:00Z'), platform: 'win32' });
  assert.deepEqual(m.adopted, ['daemon.log.prev -> daemon.log.20261024T083049000Z']);
  assert.ok(!fs.existsSync(prev));
  fs.writeFileSync(prev, 'next run\n');
  maintainLogs(dir, { now: at('2026-10-24T12:00:00Z'), platform: 'win32' });
  const names = listArchives(dir).map((x) => x.name);
  assert.equal(names.length, 2, names.join(' '));
  assert.equal(gunzipSync(fs.readFileSync(path.join(dir, 'daemon.log.20261024T083049000Z.gz'))).toString(), 'old run\n');
});

test('logs: the total cap prunes the oldest first, live files counted', () => {
  const dir = tmpDir();
  const retention = { maxTotalBytes: 10 * MB, rollBytes: 100 * MB };
  // Random bytes do not compress, so each archive keeps its 1 MB after gzip.
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `daemon.log.${logStamp(new Date(Date.UTC(2026, 9, 24, i)))}`), randomBytes(MB));
  fs.writeFileSync(path.join(dir, 'daemon.log'), randomBytes(MB));
  const m = maintainLogs(dir, { now: at('2026-10-24T13:00:00Z'), platform: 'win32', retention });
  const left = listArchives(dir);
  assert.ok(m.totalBytes <= 10 * MB, `${m.totalBytes}`);
  assert.equal(left.length, 8, 'the live MB and 8 archives fit under 10 MB with gzip overhead');
  assert.deepEqual(m.removed.map((x) => x.name.slice(0, 30)), [0, 1, 2, 3].map((h) => `daemon.log.20261024T${String(h).padStart(2, '0')}0000000Z`));
  assert.ok(m.removed.every((x) => /over 10485760 bytes/.test(x.why)));
  assert.match(maintenanceLine(m)!, /^logs: gzipped 11; removed daemon\.log\.20261024T000000000Z/);
});

test('logs: archives past keepDays go only beyond the newest keepAtLeast', () => {
  const dir = tmpDir();
  const day = 86_400_000;
  const now = Date.parse('2026-10-24T12:00:00Z');
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `daemon.log.${logStamp(new Date(now - (30 - i) * day))}`), 'x');
  const m = maintainLogs(dir, { now: new Date(now), platform: 'win32' });
  // Ages 30..1 days, 16 of them over 14 days: only the oldest 10 go, as 20 (keepAtLeast) must stay.
  assert.equal(m.removed.length, 30 - LOG_RETENTION.keepAtLeast);
  assert.equal(listArchives(dir).length, LOG_RETENTION.keepAtLeast);
  assert.ok(m.removed.every((x) => /older than 14 days/.test(x.why)));
});

test('logs: on macOS and Linux a big appended daemon.log is copied out and truncated; on Windows it is left to the supervisor', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const dir = tmpDir();
    const live = path.join(dir, 'daemon.log');
    fs.writeFileSync(live, 'a'.repeat(2048));
    fs.writeFileSync(path.join(dir, 'supervisor.log'), 'b'.repeat(2048));
    const m = maintainLogs(dir, { now: at('2026-10-24T09:00:00Z'), platform, retention: { rollBytes: 1024 } });
    const rolled = platform === 'win32' ? ['supervisor.log.20261024T090000000Z'] : ['daemon.log.20261024T090000000Z', 'supervisor.log.20261024T090000000Z'];
    assert.deepEqual(m.rolled, rolled, platform);
    assert.equal(fs.statSync(live).size, platform === 'win32' ? 2048 : 0, platform);
    if (platform !== 'win32') {
      // An O_APPEND writer (launchd, systemd append:) goes on at the new end.
      fs.appendFileSync(live, 'after\n');
      assert.equal(fs.readFileSync(live, 'utf8'), 'after\n');
      assert.equal(fs.readFileSync(path.join(dir, rolled[0]), 'utf8'), 'a'.repeat(2048));
    }
  }
});

test('logs: only log names in the folder are touched, and a missing folder is no error', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  fs.writeFileSync(path.join(dir, 'daemon.json'), '{}');
  const m = maintainLogs(dir, { platform: 'win32', retention: { maxTotalBytes: 0 } });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['daemon.json', 'notes.txt']);
  assert.deepEqual(m.errors, []);
  assert.deepEqual(maintainLogs(path.join(dir, 'nope')).errors, []);
});

test('logs: the real supervisor block, run by PowerShell over many restarts, keeps every run', { skip: process.platform !== 'win32' && 'PowerShell runs the Windows supervisor' }, () => {
  const s = supervisorScript('C:\\nodejs\\node.exe', false);
  const block = /  # Each run's output is kept[\s\S]*?\n  \}\n(?=  \$started)/.exec(s)?.[0];
  assert.ok(block, 'the rotation block of supervisorScript');
  const dir = tmpDir();
  // The same second twice (a fast crash loop) must not overwrite either.
  const script = `$logs = $env:FFLOGS\n${block}`;
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dir, 'daemon.log'), `run ${i}\n`);
    fs.writeFileSync(path.join(dir, 'daemon.err.log'), i % 2 ? `err ${i}\n` : '');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FFLOGS: dir } });
  }
  const runs = listArchives(dir).filter((x) => x.base === 'daemon.log');
  assert.equal(runs.length, 6);
  assert.deepEqual(runs.map((x) => fs.readFileSync(path.join(dir, x.name), 'utf8')).sort(), [0, 1, 2, 3, 4, 5].map((i) => `run ${i}\n`));
  assert.equal(listArchives(dir).filter((x) => x.base === 'daemon.err.log').length, 3, 'empty err logs are not archived');
  maintainLogs(dir, { platform: 'win32' });
  assert.equal(listArchives(dir).filter((x) => x.base === 'daemon.log' && x.gz).length, 5);
});
