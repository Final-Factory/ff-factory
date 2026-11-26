import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '../shared/types.ts';
import { mergeSessions, SESSIONS_DELTA_MAX_GAP_MS, sessionsHave } from '../shared/pageSessions.ts';
import { keepsOnPage, PAGE_OMITTED_SESSION_FIELDS, PAGE_RESULT_KEEP_MS, PAGE_SANDBOX_RECENT, PAGE_SESSION_KEEP_MS, pageNamedSessions, pageSession, pageSessions, SessionRevs, sessionsPart, stateSizes } from './pageState.ts';
import { PageSockets } from './pageSockets.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-11-25T12:00:00Z');

function session(id: string, idleMs: number, extra: Partial<SessionInfo> = {}): SessionInfo {
  const at = new Date(NOW - idleMs).toISOString();
  return { id, kind: 'worker', title: id, status: 'stopped', permissionMode: 'bypassPermissions', createdAt: at, lastActivityAt: at, turns: 1, costUsd: 0, pendingPermissions: [], ...extra } as SessionInfo;
}

test('w5861: the page gets no field it never reads, and keeps those it does', () => {
  const s = session('a', 0, { sdkSessionId: 'x', ranOn: 'beast', savedWork: { sha: 'abc', files: 1, pushed: true, branch: 'b', at: 'now' }, wakeAt: 'soon' });
  const [p] = pageSessions([s], new Set(), NOW).sessions;
  for (const k of PAGE_OMITTED_SESSION_FIELDS) assert.equal(k in p, false, k);
  assert.equal(p.wakeAt, 'soon');
  assert.equal(p.title, 'a');
  // The server's own copy is untouched.
  assert.equal(s.sdkSessionId, 'x');
});

