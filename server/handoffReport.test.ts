import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../shared/types.ts';
import { HANDOFF_REPORT_CHARS, handoffQuote, handoffReport, isHandoff } from './handoffReport.ts';

const item = (id: string, extra: Partial<WorkItem> = {}) => ({ id, ...extra }) as WorkItem;

test('w3105: a report is a hand-off for a timed leg, a pair run, a request another is Blocked on the report of (or was), or one with a For line; not otherwise', () => {
  const leg = item('w2', { timedLeg: { for: 'w1', forSession: 'a', from: 'pc', small: [] } });
  assert.equal(isHandoff(leg, 'done', []), true);
  const plain = item('w5');
  assert.equal(isHandoff(plain, 'Did it.\n\nw5: still open: more', []), false);
  assert.equal(isHandoff(plain, 'Numbers.\n\n**For w9:** the table', []), true);
  const waiter = item('w9', { blocked: { kind: 'request', ref: 'w5', on: 'report', what: 'w5 reporting', at: 'x', by: 'worker a' } as WorkItem['blocked'] });
  assert.equal(isHandoff(plain, 'Numbers.', [waiter]), true, 'blocked_on reports');
  assert.equal(isHandoff(plain, 'Numbers.', [item('w8', { waitedOn: ['W5'] })]), true, 'a gate that cleared');
});

test('w3105: the kept report is whole up to the cap; the resume quotes it whole, else its For section, else says where the rest is', () => {
  const big = `TL;DR: done.\n\n${'x'.repeat(30_000)}\n\nFor w1: the table`;
  const r = handoffReport('s1', '2026-11-04T10:00:00Z', big);
  assert.equal(r.text.length, HANDOFF_REPORT_CHARS);
  assert.equal(r.chars, big.length);
  const small = handoffReport('s1', 'now', 'TL;DR\n\nFor w1:\n| a | b |\n{"x":1}');
  assert.equal(handoffQuote(small, 'w2', 'w1'), small.text, 'whole when it fits');
  const longHead = handoffReport('s1', 'now', `${'head '.repeat(4000)}\nFor w1:\n{"x":1}\n{"y":2}`);
  assert.equal(handoffQuote(longHead, 'w2', 'w1'), '… For w1:\n{"x":1}\n{"y":2}', 'the For section whole when the report is too long');
  const cut = handoffQuote(r, 'w2', 'w1', 1000);
  assert.ok(cut.length <= 1000 && cut.includes('read_work w2'), cut.slice(-120));
});
