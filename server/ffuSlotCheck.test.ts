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

test('w5240: a stopped holder with a request not closed keeps its target but its incremental cache is DELETE; a running holder keeps both', async (t) => {
  const { base, facts, ctx } = world(t, [{ id: 'slot1', holder: 'deadbeef' }, { id: 'slot2', holder: 'a1a1a1a1' }]);
  const f = { ...facts, resumable: ['deadbeef'] };
  const at = (rel: string, procs?: string[]) => judgeWithGit(path.join(base, rel), f, Date.now(), ctx(procs));
  assert.equal((await at('slot1/target')).verdict, 'keep');
  const inc = await at('slot1/target/debug/incremental');
  assert.equal(inc.verdict, 'delete');
  assert.match(inc.why, /worker deadbeef is stopped/);
  assert.equal((await at('slot1/target/debug/incremental/ffu_sim-abc')).verdict, 'delete');
  assert.equal((await at('slot1/target/debug/incremental', [`cargo test in ${path.join(base, 'slot1', 'ffu')}`])).verdict, 'keep');
  assert.equal((await at('slot2/target/debug/incremental')).verdict, 'keep');
  const rows = (await planFolders(f, { slots: ctx(), sizes: 'none' })).filter((r) => r.kind === 'ffu-slot-target');
  const v = Object.fromEntries(rows.map((r) => [path.relative(base, r.path).replace(/\\/g, '/'), r.verdict]));
  assert.deepEqual(v, { 'slot1/target': 'keep', 'slot1/target/debug/incremental': 'delete', 'slot2/target': 'keep' });
});

test('w5240: an idle sandbox\'s superseded Burst player builds are DELETE, the newest stay, the cache never whole; a worker, an open editor or a process keeps all', async (t) => {
  const { root, facts, ctx } = world(t, [{ id: 'slot9' }]);
  const sb = path.join(root, 'sandboxes', 'slot1');
  const dir = path.join(sb, 'Library', 'BurstCache', 'Windows-Intel');
  fs.mkdirSync(dir, { recursive: true });
  const hashes = ['a', 'b', 'c', 'd'].map((c) => c.repeat(32));
  hashes.forEach((h, i) => {
    for (const ext of ['dll', 'pdb']) {
      const f = path.join(dir, `${h}.${ext}`);
      fs.writeFileSync(f, 'x'.repeat(50));
      const when = (Date.now() - (10 - i) * 24 * HOUR) / 1000;
      fs.utimesSync(f, when, when);
    }
  });
  const f = { ...facts, sandboxes: [{ id: 'slot1', path: sb }] };
  const at = (rel: string, ff = f, procs?: string[]) => judgeWithGit(path.join(sb, rel), ff, Date.now(), ctx(procs));
  const old = await at(`Library/BurstCache/Windows-Intel/${hashes[0]}.dll`);
  assert.equal(old.kind, 'sandbox-library');
  assert.equal(old.verdict, 'delete', old.why);
  assert.equal((await at(`Library/BurstCache/Windows-Intel/${hashes[3]}.dll`)).verdict, 'keep');
  assert.equal((await at('Library/BurstCache')).verdict, 'keep');
  const rows = (await planFolders(f, { slots: ctx(), sizes: 'none' })).filter((r) => r.kind === 'sandbox-library');
  assert.ok(rows.length >= 2 && rows.every((r) => r.verdict === 'delete'));
  assert.ok(!rows.some((r) => r.path.includes(hashes[3]!)));
  assert.equal((await at(`Library/BurstCache/Windows-Intel/${hashes[0]}.dll`, f, [`bash in ${sb}`])).verdict, 'keep');
  assert.equal((await at(`Library/BurstCache/Windows-Intel/${hashes[0]}.dll`, { ...f, live: ['wk1'], owners: { wk1: { sandbox: 'slot1', requests: ['w1'] } } as never })).verdict, 'keep');
  fs.mkdirSync(path.join(sb, 'Temp'));
  fs.writeFileSync(path.join(sb, 'Temp', 'UnityLockfile'), '');
  assert.equal((await at(`Library/BurstCache/Windows-Intel/${hashes[0]}.dll`)).verdict, 'keep');
});

test('w5499: a stray ffu/target whose only CACHEDIR.TAG is in a folder an ffu script made (compat-base) goes; not without the checkout ignoring /target', async (t) => {
  const { base, facts, ctx, target } = world(t, [{ id: 'slot1' }, { id: 'slot2' }]);
  // LothDesktop's four slots: ffu/target/compat-base from tools/check_snapshot_compat.sh, no tag at ffu/target itself.
  for (const id of ['slot1', 'slot2']) target(path.join(base, id, 'ffu', 'target', 'compat-base'));
  fs.writeFileSync(path.join(base, 'slot1', 'ffu', '.gitignore'), '/target\n*.log\n');
  fs.writeFileSync(path.join(base, 'slot2', 'ffu', '.gitignore'), '*.log\n');
  const old = (Date.now() - 2 * HOUR) / 1000;
  for (const id of ['slot1', 'slot2']) fs.utimesSync(path.join(base, id, 'ffu', 'target'), old, old);
  const at = (rel: string) => judgeWithGit(path.join(base, rel), facts, Date.now(), ctx());
  const stray = await at('slot1/ffu/target');
  assert.equal(stray.verdict, 'delete', stray.why);
  assert.equal((await at('slot1/ffu/target/compat-base')).verdict, 'delete');
  const unignored = await at('slot2/ffu/target');
  assert.equal(unignored.verdict, 'keep');
  assert.match(unignored.why, /not provably build output/);
});

test('w5796: a stray ffu/target in a held slot is DELETE once nothing in it was written for ffuSlotKeepHours; recent or named by a process it is KEEP', async (t) => {
  const { base, facts, ctx, target } = world(t, [{ id: 'slot1', holder: 'a1a1a1a1' }, { id: 'slot2', holder: 'a1a1a1a1' }]);
  const age = (dir: string, h: number) => {
    const at = (Date.now() - h * HOUR) / 1000;
    const walk = (p: string) => {
      if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      fs.utimesSync(p, at, at);
    };
    walk(dir);
  };
  for (const id of ['slot1', 'slot2']) {
    target(path.join(base, id, 'ffu', 'target', 'compat-base'));
    fs.writeFileSync(path.join(base, id, 'ffu', '.gitignore'), '/target\n');
  }
  age(path.join(base, 'slot1', 'ffu', 'target'), 9 * 24);
  age(path.join(base, 'slot2', 'ffu', 'target'), 20);
  const at = (rel: string, procs: string[] = []) => judgeWithGit(path.join(base, rel), facts, Date.now(), ctx(procs));
  const idle = await at('slot1/ffu/target');
  assert.equal(idle.verdict, 'delete', idle.why);
  assert.equal((await at('slot2/ffu/target')).verdict, 'keep', 'written 20 h ago, inside 48 h');
  const named = await at('slot1/ffu/target', [`cargo build --target-dir ${path.join(base, 'slot1', 'ffu', 'target', 'compat-base')}`]);
  assert.equal(named.verdict, 'keep', named.why);
  assert.equal((await at('slot1/target')).verdict, 'keep', "the held slot's own target stays warm");
});
