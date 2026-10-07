// fffctl migrate, the copy (scripts/fff-migrate.ts, w508): broken streams, names tar cannot take, files that change.
// Linux only, with pwsh; the synthetic BEAST and VM are in fff-migrate.world.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BATCH_PS, MANIFEST_PS, MAX_STDIN_BYTES, Migration } from './fff-migrate.ts';
import { HAS_ZSTD, skip, world } from './fff-migrate.world.ts';

test('fffctl migrate, the copy (w508): a stream cut off is tried again; one that keeps breaking stops with BEAST\'s message and the next run goes on; what tar cannot send comes another way or is named', { skip, timeout: 300_000 }, async (t) => {
  const w = await world(t);
  const data = path.join(w.beastRoot, 'data');
  // Enough files for several streams of 3, a name tar on Windows cannot take, and one that cannot be opened.
  fs.mkdirSync(path.join(data, 'attachments'), { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(data, 'attachments', `a${i}.bin`), crypto.randomBytes(20_000 + i));
  const unicode = 'data/attachments/Björn ünïcode ☃.txt';
  fs.writeFileSync(path.join(w.beastRoot, unicode), 'a name outside the code page\n');
  fs.writeFileSync(path.join(w.base, 'tarskip'), `${unicode}\n`);
  const locked = path.join(data, 'locked.log');
  fs.writeFileSync(locked, 'open elsewhere\n');
  fs.chmodSync(locked, 0o000);
  t.after(() => fs.existsSync(locked) && fs.chmodSync(locked, 0o600));
  const vanish = path.join(data, 'attachments', 'a11.bin');
  const o = { ...w.opts, batchFiles: 3, progressSeconds: 1 };
  const stage = path.join(w.vm, 'migrate', 'stage', 'beast');
  const manifest = () => new Set((JSON.parse(fs.readFileSync(path.join(w.vm, 'migrate', 'stage', 'beast.manifest.json'), 'utf8')) as { path: string }[]).map((e) => e.path));
  const same = (rel: string) => assert.deepEqual(fs.readFileSync(path.join(stage, rel)), fs.readFileSync(path.join(w.beastRoot, rel)), rel);

  // 1. The first stream is cut off once: tried again, and everything comes; the file deleted after the listing is named.
  const m1 = new Migration(o, w.sys);
  const ps = m1.beast.ps.bind(m1.beast);
  m1.beast.ps = async (script: string, d?: string, ms?: number) => {
    if (script === BATCH_PS && d?.includes('"out":"0.list"')) fs.writeFileSync(path.join(w.base, 'truncate'), '1');
    const r = await ps(script, d, ms);
    // A file going after it was listed: from the snapshot it is read from.
    if (script === MANIFEST_PS && d?.includes('"beast"')) fs.rmSync(path.join(JSON.parse(d).root, 'data', 'attachments', 'a11.bin'), { force: true });
    return r;
  };
  const r1 = await m1.pull('beast', 'data', w.beastRoot, ['config.json', 'data']);
  await m1.dropSnapshots();
  const report1 = m1.report.join('\n');
  t.diagnostic(report1);
  assert.match(report1, /data: batch 1 of \d+ broke off: the archive stopped short \(ssh\/BEAST tar exit 255, unpacking tar exit 2\); BEAST: fake: client_loop: send disconnect: Broken pipe; here: tar: (Unexpected EOF in archive|Child returned status 1).*trying again \(2 of 3\)/, 'cut short: plain tar says so, or the decompressor does');
  assert.match(report1, /data: \d+ files, [\d.]+ MB on BEAST \(listed in [\d.]+ s\); to copy: \d+ files/);
  assert.match(report1, /data: copied \d+ of \d+ files, [\d.]+ MB of files in [\d.]+ MB over the wire \([^)]*\), in [\d.]+ s: [\d.]+ MB\/s of files, [\d.]+ MB\/s on the wire/);
  assert.deepEqual(r1.gone, ['data/attachments/a11.bin']);
  assert.match(report1, /data: snapshot: a staged copy on BEAST, [\d.]+ MB \(no VSS shadow copy: not Windows\); every file is read from it/);
  assert.match(report1, /1 file\(s\) could not be copied into the snapshot and are left out: .*locked\.log.*denied/i);
  assert.match(report1, /1 file\(s\) went on BEAST during the copy: data\/attachments\/a11\.bin/);
  same(unicode);
  for (let i = 0; i < 11; i++) same(`data/attachments/a${i}.bin`);
  const m = manifest();
  assert.ok(m.has(unicode), 'the name tar could not take came through PowerShell');
  assert.ok(!m.has('data/locked.log') && !m.has('data/attachments/a11.bin'), 'neither the unreadable nor the vanished file is trusted');
  // Progress lines went to the terminal (not the report) while it copied.
  assert.ok(w.sys.lines.some((l) => /^ {2}data: [\d,]+\/[\d,]+ files, [\d.]+ MB of [\d.]+ MB, [\d.]+ MB\/s/.test(l)), w.sys.lines.join('\n'));

  // 2. Every stream breaks: it stops after 3 attempts with BEAST's message; what was copied before stays trusted.
  fs.chmodSync(locked, 0o600);
  for (let i = 0; i < 6; i++) fs.appendFileSync(path.join(data, 'attachments', `a${i}.bin`), 'changed');
  fs.writeFileSync(path.join(w.base, 'truncate'), '99');
  const m2 = new Migration(o, w.sys);
  await assert.rejects(m2.pull('beast', 'data', w.beastRoot, ['config.json', 'data']), (e: Error) => {
    assert.match(e.message, /data: batch 1 of \d+ \(3 files\) failed 3 times: the archive stopped short .*BEAST: fake: client_loop: send disconnect: Broken pipe.*run the same command again to go on from there/);
    return true;
  });
  // A copy that stopped leaves its snapshot until dropped (pullAll and Ctrl+C drop it).
  await m2.dropSnapshots();
  const m2s = manifest();
  for (let i = 0; i < 6; i++) assert.ok(!m2s.has(`data/attachments/a${i}.bin`), 'a changed file not copied whole is not trusted');
  assert.ok(m2s.has('config.json') && m2s.has(unicode), 'the rest stays');

  // 3. The connection is good again: the next run copies what is left, and only that.
  fs.writeFileSync(path.join(w.base, 'truncate'), '0');
  const m3 = new Migration(o, w.sys);
  const r3 = await m3.pull('beast', 'data', w.beastRoot, ['config.json', 'data']);
  await m3.dropSnapshots();
  assert.equal(r3.fetched, 8, 'the six changed files, the one that can be read now, and the one that went from the first snapshot only');
  for (let i = 0; i < 6; i++) same(`data/attachments/a${i}.bin`);
  same('data/locked.log');
  assert.deepEqual(r3.locked, []);

  // 4b. A BEAST whose tar has no zstd: gzip instead, said so, and the copy is the same.
  fs.writeFileSync(path.join(w.base, 'nozstd'), '');
  fs.appendFileSync(path.join(data, 'attachments', 'a2.bin'), 'once more');
  const mz = new Migration(o, w.sys);
  const rz = await mz.pull('beast', 'data', w.beastRoot, ['config.json', 'data']);
  await mz.dropSnapshots();
  const rep = mz.report.join('\n');
  assert.match(rep, /^compression: zstd level 3 failed, falling back to gzip\.\.\.\ncompression: using gzip$/m);
  assert.match(rep, HAS_ZSTD ? /^  compression check \(zstd\): tar\.exe: Option --zstd is not supported$/m : /^  compression check \(zstd\): no zstd here$/m);
  assert.ok(!w.sys.lines.some((l) => /compression check|not supported|no zstd here/.test(l)), 'tar\'s reason stays off the terminal');
  assert.equal(rz.fetched, 1);
  same('data/attachments/a2.bin');
  fs.rmSync(path.join(w.base, 'nozstd'));

  // 5. A file Windows tar stops at ("tar: (null)": it changed while read): out of its stream, sent on its own, and the
  // stream goes on.
  fs.appendFileSync(path.join(data, 'attachments', 'a3.bin'), 'changed again');
  fs.appendFileSync(path.join(data, 'attachments', 'a4.bin'), 'changed again');
  fs.writeFileSync(path.join(w.base, 'tarnull'), 'data/attachments/a3.bin\n');
  const m5 = new Migration(o, w.sys);
  const r5 = await m5.pull('beast', 'data', w.beastRoot, ['config.json', 'data']);
  await m5.dropSnapshots();
  const report5 = m5.report.join('\n');
  assert.match(report5, /data: tar on BEAST stopped at data\/attachments\/a3\.bin \(tar: \(null\)\): it is taken out of batch 1 and sent on its own; the batch goes on/);
  assert.doesNotMatch(report5, /broke off/);
  assert.equal(r5.fetched, 2);
  same('data/attachments/a3.bin');
  same('data/attachments/a4.bin');
  fs.rmSync(path.join(w.base, 'tarnull'));
  // Nothing of the snapshots is left on BEAST: no staged copies, no lists.
  assert.deepEqual(fs.readdirSync(w.beastTmp).filter((n) => n.startsWith('fff-migrate-')), []);

  // 4. Nothing large ever goes to BEAST on stdin: refused here before ssh, as BEAST's sshd would never deliver it.
  await assert.rejects(m3.beast.ps('$FFData.Length', 'x'.repeat(MAX_STDIN_BYTES)), /never arrives through Windows OpenSSH/);
});
