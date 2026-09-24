import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchProblem, commandLineHasPath, normalizePurpose, reservedSandboxIds, withBaseRepoLock } from './sandboxes.ts';

test('branch: master, main and develop are refused in every spelling', () => {
  for (const b of [
    'master',
    'main',
    'develop',
    'Develop',
    'MASTER',
    'refs/heads/develop',
    'refs/heads/Main',
    'heads/master',
    'origin/develop',
    'refs/remotes/origin/master',
    'remotes/origin/main',
    'HEAD',
  ]) {
    assert.ok(branchProblem(b), `${b} should be refused`);
  }
});

test('branch: own branches are allowed, leading dash and empty are refused', () => {
  for (const b of ['sandbox/sb1', 'feature/develop-tools', 'develop2', 'sandbox/master', 'main-menu-fix']) {
    assert.equal(branchProblem(b), undefined, `${b} should be allowed`);
  }
  assert.ok(branchProblem('-b'));
  assert.ok(branchProblem('--force'));
  assert.ok(branchProblem(''));
});

test('reserved ids: the live checkout, the base clone and _base/_seed', () => {
  const r = reservedSandboxIds(['C:/Users/dev/games/MyGame', 'D:\\Games\\Final Factory\\'], 'C:/ffsb/_base');
  assert.ok(r.has('mygame'));
  assert.ok(r.has('final factory'));
  assert.ok(r.has('final-factory'));
  assert.ok(r.has('_base'));
  assert.ok(r.has('_seed'));
  assert.ok(!r.has('sb1'));
  assert.ok(!r.has('ffsb'));
});

test('path match: whole path only, either slash, any case', () => {
  const dir = 'C:\\ffsb\\sb1';
  assert.ok(commandLineHasPath('"C:\\Program Files\\Unity.exe" -projectPath "C:\\ffsb\\sb1" -logFile x', dir));
  assert.ok(commandLineHasPath('Unity.exe -projectPath c:/ffsb/sb1 -logFile c:/ffsb/sb1/Logs/a.log', dir));
  assert.ok(commandLineHasPath('Unity.exe -projectPath C:/FFSB/SB1', dir));
  assert.ok(commandLineHasPath("Unity -projectPath 'c:/ffsb/sb1'", dir));
  assert.ok(commandLineHasPath('Unity -logFile C:\\ffsb\\sb1\\Logs\\x.log', dir));
  assert.ok(commandLineHasPath('Unity -projectPath C:/ffsb/sb1', 'C:/ffsb/sb1/'));
  assert.ok(!commandLineHasPath('Unity.exe -projectPath "C:\\ffsb\\sb10"', dir));
  assert.ok(!commandLineHasPath('Unity.exe -projectPath C:/ffsb/sb1-old', dir));
  assert.ok(!commandLineHasPath('Unity.exe -projectPath C:/ffsb/sb10 -logFile C:/ffsb/sb1x/a', dir));
  assert.ok(!commandLineHasPath('anything', ''));
});

test('purpose label: one line, whitespace collapsed, empty and over-long refused', () => {
  assert.equal(normalizePurpose('  unused '), 'unused');
  assert.equal(normalizePurpose('black hole\n  shader\tpass'), 'black hole shader pass');
  assert.throws(() => normalizePurpose(''));
  assert.throws(() => normalizePurpose(' \n\t '));
  assert.equal(normalizePurpose('x'.repeat(200)).length, 200);
  assert.throws(() => normalizePurpose('x'.repeat(201)));
});

test('base-repo lock runs one holder at a time, in order, and survives a throwing holder', async () => {
  const order: string[] = [];
  let inside = 0;
  const holder = (name: string, ms: number, fail = false) =>
    withBaseRepoLock(async () => {
      inside++;
      assert.equal(inside, 1);
      order.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-`);
      inside--;
      if (fail) throw new Error('boom');
      return name;
    });
  const results = await Promise.allSettled([holder('a', 20), holder('b', 5, true), holder('c', 1)]);
  assert.deepEqual(order, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  assert.equal(results[1].status, 'rejected');
  assert.deepEqual(results[2], { status: 'fulfilled', value: 'c' });
});

test('editor log: the previous run is kept; a log another process holds does not stop a start', { timeout: 60_000 }, async (t) => {
  const { pickEditorLog, pruneEditorLogs } = await import('./sandboxes.ts');
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const base = path.join(dir, 'sandbox-editor.log');
  // First start: no log yet.
  assert.equal(pickEditorLog(dir, new Date('2026-09-24T08:00:00Z')), base);
  fs.writeFileSync(base, 'run 1');
  // Next start: run 1 is kept under its time, the editor gets the usual name.
  assert.equal(pickEditorLog(dir, new Date('2026-09-24T09:00:00Z')), base);
  assert.equal(fs.readFileSync(path.join(dir, 'sandbox-editor-20260924T090000Z.log'), 'utf8'), 'run 1');
  if (process.platform === 'win32') {
    // A leftover process holds the log the way Unity opens it: read/write sharing, no delete sharing.
    fs.writeFileSync(base, 'run 2');
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$s = [IO.File]::Open('${base}', 'Open', 'ReadWrite', 'ReadWrite'); 'held'; Start-Sleep 30; $s.Close()`], { stdio: ['ignore', 'pipe', 'ignore'] });
    t.after(() => holder.kill());
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
    assert.throws(() => fs.rmSync(base), /EPERM|EBUSY/, 'the old start deleted the log and failed here');
    const fresh = pickEditorLog(dir, new Date('2026-09-24T10:00:00Z'));
    assert.equal(fresh, path.join(dir, 'sandbox-editor-20260924T100000Z.log'));
    assert.equal(fs.readFileSync(base, 'utf8'), 'run 2', 'the held log is left alone');
    // Let go of the file before the clean-up below and the temp folder's removal.
    if (holder.exitCode === null) await new Promise<void>((resolve) => (holder.once('exit', () => resolve()), holder.kill()));
  }
  // Clean-up keeps the newest three kept logs and never the current one.
  for (let h = 11; h <= 15; h++) {
    const p = path.join(dir, `sandbox-editor-20260924T${h}0000Z.log`);
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, new Date(Date.UTC(2026, 8, 24, h)), new Date(Date.UTC(2026, 8, 24, h)));
  }
  const current = path.join(dir, 'sandbox-editor-20260924T110000Z.log'); // the oldest, but in use
  pruneEditorLogs(dir, current);
  const left = fs.readdirSync(dir).filter((n) => n.startsWith('sandbox-editor-')).sort();
  // Newest by time: run 1's kept log (written just now), 15:00, 14:00; 13:00 and 12:00 go.
  assert.deepEqual(left, ['sandbox-editor-20260924T090000Z.log', 'sandbox-editor-20260924T110000Z.log', 'sandbox-editor-20260924T140000Z.log', 'sandbox-editor-20260924T150000Z.log']);
});
