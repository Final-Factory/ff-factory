import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TITLE_MAX, jobTitle, titleDescription } from './jobTitle.ts';

test('jobTitle: "wNNN: <description>", one line, the id once, at most 80 characters', () => {
  assert.equal(jobTitle('w513', 'LothDesktop fresh install'), 'w513: LothDesktop fresh install');
  assert.equal(jobTitle('w513', '  LothDesktop\n fresh   install '), 'w513: LothDesktop fresh install');
  for (const d of ['w513: LothDesktop fresh install', '(w513) LothDesktop fresh install', 'w511 - LothDesktop fresh install']) assert.equal(jobTitle('w513', d), 'w513: LothDesktop fresh install', d);
  assert.throws(() => jobTitle('w513', '  '), /title: what the job is/);
  assert.throws(() => jobTitle('w513', 'w513:'), /title: what the job is/);
  assert.throws(() => jobTitle('w513', 'x'.repeat(80)), /keep "w513: <description>" to 80/);
  const clipped = jobTitle('w513', 'x'.repeat(200), { clip: true });
  assert.equal(clipped.length, TITLE_MAX);
  assert.ok(clipped.startsWith('w513: ') && clipped.endsWith('…'));
  assert.equal(titleDescription('w513: LothDesktop fresh install'), 'LothDesktop fresh install');
});
