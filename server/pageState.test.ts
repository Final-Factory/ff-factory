import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '../shared/types.ts';
import { PAGE_OMITTED_SESSION_FIELDS, PAGE_RESULT_KEEP_MS, pageSessions, stateSizes } from './pageState.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-11-25T12:00:00Z');

function session(id: string, idleMs: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  const at = new Date(NOW - idleMs).toISOString();
  return { id, kind: 'worker', title: id, status: 'stopped', permissionMode: 'bypassPermissions', createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, pendingPermissions: [], ...extra } as SessionInfo;
}

test('w5861: the page gets no field it never reads, and keeps those it does', () => {
  const s = session('a', 0, { sdkSessionId: 'x', ranOn: 'beast', savedWork: { sha: 'abc', files: 1, pushed: true, branch: 'b', at: 'now' }, wakeAt: 'soon' });
  const [p] = pageSessions([s], [], NOW);
  for (const k of PAGE_OMITTED_SESSION_FIELDS) assert.equal(k in p, false, k);
  assert.equal(p.wakeAt, 'soon');
  assert.equal(p.title, 'a');
  // The server's own copy is untouched.
  assert.equal(s.sdkSessionId, 'x');
});

test('w5861: a last report goes only where a shown request or recent work may need it', () => {
  const old = PAGE_RESULT_KEEP_MS + 60_000;
  const sessions = [session('named', old, { lastResult: 'still open: x' }), session('recent', 1000, { lastResult: 'r' }), session('old', old, { lastResult: 'big report', lastResultAt: 'then' })];
  const out = pageSessions(sessions, [{ sessionIds: ['named'] }], NOW);
  assert.equal(out[0].lastResult, 'still open: x');
  assert.equal(out[1].lastResult, 'r');
  assert.equal(out[2].lastResult, undefined);
  // When it reported stays: the worker cards sort by it (shared/workerCards.ts).
  assert.equal(out[2].lastResultAt, 'then');
});

/** web/src and every module of ours it imports, transitively (shared/*), except the type declarations. */
function pageSources(): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) queue.push(f);
    }
  };
  walk(path.join(ROOT, 'web/src'));
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      const p = path.resolve(path.dirname(f), m[1]);
      const hit = [p, `${p}.ts`, `${p}.tsx`, path.join(p, 'index.ts')].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (hit) queue.push(hit);
    }
  }
  return [...seen].filter((f) => !f.endsWith(path.join('shared', 'types.ts')));
}

test('w5861: no code the page runs reads a session field the page state leaves out', () => {
  const files = pageSources();
  assert.ok(files.some((f) => f.includes(`${path.sep}shared${path.sep}`)), 'the walk reaches shared/');
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const read = PAGE_OMITTED_SESSION_FIELDS.filter((k) => new RegExp(`\\b${k}\\b`).test(text));
  assert.deepEqual(read, [], `page code reads ${read.join(', ')}: take it off PAGE_OMITTED_SESSION_FIELDS (server/pageState.ts)`);
  // And lastResult, which it does read (shared/workState.ts), is never on that list.
  assert.equal((PAGE_OMITTED_SESSION_FIELDS as readonly string[]).includes('lastResult'), false);
});

test('w5861: stateSizes names the biggest parts and session fields', () => {
  const line = stateSizes({ sessions: [{ id: 'a', lastResult: 'x'.repeat(5000) }], me: { n: 1 } });
  assert.match(line, /^sessions 5KB, me 0KB; 1 sessions, by field: lastResult 5KB, id 0KB$/);
});
