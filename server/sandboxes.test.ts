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
