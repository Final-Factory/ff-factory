import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ALLOW_FILE, allowProblems, evaluate, gatedAdvisories, type AllowEntry } from './audit-gate.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const TODAY = new Date('2026-11-24T12:00:00Z');

// The shape of web/'s `npm audit --omit=dev --json` on 2026-11-24 (w5519), cut down: lodash-es carries one high and
// one moderate advisory, chevrotain is high only through it, dompurify's advisories are low.
const REPORT = {
  vulnerabilities: {
    chevrotain: { severity: 'high', via: ['lodash-es'] },
    dompurify: {
      severity: 'low',
      via: [{ name: 'dompurify', title: 'IN_PLACE hook', url: 'https://github.com/advisories/GHSA-mrv2-3pqr-j5jr', severity: 'low' }],
    },
    'lodash-es': {
      severity: 'high',
      via: [
        { name: 'lodash-es', title: 'Code Injection via _.template', url: 'https://github.com/advisories/GHSA-r5fr-rjxr-66jc', severity: 'high' },
        { name: 'lodash-es', title: 'prototype pollution', url: 'https://github.com/advisories/GHSA-f23m-r3pf-42rh', severity: 'moderate' },
      ],
    },
  },
};

const entry = (over: Partial<AllowEntry> = {}): AllowEntry => ({
  advisory: 'GHSA-r5fr-rjxr-66jc',
  package: 'lodash-es',
  project: 'web',
  reason: 'No fixed version reachable through mermaid yet; _.template is not called.',
  request: 'w5519',
  until: '2026-12-20',
  ...over,
});

test('only high and critical advisories are gated, each once, by their own severity', () => {
  const a = gatedAdvisories('web', REPORT);
  assert.deepEqual(
    a.map((x) => `${x.package} ${x.id} ${x.severity}`),
    ['lodash-es GHSA-r5fr-rjxr-66jc high'],
  );
});

test('a failed npm audit (no network, no lockfile) fails the gate, never passes it', () => {
  assert.throws(() => gatedAdvisories('.', { error: { code: 'ENOLOCK', summary: 'no lockfile' } }), /ENOLOCK/);
});

test('an unlisted high advisory fails; a matching entry allows exactly it', () => {
  const advisories = gatedAdvisories('web', REPORT);
  assert.equal(evaluate(advisories, [], TODAY).failures.length, 1);
  const ok = evaluate(advisories, [entry()], TODAY);
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.allowed.length, 1);
});

test('an entry is narrow: another project, package or advisory does not match', () => {
  const advisories = gatedAdvisories('web', REPORT);
  for (const over of [{ project: '.' }, { package: 'lodash' }, { advisory: 'GHSA-f23m-r3pf-42rh' }]) {
    const { failures } = evaluate(advisories, [entry(over)], TODAY);
    assert.ok(failures.some((f) => f.includes('GHSA-r5fr-rjxr-66jc') && f.startsWith('web:')), JSON.stringify(over));
    assert.ok(failures.some((f) => f.includes('matches nothing')), JSON.stringify(over));
  }
});

test('an entry needs a reason, a request and an until date at most 90 days away, and expires', () => {
  assert.deepEqual(allowProblems([entry()], TODAY), []);
  assert.match(allowProblems([entry({ reason: 'no fix' })], TODAY).join(), /reason/);
  assert.match(allowProblems([entry({ request: '' })], TODAY).join(), /request/);
  assert.match(allowProblems([entry({ until: '2026-11-23' })], TODAY).join(), /expired/);
  assert.deepEqual(allowProblems([entry({ until: '2026-11-24' })], TODAY), []);
  assert.match(allowProblems([entry({ until: '2027-03-01' })], TODAY).join(), /90 days/);
  assert.match(allowProblems([entry({ advisory: 'GHSA-*' })], TODAY).join(), /GHSA id/);
  assert.match(allowProblems([entry({ project: 'server' })], TODAY).join(), /project/);
});

test('the allowlist in the repo is well formed', () => {
  const file = JSON.parse(readFileSync(path.join(ROOT, ALLOW_FILE), 'utf8'));
  assert.ok(Array.isArray(file.allow));
  assert.deepEqual(allowProblems(file.allow, new Date()), []);
});
