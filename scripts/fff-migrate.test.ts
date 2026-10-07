// fffctl migrate (scripts/fff-migrate.ts, w499) end to end against a synthetic BEAST: a fake ssh runs BEAST's side here
// (its PowerShell scripts under pwsh, its tar as tar), the VM's portal and BEAST's portal are the real server, and a real
// machine daemon is moved from one to the other at the cut-over. Linux only, with pwsh (GitHub's ubuntu runners have it);
// the option parsing runs everywhere. The synthetic BEAST and VM are in fff-migrate.world.ts; the cut-over and the copy
// tests are in fff-migrate-cutover, -rollback and -copy.test.ts, so node runs them beside this one (w636).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { asUserCommand, codecOrder, liveOut, parseArgs, tarVerbose } from './fff-migrate.ts';
import { claudeProjectFolder } from '../server/vmMigration.ts';
import { BEAST_TOKEN, FAKE_TOKEN, HAS_ZSTD, migration, skip, treeHash, world } from './fff-migrate.world.ts';

test('fffctl migrate: options, defaults and refusals', () => {
  const o = parseArgs(['--dry-run-copy']);
  assert.equal(o.mode, 'dry-run-copy');
  assert.deepEqual({ ssh: o.ssh, beastSshHost: o.beastSshHost, beastRoot: o.beastRoot, root: o.root, user: o.user, port: o.port }, { ssh: 'rydin@beast', beastSshHost: 'rydin@beast', beastRoot: 'C:/ff-sandboxes', root: '/srv/fff', user: 'fff', port: 8790 });
  assert.equal(parseArgs(['--cut-over', '--ssh', 'ben@beast2']).beastSshHost, 'ben@beast2', 'follows --ssh');
  assert.equal(parseArgs(['--cut-over', '--ssh', 'ben@beast2', '--beast-ssh-host', 'beast']).beastSshHost, 'beast');
  assert.equal(parseArgs(['--rollback-dry-run', '--keep-stage']).keepStage, true);
  assert.equal(parseArgs(['--dry-run-copy', '--no-resume-check']).resumeCheck, false);
  assert.equal(parseArgs(['--key', '--user', '']).user, undefined);
  assert.throws(() => parseArgs([]), /fffctl migrate --key/);
  assert.throws(() => parseArgs(['--dry-run-copy', '--cut-over']), /one mode at a time/);
  assert.throws(() => parseArgs(['--cut-over', '--ssh']), /--ssh needs a value/);
  assert.throws(() => parseArgs(['--cut-over', '--ssh', 'beast']), /--ssh is user@host/);
  assert.throws(() => parseArgs(['--cut-over', '--drain-minutes', 'x']), /drainMinutes/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option --bogus/);
});

