// w4627: the timed tools' text must say the rule the code follows, by size class, never by naming a machine as big or small.
// TIMED_PLACE_TOOL called biscuit (4 agent slots, large by placement.ts sizeClass) a small computer that needs no ask, while
// timedAskMark (isSmallTimed: small or medium) made its bench lock ask (found by w4625's worker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TIMED_PLACE_TOOL, TIMED_RUN_TOOL } from './agents.ts';
import { sizeClass } from './placement.ts';
import { SMALL_TIMED_MAX_AGENTS, isSmallTimed } from './timedAsk.ts';

const MACHINES = ['beast', 'lothdesktop', 'lothlaptop', 'biscuit', 'm3', 'm5', 'ffbox'];
const SIZE = /\b(small|medium|large|xlarge|big|bigger|smaller|smallest)\b/i;

/** Each machine name in `text` with a size word within `span` characters of it: a hardcoded size the fleet can outgrow. */
function sizedNames(text: string, span = 80): string[] {
  const out: string[] = [];
  for (const id of MACHINES) {
    for (const m of text.matchAll(new RegExp(`\\b${id}\\b`, 'gi'))) {
      const near = text.slice(Math.max(0, m.index - span), m.index + id.length + span);
      if (SIZE.test(near)) out.push(`${id}: …${near}…`);
    }
  }
  return out;
}

// The agent-facing texts about timed work: the two tools, and every zod describe() of launch.ts (timed_run's params).
const describes = [...fs.readFileSync(new URL('./launch.ts', import.meta.url), 'utf8').matchAll(/\.describe\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]);
const TEXTS: Record<string, string> = { TIMED_PLACE_TOOL, TIMED_RUN_TOOL, ...Object.fromEntries(describes.map((d, i) => [`launch.ts describe #${i}`, d])) };

test('w4627: no timed tool text names a machine beside a size word', () => {
  assert.ok(describes.length > 5, 'launch.ts describe() texts found');
  for (const [name, text] of Object.entries(TEXTS)) assert.deepEqual(sizedNames(text), [], name);
});

test('w4627: the checker catches the old text (biscuit called small)', () => {
  assert.equal(sizedNames('a leg from a big computer (BEAST, LothDesktop) goes to a small one (LothLaptop, m3, biscuit; never m5)').length, 6);
  assert.deepEqual(sizedNames('"lothlaptop" for the G-SYNC/VRR screen'), []);
});

test('w4627: timed_place states the size classes sizeClass uses, and that small and medium need no ask', () => {
  assert.match(TIMED_PLACE_TOOL, /small 1 agent slot, medium 2-3, large 4-6, xlarge 7\+/);
  assert.deepEqual([1, 2, 3, 4, 6, 7, 10].map(sizeClass), ['small', 'medium', 'medium', 'large', 'large', 'xlarge', 'xlarge']);
  assert.match(TIMED_PLACE_TOOL, /a small or medium one needs no ask/);
  assert.equal(isSmallTimed({ maxAgents: 3 }), true);
  assert.equal(isSmallTimed({ maxAgents: 4 }), false);
  assert.match(TIMED_PLACE_TOOL, /On a large or xlarge computer the harness refuses/);
});

test('w4627: timed_run states its own limit, SMALL_TIMED_MAX_AGENTS', () => {
  assert.match(TIMED_RUN_TOOL, new RegExp(`at most ${SMALL_TIMED_MAX_AGENTS} agent slots`));
  for (const d of describes.filter((x) => /takes timed runs, by id/.test(x))) assert.match(d, new RegExp(`at most ${SMALL_TIMED_MAX_AGENTS} agent slots`));
});
