import assert from 'node:assert/strict';
import test from 'node:test';
import { SOCKET_CONNECT_TIMEOUT_MS, SOCKET_MAX_BACKOFF_MS, socketBackoffMs, socketVerdict } from '../shared/socketPolicy.ts';

// The rules behind web/src/api.ts connectSocket (w5318): when the page's live socket gives up on an attempt.

test('w5318: an attempt still connecting past the timeout is replaced; one open and heard from is kept', () => {
  const base = { startedAt: 1_000, heard: 0, staleMs: 45_000 };
  assert.equal(socketVerdict({ ...base, state: 'connecting', now: 1_000 + SOCKET_CONNECT_TIMEOUT_MS - 1 }), 'keep');
  assert.equal(socketVerdict({ ...base, state: 'connecting', now: 1_000 + SOCKET_CONNECT_TIMEOUT_MS }), 'timeout');
  // lothsahn's page, 2026-11-23: an attempt through a failing Funnel hung for minutes; before w5318 it read 'keep' forever.
  assert.equal(socketVerdict({ ...base, state: 'connecting', now: 1_000 + 10 * 60_000 }), 'timeout');
  // An open socket is judged by what it last delivered, never by when it started.
  assert.equal(socketVerdict({ ...base, state: 'open', heard: 100_000, now: 100_000 + 44_999 }), 'keep');
  assert.equal(socketVerdict({ ...base, state: 'open', heard: 100_000, now: 100_000 + 45_000 }), 'stale');
  assert.equal(socketVerdict({ ...base, state: 'none', now: 10 * 60_000 }), 'keep');
});

test('w5318, w6336: the wait between attempts doubles from 0.5 s to at most 2 s, with a ±25% jitter', () => {
  assert.equal(socketBackoffMs(0, 0.5), 500);
  assert.equal(socketBackoffMs(1, 0.5), 1_000);
  assert.equal(socketBackoffMs(0, 0), 375);
  assert.equal(socketBackoffMs(50, 0.5), SOCKET_MAX_BACKOFF_MS);
  assert.ok(socketBackoffMs(1_000, 0.999) <= SOCKET_MAX_BACKOFF_MS * 1.25);
  // A hung attempt costs at most the timeout plus one wait: the page is never dark for minutes on one attempt.
  assert.ok(SOCKET_CONNECT_TIMEOUT_MS + SOCKET_MAX_BACKOFF_MS * 1.25 < 30_000);
  // w6336: a page comes back within 2.5 s of the portal after a restart, whenever in it the portal came back.
  assert.equal(SOCKET_MAX_BACKOFF_MS, 2_000);
  const waits = Array.from({ length: 40 }, (_, i) => socketBackoffMs(i, 0.999));
  assert.ok(Math.max(...waits) <= 2_500);
});
