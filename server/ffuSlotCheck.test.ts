import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgeWithGit, planFolders, type CleanupFacts, type SlotContext } from './cleanupFolders.ts';
import { foldersMain } from '../machine/leftovers.ts';

/**
 * w4422: `ff-leftovers check` judges an ffu slot's build output as the daemon's rule ffu-slot-target judges it. On biscuit
 * (w4283) `check .../ffu-sandboxes/slot1/ffu/target` and `.../slot1/target/debug/incremental` both said KEEP, "not a place
 * with an owner in the ledger", though slot1 was released and nothing ran there; the 25 GB target inside the checkout
 * (ffu/target, from before the w4258 .cargo/config.toml routing) was never looked at by the daemon's sweep either.
 */
const TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n';
const HOUR = 3_600_000;

function world(t: { after: (fn: () => void) => void }, slots: { id: string; holder?: string }[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffw-w4422-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'ffu-sandboxes');
  const old = (Date.now() - 2 * HOUR) / 1000;
  const target = (dir: string, tag = true) => {
    fs.mkdirSync(path.join(dir, 'debug', 'incremental', 'ffu_sim-abc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'debug', 'incremental', 'ffu_sim-abc', 'query-cache.bin'), 'x'.repeat(100));
    if (tag) fs.writeFileSync(path.join(dir, 'CACHEDIR.TAG'), TAG);
    for (const p of [path.join(dir, 'debug', 'incremental', 'ffu_sim-abc', 'query-cache.bin'), path.join(dir, 'debug', 'incremental', 'ffu_sim-abc'), path.join(dir, 'debug', 'incremental'), path.join(dir, 'debug'), ...(tag ? [path.join(dir, 'CACHEDIR.TAG')] : []), dir]) fs.utimesSync(p, old, old);
  };
  for (const s of slots) {
    const slot = path.join(base, s.id);
    fs.mkdirSync(path.join(slot, 'ffu', 'src'), { recursive: true });
    fs.writeFileSync(path.join(slot, 'ffu', 'src', 'lib.rs'), 'fn main() {}');
    target(path.join(slot, 'target'));
  }
  fs.writeFileSync(path.join(base, 'slots.json'), JSON.stringify({ slots }));
  const facts: CleanupFacts = {
    at: new Date(Date.now() + 1000).toISOString(),
    connected: true,
    root,
    tempRoot: path.join(root, 'tmp'),
    sandboxes: [],
    live: ['a1a1a1a1'],
    resumable: [],
    owners: {},
    open: [],
    closed: [],
    contextAt: new Date().toISOString(),
  };
  const ctx = (procs: string[] = []): SlotContext => ({ host: 'test', alive: () => false, procs });
  return { root, base, facts, ctx, target };
}

test('w4422: a released, idle slot\'s target and its incremental cache are DELETE with the reason; a held slot is KEEP', async (t) => {
  const { base, facts, ctx } = world(t, [{ id: 'slot1' }, { id: 'slot2', holder: 'a1a1a1a1' }, { id: 'slot3', holder: 'deadbeef' }]);
  const at = (rel: string, procs?: string[]) => judgeWithGit(path.join(base, rel), facts, Date.now(), ctx(procs));

  const whole = await at('slot1/target');
  assert.equal(whole.verdict, 'delete');
  assert.equal(whole.kind, 'ffu-slot-target');
  assert.match(whole.why, /ffu slot1's cargo target, a slot released \(ffu-slot list\), no running process names the slot and nothing in it was written for 15 min/);
  const inc = await at('slot1/target/debug/incremental');
  assert.equal(inc.verdict, 'delete');
  assert.match(inc.why, /^inside ffu slot1's cargo target/);

  const held = await at('slot2/target/debug/incremental');
  assert.equal(held.verdict, 'keep');
  assert.match(held.why, /held by worker a1a1a1a1, which runs/);
  // A holder that neither runs nor has a request not closed holds nothing, as the daemon's holderUp judges it.
  const stale = await at('slot3/target');
  assert.equal(stale.verdict, 'delete');
  assert.match(stale.why, /held by worker deadbeef, which neither runs nor has a request not closed/);
  // Resumable or on an open request is held too.
  assert.equal((await judgeWithGit(path.join(base, 'slot3/target'), { ...facts, resumable: ['deadbeef'] }, Date.now(), ctx())).verdict, 'keep');
});

test('w4422: a busy slot is KEEP: a process names it, it was written within the settle time, or processes are unread', async (t) => {
  const { base, facts, ctx } = world(t, [{ id: 'slot1' }]);
  const target = path.join(base, 'slot1', 'target');
  const at = (c?: SlotContext) => judgeWithGit(target, facts, Date.now(), c);

  const test = await at(ctx([`${path.join(target, 'debug', 'deps', 'ffu_sim-0123')} --test-threads 4`]));
  assert.equal(test.verdict, 'keep');
  assert.match(test.why, /a running process names the slot/);
  const shell = await at(ctx([`bash -c cd ${path.join(base, 'slot1', 'ffu')} && cargo test`]));
  assert.equal(shell.verdict, 'keep', 'a build started in the checkout names the slot, not the target');
  assert.match((await at({ host: 'test', alive: () => false })).why, /running processes could not be read/);
  assert.equal((await at(undefined)).verdict, 'keep');

  fs.mkdirSync(path.join(target, 'debug', 'deps'));
  const fresh = await at(ctx());
  assert.equal(fresh.verdict, 'keep');
  assert.match(fresh.why, /within the 15 min settle time/);
});

test('w4422: a stray target/ inside a released slot\'s checkout goes only with cargo\'s CACHEDIR.TAG; nothing else in the checkout', async (t) => {
  const { base, facts, ctx, target } = world(t, [{ id: 'slot1' }, { id: 'slot2' }, { id: 'slot3', holder: 'a1a1a1a1' }]);
  target(path.join(base, 'slot1', 'ffu', 'target'));
  target(path.join(base, 'slot2', 'ffu', 'target'), false);
  target(path.join(base, 'slot3', 'ffu', 'target'));
  const at = (rel: string) => judgeWithGit(path.join(base, rel), facts, Date.now(), ctx());

  const stray = await at('slot1/ffu/target');
  assert.equal(stray.verdict, 'delete');
  assert.match(stray.why, /the cargo target left inside ffu slot1's checkout \(ffu\/target/);
  const untagged = await at('slot2/ffu/target');
  assert.equal(untagged.verdict, 'keep');
  assert.match(untagged.why, /no CACHEDIR\.TAG written by cargo: not provably build output/);
  assert.equal((await at('slot3/ffu/target')).verdict, 'keep', 'held');
  for (const rel of ['slot1/ffu', 'slot1/ffu/src', 'slot1', '', 'repo']) {
    const r = await at(rel);
    assert.equal(r.verdict, 'keep', rel);
  }
  // A forged tag (not cargo's signature) is not build output either.
  fs.writeFileSync(path.join(base, 'slot1', 'ffu', 'target', 'CACHEDIR.TAG'), 'Signature: 0000\n');
  assert.equal((await at('slot1/ffu/target')).verdict, 'keep');
});

test('w4422: `ff-leftovers folders` lists slot targets and stray checkout targets; `check` exits 0 on the two biscuit paths', async (t) => {
  const { root, base, facts, ctx, target } = world(t, [{ id: 'slot1' }, { id: 'slot2', holder: 'a1a1a1a1' }]);
  target(path.join(base, 'slot1', 'ffu', 'target'));
  const rows = (await planFolders(facts, { slots: ctx(), sizes: 'none' })).filter((r) => r.kind === 'ffu-slot-target');
  const verdicts = Object.fromEntries(rows.map((r) => [path.relative(base, r.path).replace(/\\/g, '/'), r.verdict]));
  assert.deepEqual(verdicts, { 'slot1/ffu/target': 'delete', 'slot1/target': 'delete', 'slot2/target': 'keep' });

  const file = path.join(root, 'cleanup-facts.json');
  fs.writeFileSync(file, JSON.stringify(facts));
  const out: string[] = [];
  const env = { FF_CLEANUP_FACTS: file } as NodeJS.ProcessEnv;
  const code = await foldersMain('check', [path.join(base, 'slot1', 'ffu', 'target'), path.join(base, 'slot1', 'target', 'debug', 'incremental')], env, Date.now(), (s) => void out.push(s), async () => ctx());
  assert.equal(code, 0, out.join(''));
  assert.doesNotMatch(out.join(''), /not a place with an owner/);
  assert.equal(await foldersMain('check', [path.join(base, 'slot2', 'target')], env, Date.now(), (s) => void out.push(s), async () => ctx()), 1);
});