test('w5861: a last report goes only where a shown request or recent work may need it', () => {
  const old = PAGE_RESULT_KEEP_MS + 60_000;
  const sessions = [session('named', old, { lastResult: 'still open: x' }), session('recent', 1000, { lastResult: 'r' }), session('old', old, { lastResult: 'big report', lastResultAt: 'then' })];
  const out = sessions.map((x) => pageSession(x, pageNamedSessions({ work: [{ sessionIds: ['named'] }] }), NOW));
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

test('w5907: the page gets on open the sessions it shows, and leaves the old finished ones on the server', () => {
  const old = PAGE_SESSION_KEEP_MS + 60_000;
  const named = new Set(['named']);
  const keep = (s: SessionInfo) => keepsOnPage(s, named, NOW);
  assert.equal(keep(session('recent', 1000)), true);
  assert.equal(keep(session('named', old)), true, 'a shown request names it');
  assert.equal(keep(session('chat', old, { kind: 'orchestrator' })), true, 'the sidebar lists every chat');
  assert.equal(keep(session('live', old, { status: 'idle' })), true);
  assert.equal(keep(session('failed', old, { status: 'error' })), false);
  assert.equal(keep(session('asks', old, { pendingPermissions: [{ requestId: 'r' }] as never })), true);
  assert.equal(keep(session('wakes', old, { wakeAt: new Date(NOW + 60_000).toISOString() })), true);
  assert.equal(keep(session('holds', old, { heldSince: 'then' })), true, 'it still holds its sandbox (Fleet counts it)');
  assert.equal(keep(session('released', old, { heldSince: 'then', placeReleased: { why: 'x' } as never })), false);
  assert.equal(keep(session('old', old)), false);
  const { sessions, older } = pageSessions([session('recent', 1000), session('old', old), session('older', old * 2)], named, NOW);
  assert.deepEqual(sessions.map((s) => s.id), ['recent']);
  assert.equal(older, 2);
});

test("w5907: what the state names is kept: shown requests, the home chats, standing agents, live views, a sandbox's newest", () => {
  const sb = Array.from({ length: 40 }, (_, i) => `sb${i}`);
  const named = pageNamedSessions({
    work: [{ sessionIds: ['w1', 'w2'] }],
    ids: ['mine', undefined],
    standing: [{ sessionId: 'st' }],
    machines: [{ sandboxes: [{ sessionIds: sb } as never, { sessionIds: [] } as never] }, { sandboxes: undefined }],
    live: [{ sessionId: 'lv' }],
  });
  assert.deepEqual([...named].sort(), ['lv', 'mine', 'st', 'w1', 'w2', ...sb.slice(-PAGE_SANDBOX_RECENT)].sort());
  assert.equal(named.has('sb0'), false, "not a sandbox's whole history");
});

test('w5907: a session rev token is only taken from this run of the server and never ahead of it', () => {
  const r = new SessionRevs('boot1');
  assert.equal(r.token, 'boot1.0');
  r.note({ type: 'session', session: { id: 'a' } });
  r.note({ type: 'session', session: { id: 'b' } });
  assert.equal(r.token, 'boot1.2');
  assert.equal(r.since('boot1.1'), 1);
  assert.equal(r.since('boot1.2'), 2);
  assert.equal(r.since('boot1.3'), undefined, 'ahead');
  assert.equal(r.since('boot0.1'), undefined, 'another run');
  assert.equal(r.since('x'), undefined);
  assert.equal(r.since(null), undefined);
  assert.equal(r.changedSince('a', 0), true);
  assert.equal(r.changedSince('a', 1), false);
  assert.equal(r.changedSince('b', 1), true);
  assert.equal(r.changedSince('never', 0), false, 'unchanged since the server started');
  r.note({ type: 'session_removed', id: 'a' });
  assert.equal(r.token, 'boot1.3');
  r.note({ type: 'work' });
  assert.equal(r.token, 'boot1.3', 'other events do not count');
});

test('w5907: a reconnect gets only the changed sessions, and its merge equals the whole list', () => {
  const revs = new SessionRevs('b');
  const server = new Map<string, SessionInfo>();
  const put = (s: SessionInfo) => {
    server.set(s.id, s);
    revs.note({ type: 'session', session: s });
  };
  const named = new Set<string>();
  const part = (have?: string) => sessionsPart(pageSessions(server.values(), named, NOW).sessions, revs, revs.since(have));
  for (let i = 0; i < 50; i++) put(session(`s${i}`, 1000));
  put(session('gone', 1000));
  put(session('fetched-old', PAGE_SESSION_KEEP_MS * 2));
  // The page opens: the whole list, then fetches one older session for a view.
  const first = part();
  assert.equal(first.sessionsDelta, undefined);
  assert.equal(first.sessions.length, 51);
  const extra = new Set(['fetched-old']);
  let page = [...first.sessions, pageSession(server.get('fetched-old')!, extra, NOW)];
  // While it is away: one changes, one goes, one comes, one falls out of the window.
  put(session('s3', 10, { title: 'renamed' }));
  server.delete('gone');
  revs.note({ type: 'session_removed', id: 'gone' });
  put(session('new', 10));
  server.set('s4', session('s4', PAGE_SESSION_KEEP_MS * 2));
  const delta = part(first.sessionsRev);
  assert.deepEqual(delta.sessions.map((s) => s.id).sort(), ['new', 's3']);
  assert.equal(delta.sessionsDelta?.ids.length, 50);
  const merged = mergeSessions(page, delta, extra);
  assert.deepEqual(merged.missing, []);
  const whole = part();
  const byId = (l: SessionInfo[]) => Object.fromEntries(l.map((s) => [s.id, s]));
  assert.deepEqual(byId(merged.sessions), { ...byId(whole.sessions), 'fetched-old': page.at(-1) }, 'the delta lands where the whole list would, and the fetched one stays');
  assert.ok(JSON.stringify(delta).length * 5 < JSON.stringify(whole).length, 'and is much smaller');
  // A session the delta lists that the page has no copy of: the page fetches it.
  page = merged.sessions.filter((s) => s.id !== 's7');
  const again = mergeSessions(page, part(whole.sessionsRev), extra);
  assert.deepEqual(again.missing, ['s7']);
});

test("w5907: a whole list replaces the page's, keeping the older sessions views fetched", () => {
  const had = [session('a', 0), session('x', 0)];
  const out = mergeSessions(had, { sessions: [session('b', 0)] }, new Set(['x']));
  assert.deepEqual(out.sessions.map((s) => s.id), ['b', 'x']);
  assert.deepEqual(mergeSessions(undefined, { sessions: [session('b', 0)] }, new Set()).sessions.map((s) => s.id), ['b']);
});

test('w5907: a page sends its rev only after a short gap', () => {
  assert.equal(sessionsHave({ sessionsRev: 'b.4' }, 3000), 'b.4');
  assert.equal(sessionsHave({ sessionsRev: 'b.4' }, SESSIONS_DELTA_MAX_GAP_MS + 1), undefined);
  assert.equal(sessionsHave({}, 10), undefined, 'a server from before w5907');
  assert.equal(sessionsHave(undefined, 10), undefined);
});

test('w5907: the open line says how many sessions the state carried, and when only the changed ones', () => {
  const lines: string[] = [];
  const p = new PageSockets<object>((l) => lines.push(l), () => 0);
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {}, url: '/ws?why=closed&gap=2000&have=b.4' } as never;
  p.opened({}, 'ben', req, { ms: 5, bytes: 4096, sessions: 7, delta: true });
  p.opened({}, 'ben', req, { ms: 5, bytes: 4096, sessions: 900 });
  assert.equal(lines[0], 'page socket open: ben from 127.0.0.1 via local, why=closed gap=2s, state 5ms 4KB 7 sessions changed (1 open)');
  assert.equal(lines[1], 'page socket open: ben from 127.0.0.1 via local, why=closed gap=2s, state 5ms 4KB 900 sessions (2 open)');
});