test('fffctl migrate --dry-run-copy, again, then --rollback-dry-run: a read-only pull from BEAST, the copy checked as a dry run, and back', { skip, timeout: 300_000 }, async (t) => {
  const w = await world(t);
  await w.vmPortal.start();
  await w.vmPortal.healthy();
  const vmCfgBefore = fs.readFileSync(w.vmCfgFile, 'utf8');
  const beastBefore = treeHash(path.join(w.base, 'beast'));

  // The key is not authorized yet: the exact line to add, and nothing done.
  fs.writeFileSync(path.join(w.base, 'deny'), '');
  const denied = migration(w, 'dry-run-copy');
  await assert.rejects(denied.dryRunCopy(), (e: Error) => {
    assert.match(e.message, /cannot reach BEAST as rydin@beast/);
    assert.match(e.message, /administrators_authorized_keys/);
    assert.ok(e.message.includes('from="100.64.0.10",no-agent-forwarding,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTheMigrationTest fff-portal@fff'));
    return true;
  });
  assert.equal(fs.existsSync(path.join(w.vm, 'migrate', 'dry-run.json')), false);
  fs.rmSync(path.join(w.base, 'deny'));

  const m = migration(w, 'dry-run-copy');
  const code = await m.dryRunCopy();
  const report = m.report.join('\n');
  t.diagnostic(report);
  assert.equal(code, 0, report);
  for (const check of ['starts as a dry run', 'no data restored on load', "counts equal BEAST's copy", 'an orchestrator conversation resumes']) assert.match(report, new RegExp(`PASS  ${check.replace(/[()]/g, '\\$&')}`), check);
  assert.match(report, /copied BEAST's config\.json and data: \d+ files/);
  assert.match(report, /copied 1 conversation\(s\) to resume/);
  assert.match(report, /BEAST's config\.json and data: snapshot: a staged copy on BEAST, .*\(no VSS shadow copy: not Windows\); every file is read from it/);
  // zstd where this machine can unpack it (GitHub's runners can), else gzip, said so.
  if (HAS_ZSTD) {
    assert.match(report, /^compression: trying zstd level 3\.\.\.\ncompression: using zstd level 3$/m);
  } else {
    assert.match(report, /^compression: zstd level 3 failed, falling back to gzip\.\.\.$/m);
    assert.match(report, /^  compression check \(zstd\): no zstd here$/m, 'the reason is in the saved report');
    assert.match(report, /^compression: using gzip$/m);
  }
  assert.match(report, /copied [\d,]+ of [\d,]+ files, [\d.]+ MB of files in [\d.]+ MB over the wire \((zstd level 3|gzip), [\d.]+x\)/);
  assert.match(report, /beast: from the portal's own host to a machine reached over ssh \(rydin@beast\)/);

  // Read-only on BEAST: every file there as it was.
  assert.deepEqual(treeHash(path.join(w.base, 'beast')), beastBefore);
  const sshLog = fs.readFileSync(path.join(w.base, 'ssh.log'), 'utf8');
  assert.ok(!fs.existsSync(path.join(w.base, 'schtasks.log')), 'no task touched');
  assert.match(sshLog, /^rydin@beast powershell\.exe$/m);
  assert.match(sshLog, /^rydin@beast tar$/m);

  // What runs here now.
  const h = await w.vmPortal.healthy();
  assert.equal(h.dryRun, true);
  const cfg = JSON.parse(fs.readFileSync(w.vmCfgFile, 'utf8'));
  assert.equal(cfg.publicUrl, w.publicUrl);
  assert.equal(cfg.hostSandboxes, undefined, 'w510: no portal-only switch any more');
  assert.equal(cfg.ownerName, 'Ben');
  assert.equal(cfg.claudeEnv.CLAUDE_CODE_OAUTH_TOKEN, BEAST_TOKEN, 'copied (ignored by the dry run)');
  assert.deepEqual(cfg.claudeAccounts, { orchestrator: 'tokenfile', dispatcher: 'tokenfile' });
  assert.equal(cfg.dataDir, path.join(w.vm, 'data'));
  assert.equal((fs.statSync(w.vmCfgFile).mode & 0o777).toString(8), '600');
  // The data folder closed to others (the portal's own later writes inside it take its umask), the secrets and the
  // pulled copy its owner's only.
  for (const f of ['data', 'data/machine-tokens.json', 'migrate/stage', 'migrate/stage/beast/config.json']) assert.equal((fs.statSync(path.join(w.vm, f)).mode & 0o077).toString(8), '0', `${f} is its owner's only`);
  const state = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  const beast = state.machines.find((x: { id: string }) => x.id === 'beast');
  assert.deepEqual([beast.local, beast.host, beast.portalUrl], [undefined, 'rydin@beast', w.publicUrl]);
  assert.ok(fs.existsSync(path.join(w.vm, 'data', 'machine-tokens.json')));
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'tools')), 'no Windows tools');
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'supervisor.pid')));
  assert.equal(fs.readFileSync(path.join(w.vm, 'data', 'orchestrator-memory', 'dispatcher', 'MEMORY.md'), 'utf8'), '- remembered\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'outside-watch.json'), 'utf8')), { topic: 'ffsb-abcdefghijklmnop' }, "without BEAST's adapter");
  const moved = path.join(w.vm, 'home', '.claude', 'projects', claudeProjectFolder(w.vmBase));
  assert.equal(fs.readFileSync(path.join(moved, 'sdk-disp-1.jsonl'), 'utf8'), fs.readFileSync(path.join(w.beastClaude, 'projects', claudeProjectFolder(w.beastBase), 'sdk-disp-1.jsonl'), 'utf8'));
  assert.ok(fs.existsSync(path.join(moved, 'sdk-disp-1', 'subagents', 'a.jsonl')), 'its subagents too');
  assert.ok(!fs.existsSync(path.join(moved, 'someone-else.jsonl')), 'only the ones it resumes');
  assert.deepEqual(fs.readFileSync(path.join(w.base, 'claude.log'), 'utf8').trim().split('\n'), ['token from the environment', 'forked'], 'the token in its environment only, the copy forked, not written');
  assert.match(w.vmPortal.log(), /!!!!!!!! DRY RUN/);
  assert.doesNotMatch(w.vmPortal.log() + report, new RegExp(`${FAKE_TOKEN}|${BEAST_TOKEN}`), 'no token printed');

  // Again, after BEAST moved on: only what changed comes over.
  fs.appendFileSync(path.join(w.beastData, 'transcripts', 'w1.jsonl'), '{"seq":2,"kind":"system","text":"later"}\n');
  fs.rmSync(path.join(w.beastData, 'orchestrator-memory', 'dispatcher', 'MEMORY.md'));
  const again = migration(w, 'dry-run-copy');
  assert.equal(await again.dryRunCopy(), 0, again.report.join('\n'));
  const r2 = again.report.join('\n');
  assert.match(r2, /a dry run is in place already/);
  assert.match(r2, /this time 1 file\(s\), [\d.]+ MB over the wire, 1 removed/);
  assert.match(fs.readFileSync(path.join(w.vm, 'data', 'transcripts', 'w1.jsonl'), 'utf8'), /later/);
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'orchestrator-memory', 'dispatcher', 'MEMORY.md')));

  // Back: this VM's own portal as it was, the copy and its secrets gone.
  const back = migration(w, 'rollback-dry-run');
  assert.equal(await back.rollbackDryRun(), 0, back.report.join('\n'));
  assert.equal(fs.readFileSync(w.vmCfgFile, 'utf8'), vmCfgBefore);
  const after = JSON.parse(fs.readFileSync(path.join(w.vm, 'data', 'state.json'), 'utf8'));
  assert.ok(!(after.machines ?? []).some((x: { id: string }) => x.id === 'beast'), "BEAST's records are gone");
  assert.ok(!fs.existsSync(path.join(w.vm, 'data', 'machine-tokens.json')));
  assert.ok(!fs.existsSync(path.join(moved, 'sdk-disp-1.jsonl')));
  assert.ok(!fs.existsSync(path.join(moved, 'fork-1.jsonl')), "the check's fork too");
  assert.ok(!fs.existsSync(path.join(w.vm, 'migrate', 'stage')), 'the pulled copy wiped');
  assert.ok(!fs.existsSync(path.join(w.vm, 'migrate', 'dry-run.json')));
  assert.equal((await w.vmPortal.healthy()).dryRun, undefined, 'a normal start again');
  assert.equal(await migration(w, 'rollback-dry-run').rollbackDryRun(), 0, 'twice: nothing to do');
});

