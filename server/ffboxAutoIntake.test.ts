import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoIntakeSettings, describeAutoIntake } from './ffboxAutoIntake.ts';
import type { QueryAnswer } from './providers.ts';
import type { ProviderConversation } from '../shared/types.ts';

const NOW = Date.parse('2026-10-05T04:10:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

// FFBox's `config` answer as its fff_feed.config_view writes it: `effective` is ffwatch's merged config.
const config = (auto: Record<string, unknown> | undefined, live = true): QueryAnswer => ({
  what: 'config',
  live,
  ok: live,
  at: '2026-10-05T04:09:58Z',
  receivedAt: '2026-10-05T03:00:00Z',
  ...(live ? {} : { error: 'timeout' }),
  data: {
    file: {},
    effective: { intake: { crash_pool: 'ffdiagnose', desync_pool: 'ffdiagnose', ...(auto ? { auto } : {}), fff_handoff: { enabled: true, operator: 'lothsahn' } } },
    redacted: [],
  },
});
const ON = { enabled: true, by: 'lothsahn', settle_minutes: 5, max_per_day: 24 };

const reports = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}): QueryAnswer => ({ what: 'reports', live: true, ok: true, data: { reports: rows, offset: 0, ...extra } });
const conv = (id: string, min: number, o: Partial<ProviderConversation> = {}): ProviderConversation => ({
  id,
  source: 'intake',
  opener: 'operator',
  title: 'Crash',
  state: 'running',
  agentClass: 'ffdiagnose',
  createdAt: ago(min),
  updatedAt: ago(min),
  ...o,
});
const failed = (what: string): QueryAnswer => ({ what, live: false, ok: false, error: 'not_connected' });

test('ffboxAutoIntake: the settings come from FFBox\'s effective config; a missing block is unknown, not off', () => {
  assert.deepEqual(autoIntakeSettings(config(ON).data), {
    enabled: true,
    by: 'lothsahn',
    settleMinutes: 5,
    maxPerDay: 24,
    crashPool: 'ffdiagnose',
    desyncPool: 'ffdiagnose',
    handoff: { enabled: true, operator: 'lothsahn' },
  });
  assert.equal(autoIntakeSettings(config(undefined).data), undefined);
  assert.equal(autoIntakeSettings({ effective: { intake: { auto: { enabled: true, by: '<redacted>' } } } })?.by, undefined, 'a redacted value is not a name');
});

test('ffboxAutoIntake: ON names the settle time, the cap and the payer, and each report its conversation', () => {
  const lines = describeAutoIntake(
    config(ON),
    reports([
      { id: '20261005T040800Z-crash-aaaaaaaaaa', kind: 'crash', received_at: ago(2), game_version: '0.50.0.76', platform: 'OSXPlayer' },
      { id: '20261005T035612Z-crash-6102d405dc', kind: 'crash', received_at: ago(14), game_version: '0.50.0.76', platform: 'WindowsPlayer', conversation: 684 },
      { id: '20261005T030000Z-desync-bbbbbbbbbb', kind: 'desync', received_at: ago(70), game_version: '0.50.0.76', platform: 'WindowsPlayer', side: 'client' },
    ]),
    [conv('684', 8, { verdict: 'NEEDS-INFO', state: 'closed' }), conv('600', 60 * 30), conv('690', 1, { source: 'discord' })],
    NOW,
  );
  const text = lines.join('\n');
  assert.match(lines[0], /^Automatic diagnosis: ON, per FFBox's live config/);
  assert.match(lines[0], /about 5 min after it arrives \(intake\.auto, billed to lothsahn\)/);
  assert.match(lines[0], /at most 24 started or queued in any 24 h/);
  assert.match(lines[0], /\(intake\.fff_handoff\): on \(as lothsahn\)/);
  assert.match(lines[1], /^Intake conversations FFBox opened in the last 24 h: 1 \(1 closed; ids 684\)/, 'only intake conversations of the last 24 h');
  assert.match(text, /Reports received in the last 24 h: 3, 1 with a diagnosis conversation of their own/);
  assert.match(text, /6102d405dc crash 0\.50\.0\.76 WindowsPlayer: diagnosed in FFBox conversation 684 \(closed NEEDS-INFO\)/);
  assert.match(text, /aaaaaaaaaa crash .*: no conversation of its own yet \(received 2 min ago, still inside the settle time\)/);
  assert.match(text, /bbbbbbbbbb desync .* from the client: no conversation of its own yet \(received 70 min ago\)/);
  assert.doesNotMatch(text, /not built|phase 4|would start/);
});

test('ffboxAutoIntake: OFF says an operator must click; a failed query says unknown instead of asserting', () => {
  assert.match(describeAutoIntake(config({ ...ON, enabled: false }), reports([]), [], NOW)[0], /^Automatic diagnosis: OFF, per FFBox's live config .*clicks it on its \/intake page/);
  const unknown = describeAutoIntake(failed('config'), failed('reports'), [], NOW);
  assert.match(unknown[0], /^Automatic diagnosis: unknown here\. FFBox's config query failed \(not_connected\)/);
  assert.match(unknown[0], /before saying nothing will look at a report/);
  assert.match(unknown[2], /unknown here, FFBox's reports query failed \(not_connected\)/);
  assert.match(describeAutoIntake(config(undefined), reports([]), [], NOW)[0], /no intake\.auto block/);
  assert.match(describeAutoIntake(config(ON, false), reports([]), [], NOW)[0], /^Automatic diagnosis: ON, per FFBox's config as last known from 2026-10-05T03:00:00Z \(it could not answer now: timeout\)/);
});

test('ffboxAutoIntake: more reports than a page says so', () => {
  const text = describeAutoIntake(config(ON), reports([], { next_offset: 120 }), [], NOW).join('\n');
  assert.match(text, /: 0\+ \(more than one page/);
});
