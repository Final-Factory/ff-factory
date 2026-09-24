import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isPublicEmail, offenders, parseLog } from './check-identity.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('public emails: GitHub noreply addresses only', () => {
  assert.equal(isPublicEmail('481770+someone@users.noreply.github.com'), true);
  assert.equal(isPublicEmail('someone@users.noreply.github.com'), true);
  assert.equal(isPublicEmail('noreply@github.com'), true);
  assert.equal(isPublicEmail('someone@gmail.com'), false);
  assert.equal(isPublicEmail('someone@users.noreply.github.com.evil.test'), false);
  assert.equal(isPublicEmail(''), false);
});

test('offenders: each bad commit once, naming the bad address', () => {
  const log = [
    ['a'.repeat(40), '1+x@users.noreply.github.com', 'noreply@github.com', 'Merge pull request #1'],
    ['b'.repeat(40), 'me@example.com', 'me@example.com', 'Oops'],
    ['c'.repeat(40), '1+x@users.noreply.github.com', 'ci@example.com', 'Committed elsewhere'],
  ]
    .map((f) => f.join('\x1f'))
    .join('\n');
  const commits = parseLog(log + '\n');
  assert.equal(commits.length, 3);
  assert.deepEqual(offenders(commits), ['bbbbbbbbb Oops: me@example.com', 'ccccccccc Committed elsewhere: ci@example.com']);
});

test('parseLog reads real git output', () => {
  const out = execFileSync('git', ['-C', ROOT, 'log', '-3', '--format=%H%x1f%ae%x1f%ce%x1f%s'], { encoding: 'utf8' });
  for (const c of parseLog(out)) {
    assert.match(c.sha, /^[0-9a-f]{40}$/);
    assert.match(c.author, /@/);
  }
});