test('fffctl migrate (w508): Windows tar\'s -v read right, a file it stopped at included', () => {
  assert.deepEqual(tarVerbose('a ./config.json\na ./data/state.json\na ./data/server.out.logtar: (null)\n'), { named: ['config.json', 'data/state.json', 'data/server.out.log'], errors: ['tar: (null)'] });
  assert.deepEqual(tarVerbose("a ./x\ntar: Couldn't open ./data/locked.log: Permission denied\ntar: Error exit delayed from previous errors.\n"), { named: ['x'], errors: ["tar: Couldn't open ./data/locked.log: Permission denied", 'tar: Error exit delayed from previous errors.'] });
  assert.deepEqual(tarVerbose(''), { named: [], errors: [] });
  assert.deepEqual(parseArgs(['--dry-run-copy', '--snapshot', 'copy']).snapshot, 'copy');
  assert.equal(parseArgs(['--dry-run-copy']).snapshot, 'auto');
  assert.throws(() => parseArgs(['--dry-run-copy', '--snapshot', 'live']), /--snapshot is auto, vss or copy/);
});

test('fffctl migrate: as the portal\'s account through setpriv, which execs, so a kill reaches the program itself', { skip: process.getuid?.() !== 0 || spawnSync('setpriv', ['--version']).status !== 0 ? 'needs root and setpriv' : undefined }, async () => {
  assert.deepEqual(asUserCommand(undefined, 'ssh', ['-n', 'beast']), ['ssh', ['-n', 'beast']]);
  assert.deepEqual(asUserCommand('nobody', 'ssh', ['-n', 'beast']), ['setpriv', ['--reuid', 'nobody', '--regid', execFileSync('id', ['-g', 'nobody'], { encoding: 'utf8' }).trim(), '--init-groups', '--', 'ssh', '-n', 'beast']]);
  // runuser stayed as a parent: the stall limit's SIGKILL ended it and left ssh running, holding the pipes (the hang).
  const [c, a] = asUserCommand('nobody', 'sleep', ['300']);
  const child = spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fs.readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim(), 'sleep', 'the pid spawn() gave is the program, not a wrapper');
  const closed = new Promise((r) => child.on('close', r));
  child.kill('SIGKILL');
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('the pipes stayed open after the kill')), 5000))]);
});

