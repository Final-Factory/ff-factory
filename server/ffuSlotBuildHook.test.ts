import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildsOutsideSlots, ffuSlotBuildHook, FFU_SLOT_BUILD_NOTE, FFU_SLOT_BUILD_NOTE_EVERY_MS } from './ffuSlotBuildHook.ts';

function root(t: { after: (f: () => void) => void }, slots?: object) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ffu-build-hook-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  if (slots) {
    fs.mkdirSync(path.join(r, 'ffu-sandboxes'));
    fs.writeFileSync(path.join(r, 'ffu-sandboxes', 'slots.json'), JSON.stringify(slots));
  }
  return r;
}
const call = (command: string, cwd = 'F:/ffw/tmp/ffa-1/ffu') =>
  ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's', transcript_path: '', tool_response: {}, tool_use_id: 'u' }) as never;
const note = (out: unknown) => (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
const signal = { signal: new AbortController().signal };

test('w5885: a cargo build outside the ffu slots is told apart from one in a slot, and from no build', () => {
  const slots = 'F:/ffw/ffu-sandboxes';
  assert.equal(buildsOutsideSlots('CARGO_TARGET_DIR="$TMPDIR/ffu-target" cargo test --workspace', 'F:/ffw/tmp/ffa-1/ffu', slots), true);
  assert.equal(buildsOutsideSlots('cd "$TMPDIR/ffu" && cargo +1.94.0 clippy --all-targets', undefined, slots), true);
  assert.equal(buildsOutsideSlots('cargo build', 'F:\\ffw\\ffu-sandboxes\\slot2\\ffu', slots), false, 'cwd in a slot');
  assert.equal(buildsOutsideSlots('cd F:/ffw/ffu-sandboxes/slot1/ffu && cargo test', 'F:/ffw/sandboxes/slot4', slots), false, 'cd into a slot');
  assert.equal(buildsOutsideSlots('eval "$(ffu-slot where)" && cargo test', 'F:/x', slots), false, 'the slot set up in the command');
  assert.equal(buildsOutsideSlots('git -C "$TMPDIR/ffu" merge origin/main', 'F:/x', slots), false, 'a light clone with no build');
  assert.equal(buildsOutsideSlots('cargo --version', 'F:/x', slots), false);
});

test('w5885: a worker holding no slot that builds ffu elsewhere is told to wait for one, once per stretch; a holder is not', async (t) => {
  const r = root(t, { slots: [{ id: 'slot1', holder: 'other', takenAt: 0 }] });
  let clock = 1_000_000;
  const h = ffuSlotBuildHook({ root: r, session: 'me', now: () => clock });
  const first = note(await h(call('CARGO_TARGET_DIR="$TMPDIR/ffu-target" cargo test'), undefined, signal));
  assert.equal(first, FFU_SLOT_BUILD_NOTE);
  assert.match(first!, /ffu-slot take --wait 9/);
  assert.match(first!, /never build ffu in your temp folder/);
  clock += 60_000;
  assert.equal(note(await h(call('cargo test'), undefined, signal)), undefined, 'not again at once');
  clock += FFU_SLOT_BUILD_NOTE_EVERY_MS;
  assert.equal(note(await h(call('cargo test'), undefined, signal)), FFU_SLOT_BUILD_NOTE, 'again after the interval');
  const holder = ffuSlotBuildHook({ root: r, session: 'other', now: () => clock });
  assert.equal(note(await holder(call('cargo test'), undefined, signal)), undefined, 'the slot holder builds where it likes; ffuTargetGuard covers a temp target');
});

test('w5885: a machine with no ffu-sandboxes folder (no ffu-slot) is left alone', async (t) => {
  const r = root(t);
  const h = ffuSlotBuildHook({ root: r, session: 'me' });
  assert.equal(note(await h(call('cargo test'), undefined, signal)), undefined);
});
