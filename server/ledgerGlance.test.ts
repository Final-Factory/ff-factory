import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ledgerGlance, liveCounts, workLive, workLiveAll } from '../shared/workState.ts';
import type { Requester, SessionInfo, WorkItem } from '../shared/types.ts';

/**
 * w1089 (lothsahn, 2026-10-12): "Why does the dispatcher queued show 8 on the right side pane, but the left side pane says 34
 * active 6 queued?" The row counted each request's stored status; the page counts what it is doing now (workLive). Both now
 * count the one workLiveAll map through ledgerGlance, and the Queued reason names a held computer.
 */

const NOW = Date.parse('2026-10-12T05:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const LOTH: Requester = { userId: 'lothsahn', displayName: 'Lothsahn' };
const item = (id: string, o: Partial<WorkItem> = {}): WorkItem => ({ id, title: `Request ${id}`, brief: 'Do it.', priority: 'normal', keys: [], requestedBy: LOTH, requesters: [LOTH], humanAsked: true, status: 'active', createdAt: ago(48), updatedAt: ago(1), sessionIds: [], overlaps: [], asks: 0, log: [], ...o });
const session = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({ id, kind: 'worker', title: `worker ${id}`, status: 'idle', permissionMode: 'default', createdAt: ago(48), lastActivityAt: ago(2), turns: 3, costUsd: 1, pendingPermissions: [], ...o });

test('w1089: started requests whose worker message waits for a free agent slot are Queued in the glance, as on the page (w1059 and w1073)', () => {
  const sessions = [
    session('s1', { status: 'running' }),
    session('s2', { status: 'stopped', queuedSend: 'lothdesktop is at its agent cap', queuedOn: 'capacity' }),
    session('s3', { status: 'stopped', queuedSend: 'lothdesktop is at its agent cap', queuedOn: 'capacity' }),
  ];
  const work = [
    item('w1', { sessionIds: ['s1'] }),
    item('w1059', { sessionIds: ['s2'], status: 'active' }),
    item('w1073', { sessionIds: ['s3'], status: 'active' }),
    item('w1084', { status: 'queued', queuedFor: { at: ago(1) } }),
  ];
  const live = workLiveAll(work, { session: (id) => sessions.find((s) => s.id === id), room: [], now: NOW });
  // The old row: stored status. 3 active, 1 queued. The page: 2 queued by their messages, 1 queued, 1 working.
  assert.equal(work.filter((w) => w.status === 'active').length, 3);
  assert.deepEqual(liveCounts(live.values()).queued, 3);
  assert.deepEqual(ledgerGlance(live.values()), [[1, 'working'], [3, 'queued']]);
  // Whatever the mix, the glance's counts are the page's chip counts: one function.
  const n = liveCounts(live.values());
  for (const [count, word] of ledgerGlance(live.values())) assert.equal(count, n[word === 'to follow up' ? 'followup' : (word as keyof typeof n)], word);
  assert.deepEqual(ledgerGlance([]), []);
});

test('w1089: the sidebar row and the Dispatcher page both count the one workLiveAll map (no stored-status counts are left in the web code)', () => {
  const web = path.join(import.meta.dirname, '..', 'web', 'src');
  const util = fs.readFileSync(path.join(web, 'util.ts'), 'utf8');
  const sidebar = fs.readFileSync(path.join(web, 'components', 'Sidebar.tsx'), 'utf8');
  const panel = fs.readFileSync(path.join(web, 'components', 'DispatcherPanel.tsx'), 'utf8');
  assert.match(util, /export function dispatcherGlance\(dispatcher: SessionInfo \| undefined, work: WorkItem\[\], live: ReadonlyMap<string, WorkLive>/);
  assert.doesNotMatch(util.slice(util.indexOf('export function dispatcherGlance')), /count\('(active|queued|blocked|new)'\)|w\.status === st/, 'no count of stored status');
  for (const [name, src] of [['Sidebar', sidebar], ['DispatcherPanel', panel]] as const) {
    assert.match(src, /useWorkLive\(app, /, `${name} builds the live map`);
    assert.match(src, /dispatcherGlance\([^\n]*(useWorkLive\(app, |\blive\b)/, `${name} counts it`);
  }
});

test('w1089: a Queued reason names a computer with room that is held, and who holds it; an agent-slot request reads the agent room', () => {
  const w = item('w1086', { status: 'queued', queuedFor: { at: ago(1) } });
  const held = [{ id: 'm5', why: "Ben's testing", for: ['game', 'agent'] as ('game' | 'agent')[] }];
  const f = { items: [w], session: () => undefined, room: [], agentRoom: ['lothdesktop'], heldRoom: held, now: NOW };
  assert.equal(workLive(w, f)?.why, "queued for capacity: no computer that could take it has room; m5 has room but is held (Ben's testing)");
  assert.equal(workLive(w, f)?.roomOn, undefined, 'a held computer is not WRONG');
  // Needing only an agent slot, the same request sees LothDesktop's slot: WRONG.
  const non = { ...w, needs: 'agent' as const };
  const live = workLive(non, f);
  assert.deepEqual(live?.roomOn, ['lothdesktop']);
  assert.match(live!.why, /queued for capacity, but lothdesktop has an agent slot: the dispatcher should start it/);
  // `needs` limits both: held computers it cannot use are not named.
  const onlyLoth = { ...w, queuedFor: { at: ago(1), needs: ['lothdesktop'] } };
  assert.doesNotMatch(workLive(onlyLoth, f)!.why, /m5/);
});