test('fffctl migrate (w517): zstd level 3 first, then gzip, bzip2 and none; a named one goes first', () => {
  assert.deepEqual(codecOrder('auto').map((c) => c.name), ['zstd', 'gzip', 'bzip2', 'none']);
  assert.deepEqual(codecOrder('gzip').map((c) => c.name), ['gzip', 'zstd', 'bzip2', 'none']);
  assert.deepEqual(codecOrder('none').map((c) => c.name), ['none', 'zstd', 'gzip', 'bzip2']);
  assert.deepEqual(codecOrder('auto')[0].remote, ['--zstd', '--options', 'zstd:compression-level=3'], "BEAST's tar takes the level this way (measured: bsdtar 3.8.8 writes zstd frames)");
  assert.equal(parseArgs(['--dry-run-copy', '--compress', 'bzip2']).compress, 'bzip2');
  assert.throws(() => parseArgs(['--dry-run-copy', '--compress', 'xz']), /--compress is auto, zstd, gzip, bzip2 or none/);
});

test('fffctl migrate (w517): on a terminal the progress line is redrawn in place (\\r, ESC[K, no indent); in a log, a line at most every 30 s', () => {
  const tty = { isTTY: true, out: '', write(s: string) { this.out += s; return true; } };
  const o = liveOut(tty as unknown as NodeJS.WriteStream);
  o.live!('  data: 1/10 files');
  o.live!('  data: 5/10 files');
  o.out('data: copied 10 of 10 files');
  assert.equal(tty.out, '\r\x1b[Kdata: 1/10 files\r\x1b[Kdata: 5/10 files\r\x1b[Kdata: copied 10 of 10 files\n');
  assert.doesNotMatch(tty.out, /\x1b\[\d*[ABF]/, 'no cursor movement');
  let t = 0;
  const log = { isTTY: false, out: '', write(s: string) { this.out += s; return true; } };
  const l = liveOut(log as unknown as NodeJS.WriteStream, () => t);
  t = 30_000;
  l.live!('  data: 1/10 files');
  t = 35_000;
  l.live!('  data: 2/10 files');
  t = 61_000;
  l.live!('  data: 9/10 files');
  l.out('data: copied 10 of 10 files');
  assert.equal(log.out, 'data: 1/10 files\ndata: 9/10 files\ndata: copied 10 of 10 files\n');
});
